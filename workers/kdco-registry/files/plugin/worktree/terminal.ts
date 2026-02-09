/**
 * Terminal Module for Worktree Plugin
 *
 * Provides mutex-protected tmux operations and cross-platform terminal spawning.
 * Serializes tmux commands to prevent socket races since tmux server is single-threaded.
 *
 * This module is extracted from worktree.ts to provide a focused, testable
 * interface for terminal operations with proper concurrency control.
 */

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { z } from "zod"
import type { OpencodeClient } from "../kdco-primitives"
import {
	escapeAppleScript,
	escapeBash,
	escapeBatch,
	getTempDir,
	isInsideTmux,
	logWarn,
	Mutex,
} from "../kdco-primitives"

// =============================================================================
// TEMP SCRIPT HELPER
// =============================================================================

/**
 * Execute a function with a temporary script file that is guaranteed to be cleaned up.
 * Uses try-finally pattern to ensure cleanup even on errors.
 *
 * @param scriptContent - Content to write to the temp script
 * @param fn - Function to execute with the script path
 * @param extension - File extension for the script (default: ".sh")
 * @returns Result of the function execution
 */
export async function withTempScript<T>(
	scriptContent: string,
	fn: (scriptPath: string) => Promise<T>,
	extension: string = ".sh",
	client?: OpencodeClient,
): Promise<T> {
	const scriptPath = path.join(
		getTempDir(),
		`worktree-${Date.now()}-${Math.random().toString(36).slice(2)}${extension}`,
	)
	await Bun.write(scriptPath, scriptContent)
	await fs.chmod(scriptPath, 0o755)

	try {
		return await fn(scriptPath)
	} finally {
		try {
			if (await Bun.file(scriptPath).exists()) {
				await fs.rm(scriptPath)
			}
		} catch (cleanupError) {
			// Log but don't throw - cleanup is best-effort
			logWarn(client, "worktree", `Failed to cleanup temp script: ${scriptPath}: ${cleanupError}`)
		}
	}
}

/**
 * Wrap a bash script with trap-based self-cleanup.
 * The script deletes itself on ANY exit (success, error, or signal).
 * This eliminates race conditions with detached processes.
 */
function wrapWithSelfCleanup(script: string): string {
	return `#!/bin/bash
trap 'rm -f "$0"' EXIT INT TERM
${script}`
}

/**
 * Wrap a batch script with self-cleanup.
 * Uses goto trick to delete itself after execution.
 */
function wrapBatchWithSelfCleanup(script: string): string {
	return `@echo off
${script}
(goto) 2>nul & del "%~f0"`
}

// =============================================================================
// TYPES
// =============================================================================

/** Terminal type for the current platform */
export type TerminalType = "tmux" | "macos" | "windows" | "linux-desktop"

/** Result of a terminal operation */
export interface TerminalResult {
	success: boolean
	error?: string
}

// Singleton mutex for all tmux operations in this process
const tmuxMutex = new Mutex()

/** Stabilization delay after spawning tmux windows (ms) */
const STABILIZATION_DELAY_MS = 150

// =============================================================================
// ENVIRONMENT DETECTION SCHEMAS
// =============================================================================

/** Validates WSL environment detection */
const wslEnvSchema = z.object({
	WSL_DISTRO_NAME: z.string().optional(),
	WSLENV: z.string().optional(),
})

/** Validates Linux terminal environment detection */
const linuxTerminalEnvSchema = z.object({
	KITTY_WINDOW_ID: z.string().optional(),
	WEZTERM_PANE: z.string().optional(),
	ALACRITTY_WINDOW_ID: z.string().optional(),
	GHOSTTY_RESOURCES_DIR: z.string().optional(),
	TERM_PROGRAM: z.string().optional(),
	GNOME_TERMINAL_SERVICE: z.string().optional(),
	KONSOLE_VERSION: z.string().optional(),
})

/** Environment variables for macOS terminal detection */
const macTerminalEnvSchema = z.object({
	TERM_PROGRAM: z.string().optional(),
	GHOSTTY_RESOURCES_DIR: z.string().optional(),
	ITERM_SESSION_ID: z.string().optional(),
	KITTY_WINDOW_ID: z.string().optional(),
	ALACRITTY_WINDOW_ID: z.string().optional(),
	__CFBundleIdentifier: z.string().optional(),
})

type LinuxTerminal =
	| "kitty"
	| "wezterm"
	| "alacritty"
	| "ghostty"
	| "foot"
	| "gnome-terminal"
	| "konsole"
	| "xfce4-terminal"
	| "xdg-terminal-exec"
	| "x-terminal-emulator"
	| "xterm"

type MacTerminal = "ghostty" | "iterm" | "warp" | "kitty" | "alacritty" | "terminal"

// =============================================================================
// PLATFORM DETECTION
// =============================================================================

/**
 * Check if running inside WSL (Windows Subsystem for Linux).
 * Checks environment variables and os.release() for Microsoft string.
 */
function isInsideWSL(): boolean {
	const parsed = wslEnvSchema.safeParse(process.env)
	if (parsed.success && (parsed.data.WSL_DISTRO_NAME || parsed.data.WSLENV)) {
		return true
	}

	// Fallback: check os.release() for Microsoft string
	try {
		return os.release().toLowerCase().includes("microsoft")
	} catch {
		return false
	}
}

/**
 * Detect the best terminal type for the current platform.
 * Priority: tmux > WSL > platform-specific
 *
 * @returns The detected terminal type
 */
export function detectTerminalType(): TerminalType {
	// tmux takes priority - user may be inside tmux on any platform
	if (isInsideTmux()) {
		return "tmux"
	}

	// WSL check (Linux inside Windows) - before platform detection
	if (process.platform === "linux" && isInsideWSL()) {
		return "windows" // Use Windows Terminal via interop
	}

	// Platform-specific
	switch (process.platform) {
		case "darwin":
			return "macos"
		case "win32":
			return "windows"
		case "linux":
			return "linux-desktop"
		default:
			return "linux-desktop"
	}
}

// =============================================================================
// TMUX OPERATIONS (MUTEX-PROTECTED)
// =============================================================================

/**
 * Open a new tmux window with mutex protection.
 * Includes stabilization delay after spawning to prevent races.
 *
 * SECURITY NOTE: Branch names and paths are passed via array-based spawn
 * (Bun.spawnSync with array arguments), NOT shell string interpolation.
 * This prevents command injection even if values contain special characters.
 * The tmux `-n` flag treats its argument as a literal window name string.
 *
 * @param options - Window configuration
 * @param options.sessionName - Optional tmux session name (uses current session if not specified)
 * @param options.windowName - Name for the new window
 * @param options.cwd - Working directory for the window
 * @param options.command - Optional command to execute in the window
 * @returns Success status and optional error message
 *
 * @example
 * ```ts
 * const result = await openTmuxWindow({
 *   windowName: "feature-branch",
 *   cwd: "/path/to/worktree",
 *   command: "opencode --session abc123",
 * })
 * if (!result.success) {
 *   console.error(result.error)
 * }
 * ```
 */
export async function openTmuxWindow(options: {
	sessionName?: string
	windowName: string
	cwd: string
	command?: string
}): Promise<TerminalResult> {
	const { sessionName, windowName, cwd, command } = options

	return tmuxMutex.runExclusive(async () => {
		try {
			// Build tmux new-window command
			const tmuxArgs = ["new-window", "-n", windowName, "-c", cwd, "-P", "-F", "#{pane_id}"]

			// Add session target if specified
			if (sessionName) {
				tmuxArgs.splice(1, 0, "-t", sessionName)
			}

			// If there's a command to run, create script first and pass it to new-window
			if (command) {
				const scriptPath = path.join(getTempDir(), `worktree-${Bun.randomUUIDv7()}.sh`)
				const escapedCwd = escapeBash(cwd)
				const escapedCommand = escapeBash(command)
				const scriptContent = wrapWithSelfCleanup(
					`cd "${escapedCwd}" || exit 1
${escapedCommand}
exec $SHELL`,
				)
				await Bun.write(scriptPath, scriptContent)
				Bun.spawnSync(["chmod", "+x", scriptPath])

				// Add script execution to tmux args
				tmuxArgs.push("--", "bash", scriptPath)
			}

			const createResult = Bun.spawnSync(["tmux", ...tmuxArgs])

			if (createResult.exitCode !== 0) {
				return {
					success: false,
					error: `Failed to create tmux window: ${createResult.stderr.toString()}`,
				}
			}

			// Stabilization delay to let tmux server process the window
			await Bun.sleep(STABILIZATION_DELAY_MS)

			return { success: true }
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			}
		}
	})
}

// =============================================================================
// MACOS TERMINAL
// =============================================================================

/**
 * Detect the current macOS terminal from environment variables.
 * Prioritizes terminal-specific env vars over TERM_PROGRAM for reliability.
 */
function detectCurrentMacTerminal(): MacTerminal {
	const env = macTerminalEnvSchema.parse(process.env)

	// Check specific env vars first (most reliable)
	if (env.GHOSTTY_RESOURCES_DIR) return "ghostty"
	if (env.ITERM_SESSION_ID) return "iterm"
	if (env.KITTY_WINDOW_ID) return "kitty"
	if (env.ALACRITTY_WINDOW_ID) return "alacritty"
	if (env.__CFBundleIdentifier === "dev.warp.Warp-Stable") return "warp"

	// Fallback to TERM_PROGRAM
	const termProgram = env.TERM_PROGRAM?.toLowerCase()
	switch (termProgram) {
		case "ghostty":
			return "ghostty"
		case "iterm.app":
			return "iterm"
		case "warpterm":
			return "warp"
		case "apple_terminal":
			return "terminal"
	}

	// Default to Terminal.app
	return "terminal"
}

/**
 * Open terminal on macOS (Terminal.app, iTerm, Ghostty, etc.)
 * Detects current terminal and uses appropriate method.
 *
 * @param cwd - Working directory for the terminal
 * @param command - Optional command to execute
 * @returns Success status and optional error message
 */
export async function openMacOSTerminal(cwd: string, command?: string): Promise<TerminalResult> {
	// Guard: validate cwd
	if (!cwd) {
		return { success: false, error: "Working directory is required" }
	}

	const escapedCwd = escapeBash(cwd)
	const escapedCommand = command ? escapeBash(command) : ""
	const scriptContent = wrapWithSelfCleanup(
		command
			? `cd "${escapedCwd}" && ${escapedCommand}\nexec bash`
			: `cd "${escapedCwd}"\nexec bash`,
	)

	const terminal = detectCurrentMacTerminal()

	// Track script path for detached spawns to clean up on error
	let detachedScriptPath: string | null = null

	// Handle terminals based on whether they use detached spawns
	try {
		switch (terminal) {
			// Ghostty uses inline command to avoid permission dialog - no temp script needed
			case "ghostty": {
				try {
					const proc = Bun.spawn(
						[
							"open",
							"-na",
							"Ghostty.app",
							"--args",
							`--working-directory=${cwd}`,
							"-e",
							"bash",
							"-c",
							command ? `cd "${escapedCwd}" && ${escapedCommand}` : `cd "${escapedCwd}"`,
						],
						{
							detached: true,
							stdio: ["ignore", "ignore", "ignore"],
						},
					)
					proc.unref()
					return { success: true }
				} catch (error) {
					return {
						success: false,
						error: error instanceof Error ? error.message : String(error),
					}
				}
			}

			// Detached terminals: write script directly - it self-deletes via trap
			// DO NOT use withTempScript for these - the finally block would delete
			// the script before the detached process reads it
			case "kitty": {
				// Try kitty @ remote control first (synchronous, can use withTempScript)
				const remoteResult = await withTempScript(scriptContent, async (scriptPath) => {
					const result = Bun.spawnSync([
						"kitty",
						"@",
						"launch",
						"--type",
						"tab",
						"--cwd",
						cwd,
						"--",
						"bash",
						scriptPath,
					])
					return result.exitCode === 0
				})
				if (remoteResult) {
					return { success: true }
				}

				// Fallback: new window (detached) - write script directly
				detachedScriptPath = path.join(
					getTempDir(),
					`worktree-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`,
				)
				await Bun.write(detachedScriptPath, scriptContent)
				await fs.chmod(detachedScriptPath, 0o755)

				const kittyProc = Bun.spawn(
					["kitty", "--directory", cwd, "-e", "bash", detachedScriptPath],
					{
						detached: true,
						stdio: ["ignore", "ignore", "ignore"],
					},
				)
				kittyProc.unref()
				detachedScriptPath = null // Clear on success - script will self-clean
				return { success: true }
			}

			case "alacritty": {
				// Detached spawn - write script directly
				detachedScriptPath = path.join(
					getTempDir(),
					`worktree-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`,
				)
				await Bun.write(detachedScriptPath, scriptContent)
				await fs.chmod(detachedScriptPath, 0o755)

				const alacrittyProc = Bun.spawn(
					["alacritty", "--working-directory", cwd, "-e", "bash", detachedScriptPath],
					{
						detached: true,
						stdio: ["ignore", "ignore", "ignore"],
					},
				)
				alacrittyProc.unref()
				detachedScriptPath = null // Clear on success - script will self-clean
				return { success: true }
			}

			case "warp": {
				// Detached spawn - write script directly
				detachedScriptPath = path.join(
					getTempDir(),
					`worktree-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`,
				)
				await Bun.write(detachedScriptPath, scriptContent)
				await fs.chmod(detachedScriptPath, 0o755)

				const warpProc = Bun.spawn(["open", "-b", "dev.warp.Warp-Stable", detachedScriptPath], {
					detached: true,
					stdio: ["ignore", "ignore", "ignore"],
				})
				warpProc.unref()
				detachedScriptPath = null // Clear on success - script will self-clean
				return { success: true }
			}

			// iTerm uses AppleScript `write text` which returns before execution completes.
			// Script must self-delete via trap — withTempScript would race.
			case "iterm": {
				detachedScriptPath = path.join(
					getTempDir(),
					`worktree-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`,
				)
				await Bun.write(detachedScriptPath, scriptContent)
				await fs.chmod(detachedScriptPath, 0o755)

				const escapedPath = escapeAppleScript(detachedScriptPath)
				const appleScript = `
					tell application "iTerm"
						if not (exists window 1) then
							reopen
						else
							tell current window
								create tab with default profile
							end tell
						end if
						activate
						tell first session of current tab of current window
							write text "${escapedPath}"
						end tell
					end tell
				`
				const result = Bun.spawnSync(["osascript", "-e", appleScript])
				if (result.exitCode !== 0) {
					return {
						success: false,
						error: `iTerm AppleScript failed: ${result.stderr.toString()}`,
					}
				}
				detachedScriptPath = null
				return { success: true }
			}

			default: {
				// Terminal.app - waits for completion, safe to use withTempScript
				return await withTempScript(scriptContent, async (scriptPath) => {
					const proc = Bun.spawn(["open", "-a", "Terminal", scriptPath], {
						stdio: ["ignore", "ignore", "pipe"],
					})
					const exitCode = await proc.exited
					if (exitCode !== 0) {
						const stderr = await new Response(proc.stderr).text()
						return { success: false, error: `Failed to open Terminal: ${stderr}` }
					}
					return { success: true }
				})
			}
		}
	} catch (error) {
		// Clean up orphaned script on error (matches Linux/Windows behavior)
		if (detachedScriptPath) {
			try {
				await fs.rm(detachedScriptPath)
			} catch {
				// Best-effort cleanup
			}
		}
		return {
			success: false,
			error: `Failed to open terminal: ${error instanceof Error ? error.message : String(error)}`,
		}
	}
}

// =============================================================================
// LINUX TERMINAL
// =============================================================================

/**
 * Detect the current Linux terminal from environment variables.
 * Returns null if no terminal can be detected (use fallback chain).
 */
function detectCurrentLinuxTerminal(): LinuxTerminal | null {
	const env = linuxTerminalEnvSchema.parse(process.env)

	// Check specific env vars first (most reliable)
	if (env.KITTY_WINDOW_ID) return "kitty"
	if (env.WEZTERM_PANE) return "wezterm"
	if (env.ALACRITTY_WINDOW_ID) return "alacritty"
	if (env.GHOSTTY_RESOURCES_DIR) return "ghostty"
	if (env.GNOME_TERMINAL_SERVICE) return "gnome-terminal"
	if (env.KONSOLE_VERSION) return "konsole"

	// TERM_PROGRAM fallback
	const termProgram = env.TERM_PROGRAM?.toLowerCase()
	if (termProgram === "foot") return "foot"

	return null
}

/**
 * Open terminal on Linux with desktop environment detection.
 * Priority: current terminal > xdg-terminal-exec > x-terminal-emulator > modern > DE > xterm
 *
 * NOTE: All Linux terminal spawns are detached, so we write the script directly
 * instead of using withTempScript. The script self-deletes via trap.
 *
 * @param cwd - Working directory for the terminal
 * @param command - Optional command to execute
 * @returns Success status and optional error message
 */
export async function openLinuxTerminal(cwd: string, command?: string): Promise<TerminalResult> {
	// Guard: validate cwd
	if (!cwd) {
		return { success: false, error: "Working directory is required" }
	}

	const escapedCwd = escapeBash(cwd)
	const escapedCommand = command ? escapeBash(command) : ""
	const scriptContent = wrapWithSelfCleanup(
		command
			? `cd "${escapedCwd}" && ${escapedCommand}\nexec bash`
			: `cd "${escapedCwd}"\nexec bash`,
	)

	// Write script directly - it self-deletes via trap
	// DO NOT use withTempScript - all Linux spawns are detached
	const scriptPath = path.join(
		getTempDir(),
		`worktree-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`,
	)
	await Bun.write(scriptPath, scriptContent)
	await fs.chmod(scriptPath, 0o755)

	try {
		// Helper to try a terminal (all detached spawns)
		const tryTerminal = async (
			name: string,
			args: string[],
		): Promise<{ tried: boolean; success: boolean }> => {
			const check = Bun.spawnSync(["which", name])
			if (check.exitCode !== 0) {
				return { tried: false, success: false }
			}

			try {
				const proc = Bun.spawn(args, {
					detached: true,
					stdio: ["ignore", "ignore", "ignore"],
				})
				proc.unref()
				return { tried: true, success: true }
			} catch {
				return { tried: true, success: false }
			}
		}

		// 1. Check current terminal via env detection
		const currentTerminal = detectCurrentLinuxTerminal()
		if (currentTerminal) {
			let result: { tried: boolean; success: boolean }

			switch (currentTerminal) {
				case "kitty": {
					// Try remote control first (synchronous, script still needed after)
					const kittyRemote = Bun.spawnSync([
						"kitty",
						"@",
						"launch",
						"--type",
						"tab",
						"--cwd",
						cwd,
						"--",
						"bash",
						scriptPath,
					])
					if (kittyRemote.exitCode === 0) {
						return { success: true }
					}
					result = await tryTerminal("kitty", [
						"kitty",
						"--directory",
						cwd,
						"-e",
						"bash",
						scriptPath,
					])
					break
				}
				case "wezterm":
					result = await tryTerminal("wezterm", [
						"wezterm",
						"cli",
						"spawn",
						"--cwd",
						cwd,
						"--",
						"bash",
						scriptPath,
					])
					break
				case "alacritty":
					result = await tryTerminal("alacritty", [
						"alacritty",
						"--working-directory",
						cwd,
						"-e",
						"bash",
						scriptPath,
					])
					break
				case "ghostty":
					result = await tryTerminal("ghostty", ["ghostty", "-e", "bash", scriptPath])
					break
				case "foot":
					result = await tryTerminal("foot", [
						"foot",
						"--working-directory",
						cwd,
						"bash",
						scriptPath,
					])
					break
				case "gnome-terminal":
					result = await tryTerminal("gnome-terminal", [
						"gnome-terminal",
						"--working-directory",
						cwd,
						"--",
						"bash",
						scriptPath,
					])
					break
				case "konsole":
					result = await tryTerminal("konsole", [
						"konsole",
						"--workdir",
						cwd,
						"-e",
						"bash",
						scriptPath,
					])
					break
				default:
					result = { tried: false, success: false }
			}

			if (result.success) {
				return { success: true }
			}
		}

		// 2. xdg-terminal-exec (modern XDG standard)
		const xdgResult = await tryTerminal("xdg-terminal-exec", [
			"xdg-terminal-exec",
			"--",
			"bash",
			scriptPath,
		])
		if (xdgResult.success) return { success: true }

		// 3. x-terminal-emulator (Debian/Ubuntu)
		const xteResult = await tryTerminal("x-terminal-emulator", [
			"x-terminal-emulator",
			"-e",
			"bash",
			scriptPath,
		])
		if (xteResult.success) return { success: true }

		// 4. Modern terminals fallback
		const modernTerminals: Array<{ name: string; args: string[] }> = [
			{ name: "kitty", args: ["kitty", "--directory", cwd, "-e", "bash", scriptPath] },
			{
				name: "alacritty",
				args: ["alacritty", "--working-directory", cwd, "-e", "bash", scriptPath],
			},
			{
				name: "wezterm",
				args: ["wezterm", "cli", "spawn", "--cwd", cwd, "--", "bash", scriptPath],
			},
			{ name: "ghostty", args: ["ghostty", "-e", "bash", scriptPath] },
			{ name: "foot", args: ["foot", "--working-directory", cwd, "bash", scriptPath] },
		]

		for (const { name, args } of modernTerminals) {
			const result = await tryTerminal(name, args)
			if (result.success) return { success: true }
		}

		// 5. DE terminals fallback
		const deTerminals: Array<{ name: string; args: string[] }> = [
			{
				name: "gnome-terminal",
				args: ["gnome-terminal", "--working-directory", cwd, "--", "bash", scriptPath],
			},
			{ name: "konsole", args: ["konsole", "--workdir", cwd, "-e", "bash", scriptPath] },
			{
				name: "xfce4-terminal",
				args: ["xfce4-terminal", "--working-directory", cwd, "-x", "bash", scriptPath],
			},
		]

		for (const { name, args } of deTerminals) {
			const result = await tryTerminal(name, args)
			if (result.success) return { success: true }
		}

		// 6. Last resort: xterm
		const xtermResult = await tryTerminal("xterm", ["xterm", "-e", "bash", scriptPath])
		if (xtermResult.success) return { success: true }

		// No terminal found - clean up the orphaned script
		try {
			await fs.rm(scriptPath)
		} catch {
			// Best-effort cleanup
		}
		return { success: false, error: "No terminal emulator found" }
	} catch (error) {
		return {
			success: false,
			error: `Failed to spawn terminal: ${error instanceof Error ? error.message : String(error)}`,
		}
	}
}

// =============================================================================
// WINDOWS TERMINAL
// =============================================================================

/**
 * Open terminal on Windows (Windows Terminal or cmd).
 * Tries Windows Terminal (wt.exe) first, falls back to cmd.exe.
 *
 * NOTE: All Windows terminal spawns are detached, so we write the script directly
 * instead of using withTempScript. The script self-deletes via goto trick.
 *
 * @param cwd - Working directory for the terminal
 * @param command - Optional command to execute
 * @returns Success status and optional error message
 */
export async function openWindowsTerminal(cwd: string, command?: string): Promise<TerminalResult> {
	// Guard: validate cwd
	if (!cwd) {
		return { success: false, error: "Working directory is required" }
	}

	const escapedCwd = escapeBatch(cwd)
	const escapedCommand = command ? escapeBatch(command) : ""
	const scriptContent = wrapBatchWithSelfCleanup(
		command
			? `cd /d "${escapedCwd}"\r\n${escapedCommand}\r\ncmd /k`
			: `cd /d "${escapedCwd}"\r\ncmd /k`,
	)

	// Write script directly - it self-deletes via goto trick
	// DO NOT use withTempScript - all Windows spawns are detached
	const scriptPath = path.join(
		getTempDir(),
		`worktree-${Date.now()}-${Math.random().toString(36).slice(2)}.bat`,
	)
	await Bun.write(scriptPath, scriptContent)
	await fs.chmod(scriptPath, 0o755)

	try {
		// Check for Windows Terminal
		const wtCheck = Bun.spawnSync(["where", "wt"], {
			stdout: "pipe",
			stderr: "pipe",
		})

		if (wtCheck.exitCode === 0) {
			try {
				const proc = Bun.spawn(["wt.exe", "-d", cwd, "cmd", "/k", scriptPath], {
					detached: true,
					stdio: ["ignore", "ignore", "ignore"],
				})
				proc.unref()
				return { success: true }
			} catch {
				// Fall through to cmd.exe
			}
		}

		// Fallback: cmd.exe
		try {
			const proc = Bun.spawn(["cmd", "/c", "start", "", scriptPath], {
				detached: true,
				stdio: ["ignore", "ignore", "ignore"],
			})
			proc.unref()
			return { success: true }
		} catch (error) {
			// Failed to spawn - clean up orphaned script
			try {
				await fs.rm(scriptPath)
			} catch {
				// Best-effort cleanup
			}
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			}
		}
	} catch (error) {
		return {
			success: false,
			error: `Failed to spawn terminal: ${error instanceof Error ? error.message : String(error)}`,
		}
	}
}

// =============================================================================
// WSL TERMINAL
// =============================================================================

/**
 * Open terminal in WSL via Windows Terminal interop.
 * Falls back to bash in current terminal if wt.exe not available.
 *
 * NOTE: All WSL terminal spawns are detached, so we write the script directly
 * instead of using withTempScript. The script self-deletes via trap.
 */
export async function openWSLTerminal(cwd: string, command?: string): Promise<TerminalResult> {
	// Guard: validate cwd
	if (!cwd) {
		return { success: false, error: "Working directory is required" }
	}

	const escapedCwd = escapeBash(cwd)
	const escapedCommand = command ? escapeBash(command) : ""
	const scriptContent = wrapWithSelfCleanup(
		command
			? `cd "${escapedCwd}" && ${escapedCommand}\nexec bash`
			: `cd "${escapedCwd}"\nexec bash`,
	)

	// Write script directly - it self-deletes via trap
	// DO NOT use withTempScript - all WSL spawns are detached
	const scriptPath = path.join(
		getTempDir(),
		`worktree-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`,
	)
	await Bun.write(scriptPath, scriptContent)
	await fs.chmod(scriptPath, 0o755)

	try {
		// Try wt.exe first (Windows Terminal via PATH interop)
		const wtResult = Bun.spawnSync(["which", "wt.exe"])
		if (wtResult.exitCode === 0) {
			try {
				const proc = Bun.spawn(["wt.exe", "-d", cwd, "bash", scriptPath], {
					detached: true,
					stdio: ["ignore", "ignore", "ignore"],
				})
				proc.unref()
				return { success: true }
			} catch {
				// Fall through to bash
			}
		}

		// Fallback: open in current terminal (new bash process)
		try {
			const proc = Bun.spawn(["bash", scriptPath], {
				cwd,
				detached: true,
				stdio: ["ignore", "ignore", "ignore"],
			})
			proc.unref()
			return { success: true }
		} catch (error) {
			// Failed to spawn - clean up orphaned script
			try {
				await fs.rm(scriptPath)
			} catch {
				// Best-effort cleanup
			}
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			}
		}
	} catch (error) {
		return {
			success: false,
			error: `Failed to spawn terminal: ${error instanceof Error ? error.message : String(error)}`,
		}
	}
}

// =============================================================================
// UNIFIED TERMINAL OPENING
// =============================================================================

/**
 * Open a terminal window on the current platform.
 * Automatically detects the best terminal type and method.
 *
 * @param cwd - Working directory for the terminal
 * @param command - Optional command to execute
 * @param windowName - Optional window name (used for tmux)
 * @returns Success status and optional error message
 */
export async function openTerminal(
	cwd: string,
	command?: string,
	windowName?: string,
): Promise<TerminalResult> {
	const terminalType = detectTerminalType()

	switch (terminalType) {
		case "tmux":
			return openTmuxWindow({
				windowName: windowName || "worktree",
				cwd,
				command,
			})

		case "macos":
			return openMacOSTerminal(cwd, command)

		case "windows":
			// Check if we're in WSL
			if (process.platform === "linux" && isInsideWSL()) {
				return openWSLTerminal(cwd, command)
			}
			return openWindowsTerminal(cwd, command)

		case "linux-desktop":
			return openLinuxTerminal(cwd, command)

		default:
			return { success: false, error: `Unsupported terminal type: ${terminalType}` }
	}
}

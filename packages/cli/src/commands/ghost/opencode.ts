/**
 * Ghost OpenCode Command
 *
 * Launch OpenCode with ghost mode configuration using symlink farm isolation.
 * Creates a temp directory with symlinks to project files, excluding OpenCode
 * config files, to prevent OpenCode from discovering project-level settings.
 */

import { renameSync, rmSync } from "node:fs"
import { copyFile, mkdir, readdir } from "node:fs/promises"
import path from "node:path"
import { Glob } from "bun"
import type { Command } from "commander"
import { ProfileManager } from "../../profile/manager.js"
import { getProfileDir, getProfileOpencodeConfig } from "../../profile/paths.js"
import { ProfilesNotInitializedError } from "../../utils/errors.js"
import { createFileSync, type FileSyncHandle, normalizePath } from "../../utils/file-sync.js"
import { getGitInfo } from "../../utils/git-context.js"
import { detectGitRepo, handleError, logger } from "../../utils/index.js"
import { sharedOptions } from "../../utils/shared-options.js"
import {
	cleanupOrphanedGhostDirs,
	cleanupSymlinkFarm,
	createSymlinkFarm,
	REMOVING_SUFFIX,
} from "../../utils/symlink-farm.js"
import {
	formatTerminalName,
	restoreTerminalTitle,
	saveTerminalTitle,
	setTerminalName,
} from "../../utils/terminal-title.js"

interface GhostOpenCodeOptions {
	json?: boolean
	quiet?: boolean
	profile?: string
	rename?: boolean
}

export function registerGhostOpenCodeCommand(parent: Command): void {
	parent
		.command("opencode")
		.description("Launch OpenCode with ghost mode configuration")
		.option("-p, --profile <name>", "Use specific profile")
		.option("--no-rename", "Disable terminal/tmux window renaming")
		.addOption(sharedOptions.json())
		.addOption(sharedOptions.quiet())
		.allowUnknownOption()
		.allowExcessArguments(true)
		.action(async (options: GhostOpenCodeOptions, command: Command) => {
			try {
				// Get all remaining arguments after "opencode"
				const args = command.args
				await runGhostOpenCode(args, options)
			} catch (error) {
				handleError(error, { json: options.json })
			}
		})
}

async function runGhostOpenCode(args: string[], options: GhostOpenCodeOptions): Promise<void> {
	// Guard: Check profiles are initialized (Law 1: Early Exit)
	const manager = ProfileManager.create()
	if (!(await manager.isInitialized())) {
		throw new ProfilesNotInitializedError()
	}

	// Clean up orphaned temp directories from interrupted sessions (SIGKILL resilience)
	await cleanupOrphanedGhostDirs()

	// Resolve current profile (respects --profile flag, OCX_PROFILE env, or symlink)
	const profileName = await manager.getCurrent(options.profile)
	const profile = await manager.get(profileName)

	// Get the profile's config directory
	const profileDir = getProfileDir(profileName)

	// Check for profile's opencode.jsonc (optional)
	const profileOpencodePath = getProfileOpencodeConfig(profileName)
	const profileOpencodeFile = Bun.file(profileOpencodePath)
	const hasOpencodeConfig = await profileOpencodeFile.exists()

	// Guard: Warn if opencode config is empty/missing (but still proceed)
	// Suppress warning in quiet mode
	if (!hasOpencodeConfig && !options.quiet) {
		logger.warn(
			`No opencode.jsonc found at ${profileOpencodePath}. Create one to customize OpenCode settings.`,
		)
	}

	// Detect git repository context (may be null if not in a git repo)
	const cwd = process.cwd()
	const gitContext = await detectGitRepo(cwd)

	// Create symlink farm with pattern-based filtering
	// Exclude patterns handle OpenCode config files (opencode.jsonc, AGENTS.md, .opencode/)
	const ghostConfig = profile.ghost
	const tempDir = await createSymlinkFarm(cwd, {
		includePatterns: ghostConfig.include,
		excludePatterns: ghostConfig.exclude,
	})

	// Inject profile overlay - everything in profile dir except ghost.jsonc
	// This includes opencode.jsonc, AGENTS.md, .opencode/, etc.
	const overlayFiles = await injectProfileOverlay(tempDir, profileDir, ghostConfig.include)

	// Track cleanup state to prevent double cleanup
	let cleanupDone = false
	let fileSync: FileSyncHandle | undefined

	// Start real-time file sync - syncs new files from temp dir to project
	// Pass overlay files to prevent profile configs from syncing back to project
	fileSync = createFileSync(tempDir, cwd, { overlayFiles })

	const performCleanup = async () => {
		if (cleanupDone) return
		cleanupDone = true
		await cleanupSymlinkFarm(tempDir)
	}

	// Determine if terminal should be renamed (Law 1: compute once, use in closure)
	// Precedence: CLI flag > config > default(true)
	const shouldRename = options.rename !== false && ghostConfig.renameWindow !== false

	// Safety net: sync cleanup on exit using rename-to-removing pattern
	// This ensures SIGKILL resilience: if rename succeeds but rm is interrupted,
	// the -removing directory will be cleaned up on next startup
	const exitHandler = () => {
		// Only restore if we renamed (Law 3: Atomic Predictability)
		if (shouldRename) {
			restoreTerminalTitle()
		}

		// Best-effort file sync close - can't await in sync handler
		if (fileSync) {
			fileSync.close().catch(() => {})
		}

		if (!cleanupDone && tempDir) {
			try {
				const removingPath = `${tempDir}${REMOVING_SUFFIX}`
				renameSync(tempDir, removingPath)
				rmSync(removingPath, { recursive: true, force: true })
			} catch {
				// Best effort cleanup
			}
		}
	}
	process.on("exit", exitHandler)

	// Setup signal handlers BEFORE spawn to avoid race condition
	// Use optional chaining since proc is null until spawn completes
	let proc: ReturnType<typeof Bun.spawn> | null = null

	const sigintHandler = () => proc?.kill("SIGINT")
	const sigtermHandler = () => proc?.kill("SIGTERM")

	process.on("SIGINT", sigintHandler)
	process.on("SIGTERM", sigtermHandler)

	// Set terminal name only if enabled (Law 1: Early Exit pattern)
	if (shouldRename) {
		saveTerminalTitle()
		const gitInfo = await getGitInfo(cwd)
		setTerminalName(formatTerminalName(cwd, profileName, gitInfo))
	}

	// Spawn opencode from the temp directory with config passed via environment
	// Only set GIT_DIR/GIT_WORK_TREE when actually in a git repository
	// If profile has opencode.jsonc, pass it via OPENCODE_CONFIG
	proc = Bun.spawn({
		cmd: ["opencode", ...args],
		cwd: tempDir,
		env: {
			...process.env,
			...(profile.opencode && { OPENCODE_CONFIG_CONTENT: JSON.stringify(profile.opencode) }),
			OPENCODE_CONFIG_DIR: profileDir,
			OCX_PROFILE: profileName, // Pass profile to child processes
			...(gitContext && {
				GIT_WORK_TREE: gitContext.workTree,
				GIT_DIR: gitContext.gitDir,
			}),
		},
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	})

	try {
		// Wait for child to exit
		const exitCode = await proc.exited

		// Cleanup BEFORE process.exit (fixes race condition)
		process.off("SIGINT", sigintHandler)
		process.off("SIGTERM", sigtermHandler)
		process.off("exit", exitHandler)

		// Close file sync and report status
		if (fileSync) {
			await fileSync.close()
			const syncCount = fileSync.getSyncCount()
			const failures = fileSync.getFailures()
			if (syncCount > 0 && !options.quiet) {
				logger.info(`Synced ${syncCount} new files to project`)
			}
			if (failures.length > 0) {
				logger.warn(`${failures.length} files failed to sync`)
				for (const f of failures) {
					logger.debug(`  ${f.path}: ${f.error.message}`)
				}
			}
		}

		await performCleanup()
		process.exit(exitCode)
	} catch (error) {
		// Error during spawn/wait - still cleanup
		process.off("SIGINT", sigintHandler)
		process.off("SIGTERM", sigtermHandler)
		process.off("exit", exitHandler)

		if (fileSync) {
			await fileSync.close()
		}
		await performCleanup()
		throw error
	}
}

/**
 * Check if user explicitly included a path via include patterns.
 * When a user explicitly includes a project file, don't overwrite with profile version.
 *
 * @param relativePath - Path relative to project root
 * @param compiledPatterns - Pre-compiled Glob patterns from ghost.jsonc
 * @returns True if user explicitly included this path
 */
function userExplicitlyIncluded(relativePath: string, compiledPatterns: Glob[]): boolean {
	// Law 1: Early Exit - no patterns means nothing explicitly included
	if (compiledPatterns.length === 0) return false

	return compiledPatterns.some((glob) => glob.match(relativePath))
}

/**
 * Inject everything from profile directory except ghost.jsonc into the symlink farm.
 * This copies profile config files (opencode.jsonc, AGENTS.md, .opencode/, etc.)
 * into the temp directory so OpenCode discovers them.
 *
 * @param tempDir - Target temp directory (symlink farm)
 * @param profileDir - Source profile directory
 * @param includePatterns - User's include patterns (to avoid overwriting explicitly included project files)
 */
async function injectProfileOverlay(
	tempDir: string,
	profileDir: string,
	includePatterns: string[],
): Promise<Set<string>> {
	const entries = await readdir(profileDir, { withFileTypes: true, recursive: true })

	// Track all injected files for overlay exclusion (Law 3: Atomic Predictability)
	const injectedFiles = new Set<string>()

	// Pre-compile globs once before the loop (performance optimization)
	const compiledIncludePatterns = includePatterns.map((p) => new Glob(p))

	for (const entry of entries) {
		// Build relative path from profile directory
		const relativePath = path.relative(profileDir, path.join(entry.parentPath, entry.name))

		// Law 1: Early Exit - skip ghost.jsonc (our config, not OpenCode's)
		if (relativePath === "ghost.jsonc") continue

		// Law 1: Early Exit - skip .gitignore (critical for file-sync)
		// The profile's .gitignore is for the profile dir, not the project.
		// Copying it would overwrite the project's symlinked .gitignore and break file-sync filtering.
		if (relativePath === ".gitignore") continue

		// Law 1: Early Exit - skip if user explicitly included the project version
		// This lets users keep project AGENTS.md by including it explicitly
		if (userExplicitlyIncluded(relativePath, compiledIncludePatterns)) continue

		// Law 1: Early Exit - skip directories, files create their parents
		if (entry.isDirectory()) continue

		const destPath = path.join(tempDir, relativePath)

		// Ensure parent directory exists and copy file
		await mkdir(path.dirname(destPath), { recursive: true })
		await copyFile(path.join(entry.parentPath, entry.name), destPath)

		// Track normalized path for overlay exclusion
		injectedFiles.add(normalizePath(relativePath))
	}

	// Return immutable copy (Law 3: Atomic Predictability)
	return new Set(injectedFiles)
}

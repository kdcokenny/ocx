/**
 * Ghost OpenCode Command
 *
 * Launch OpenCode with ghost mode configuration using symlink farm isolation.
 * Creates a temp directory with symlinks to project files, excluding OpenCode
 * config files, to prevent OpenCode from discovering project-level settings.
 */

import { renameSync, rmSync } from "node:fs"
import { copyFile as copyFilePromise } from "node:fs/promises"
import path from "node:path"
import type { Command } from "commander"
import { ProfileManager } from "../../profile/manager.js"
import { needsMigration } from "../../profile/migrate.js"
import { getProfileAgents, getProfileDir, getProfileOpencodeConfig } from "../../profile/paths.js"
import { ProfilesNotInitializedError } from "../../utils/errors.js"
import { getGitInfo } from "../../utils/git-context.js"
import { detectGitRepo, handleError, logger } from "../../utils/index.js"
import { discoverProjectFiles } from "../../utils/opencode-discovery.js"

import { sharedOptions } from "../../utils/shared-options.js"
import {
	cleanupOrphanedGhostDirs,
	cleanupSymlinkFarm,
	createSymlinkFarm,
	injectGhostFiles,
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
}

export function registerGhostOpenCodeCommand(parent: Command): void {
	parent
		.command("opencode")
		.description("Launch OpenCode with ghost mode configuration")
		.option("-p, --profile <name>", "Use specific profile")
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

	// Check for legacy config and print migration notice (but still proceed)
	if (!options.quiet && (await needsMigration())) {
		console.log("Notice: Found legacy config at ~/.config/ocx/")
		console.log("Run 'ocx ghost migrate' to upgrade to the new profiles system.\n")
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

	// Discover project files to exclude (use cwd as gitRoot fallback if not in repo)
	const gitRoot = gitContext?.workTree ?? cwd
	const discoveredPaths = await discoverProjectFiles(cwd, gitRoot)

	// Create symlink farm with pattern-based filtering
	// Pattern matching is handled internally by computeSymlinkPlan
	const ghostConfig = profile.ghost
	const tempDir = await createSymlinkFarm(cwd, discoveredPaths, {
		includePatterns: ghostConfig.include,
		excludePatterns: ghostConfig.exclude,
	})

	// Inject ghost OpenCode files from profile directory into the temp directory
	const ghostFiles = await discoverProjectFiles(profileDir, profileDir)
	await injectGhostFiles(tempDir, profileDir, ghostFiles)

	// If profile has AGENTS.md, copy it into temp directory
	if (profile.hasAgents) {
		const agentsPath = getProfileAgents(profileName)
		const destAgentsPath = path.join(tempDir, "AGENTS.md")
		await copyFilePromise(agentsPath, destAgentsPath)
	}

	// Track cleanup state to prevent double cleanup
	let cleanupDone = false
	const performCleanup = async () => {
		if (cleanupDone) return
		cleanupDone = true
		await cleanupSymlinkFarm(tempDir)
	}

	// Safety net: sync cleanup on exit using rename-to-removing pattern
	// This ensures SIGKILL resilience: if rename succeeds but rm is interrupted,
	// the -removing directory will be cleaned up on next startup
	const exitHandler = () => {
		// REQUIREMENT: Restore terminal title FIRST in exit handler.
		// Must run before any other cleanup while stdout is still valid.
		// This pops the saved title from the terminal's title stack.
		restoreTerminalTitle()

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

	// REQUIREMENT: Save terminal title BEFORE setting ghost title.
	// This pushes the current title to the terminal's title stack so it can be
	// restored when OpenCode exits. Must happen before setTerminalName().
	saveTerminalTitle()

	// Set terminal name for easy identification in tmux/terminal tabs
	const gitInfo = await getGitInfo(cwd)
	setTerminalName(formatTerminalName(cwd, profileName, gitInfo))

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
		process.exit(exitCode)
	} finally {
		// ALWAYS runs - success, error, or throw
		// Cleanup signal handlers to prevent memory leaks
		process.off("SIGINT", sigintHandler)
		process.off("SIGTERM", sigtermHandler)
		process.off("exit", exitHandler)
		await performCleanup()
	}
}

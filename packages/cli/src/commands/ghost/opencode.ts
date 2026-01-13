/**
 * Ghost OpenCode Command
 *
 * Launch OpenCode with ghost mode configuration using symlink farm isolation.
 * Creates a temp directory with symlinks to project files, excluding OpenCode
 * config files, to prevent OpenCode from discovering project-level settings.
 */

import { existsSync, renameSync, rmSync, statSync } from "node:fs"
import { copyFile, mkdir, readdir } from "node:fs/promises"
import path from "node:path"
import { Glob } from "bun"
import type { Command } from "commander"
import { ProfileManager } from "../../profile/manager.js"
import { getProfileDir, getProfileOpencodeConfig } from "../../profile/paths.js"
import { NotFoundError, ProfilesNotInitializedError, ValidationError } from "../../utils/errors.js"
import { createFileSync, type FileSyncHandle, normalizePath } from "../../utils/file-sync.js"
import { getGitInfo } from "../../utils/git-context.js"
import { detectGitRepo, handleError, logger } from "../../utils/index.js"
import { isAbsolutePath } from "../../utils/path-helpers.js"
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

/**
 * Files/patterns that are valid OpenCode configuration and should be copied
 * from profile directory to symlink farm. Everything else is ignored.
 * Profile only "fills holes" (excluded patterns) - never overwrites symlinks.
 */
const PROFILE_OVERLAY_ALLOWED: (string | RegExp)[] = [
	"opencode.jsonc",
	"opencode.json",
	"opencode.yaml",
	"AGENTS.md",
	"CLAUDE.md",
	"CONTEXT.md",
	/^\.opencode(\/|$)/, // .opencode/ directory and all contents (plugins, etc.)
]

// =============================================================================
// PATH RESOLUTION TYPES AND UTILITIES
// =============================================================================

/**
 * Filesystem operations interface for dependency injection.
 * Enables pure unit testing by decoupling from real fs.
 */
export interface FsOperations {
	existsSync: (path: string) => boolean
	statSync: (path: string) => { isDirectory: () => boolean }
}

/**
 * Default filesystem operations using node:fs.
 * Used in production; tests can inject mocks.
 */
export const defaultFs: FsOperations = {
	existsSync,
	statSync,
}

/**
 * Resolved project path with remaining args for command passthrough.
 * Parse-don't-validate: data is in trusted state after resolution.
 */
export interface ResolvedProjectPath {
	/** Absolute path to the project directory (validated to exist and be a directory) */
	readonly projectDir: string
	/** Args to pass through to OpenCode (excludes consumed path argument) */
	readonly remainingArgs: string[]
	/** Original path input if explicitly provided (for logging), null if using cwd */
	readonly explicitPath: string | null
}

/**
 * Resolves and validates a project path from CLI arguments.
 *
 * Follows the 5 Laws of Elegant Defense:
 * - Law 1 (Early Exit): Guard clauses handle edge cases at top
 * - Law 2 (Parse Don't Validate): Returns trusted ResolvedProjectPath type
 * - Law 4 (Fail Fast): Throws clear errors for invalid states
 * - Law 5 (Intentional Naming): Names describe exact purpose
 *
 * @param args - CLI arguments array, may contain `--` sentinel
 * @param cwd - Current working directory for relative path resolution
 * @param fs - Filesystem operations (injectable for testing)
 * @returns Resolved project path with remaining args for passthrough
 * @throws NotFoundError - Path does not exist
 * @throws ValidationError - Path exists but is not a directory
 *
 * @example
 * // No path argument - use cwd
 * resolveProjectPath([], '/home/user')
 * // => { projectDir: '/home/user', remainingArgs: [], explicitPath: null }
 *
 * @example
 * // Absolute path
 * resolveProjectPath(['/projects/foo'], '/home/user')
 * // => { projectDir: '/projects/foo', remainingArgs: [], explicitPath: '/projects/foo' }
 *
 * @example
 * // Relative path with extra args
 * resolveProjectPath(['./myproject', '--help'], '/home/user')
 * // => { projectDir: '/home/user/myproject', remainingArgs: ['--help'], explicitPath: './myproject' }
 *
 * @example
 * // POSIX sentinel - first arg after '--' is path
 * resolveProjectPath(['--', '/projects/foo', '--help'], '/home/user')
 * // => { projectDir: '/projects/foo', remainingArgs: ['--help'], explicitPath: '/projects/foo' }
 */
export function resolveProjectPath(
	args: string[],
	cwd: string,
	fs: FsOperations = defaultFs,
): ResolvedProjectPath {
	// Law 1: Early Exit - no arguments means use cwd
	if (args.length === 0) {
		return { projectDir: cwd, remainingArgs: [], explicitPath: null }
	}

	const firstArg = args[0]

	// Law 1: Early Exit - undefined first arg (shouldn't happen but satisfies TS)
	if (firstArg === undefined) {
		return { projectDir: cwd, remainingArgs: [], explicitPath: null }
	}

	// Law 1: Early Exit - handle POSIX `--` sentinel
	// Pattern: `ocx ghost opencode -- /path/to/project`
	// The `--` signals end of options; next arg is the path
	let pathArg: string
	let remainingArgs: string[]

	if (firstArg === "--") {
		// After `--`, the next argument is the path
		const secondArg = args[1]
		if (secondArg === undefined) {
			// `--` with no following arg means use cwd
			return { projectDir: cwd, remainingArgs: [], explicitPath: null }
		}
		pathArg = secondArg
		remainingArgs = args.slice(2) // Skip `--` and path
	} else {
		// Check if first arg looks like a path (exists as directory)
		const potentialPath = isAbsolutePath(firstArg) ? firstArg : path.resolve(cwd, firstArg)

		// If first arg doesn't exist or isn't a directory, treat all args as passthrough
		if (!fs.existsSync(potentialPath)) {
			return { projectDir: cwd, remainingArgs: args, explicitPath: null }
		}

		const stat = fs.statSync(potentialPath)
		if (!stat.isDirectory()) {
			// First arg exists but isn't a directory - pass all args through
			return { projectDir: cwd, remainingArgs: args, explicitPath: null }
		}

		// First arg is a valid directory path
		pathArg = firstArg
		remainingArgs = args.slice(1) // Skip path
	}

	// Resolve to absolute path (Law 2: Parse at boundary)
	const projectDir = isAbsolutePath(pathArg) ? pathArg : path.resolve(cwd, pathArg)

	// Law 4: Fail Fast - validate path exists (already checked above for non-sentinel case)
	if (!fs.existsSync(projectDir)) {
		throw new NotFoundError(`Project path does not exist: ${pathArg}`)
	}

	// Law 4: Fail Fast - validate path is a directory
	const stat = fs.statSync(projectDir)
	if (!stat.isDirectory()) {
		throw new ValidationError(`Project path is not a directory: ${pathArg}`)
	}

	// Law 2: Return parsed, trusted state
	return {
		projectDir,
		remainingArgs,
		explicitPath: pathArg,
	}
}

/**
 * Check if a path matches the profile overlay allowlist.
 * Uses exact match for strings, regex test for patterns.
 */
function isAllowedOverlayFile(relativePath: string): boolean {
	return PROFILE_OVERLAY_ALLOWED.some((pattern) =>
		typeof pattern === "string" ? relativePath === pattern : pattern.test(relativePath),
	)
}

/**
 * Check if a path is within a symlinked directory.
 * Used to prevent profile overlay from writing into project-owned areas.
 * Uses forward slashes only (Unix/Bun assumption).
 *
 * @param relativePath - Path to check (forward slashes)
 * @param symlinkRoots - Set of symlinked paths from createSymlinkFarm
 */
function isWithinSymlinkRoot(relativePath: string, symlinkRoots: Set<string>): boolean {
	for (const root of symlinkRoots) {
		if (relativePath === root || relativePath.startsWith(`${root}/`)) {
			return true
		}
	}
	return false
}

interface GhostOpenCodeOptions {
	json?: boolean
	quiet?: boolean
	profile?: string
	rename?: boolean
}

export function registerGhostOpenCodeCommand(parent: Command): void {
	parent
		.command("opencode [path]")
		.description("Launch OpenCode with ghost mode configuration in optional project path")
		.option("-p, --profile <name>", "Use specific profile")
		.option("--no-rename", "Disable terminal/tmux window renaming")
		.addOption(sharedOptions.json())
		.addOption(sharedOptions.quiet())
		.allowUnknownOption()
		.allowExcessArguments(true)
		.action(
			async (pathArg: string | undefined, options: GhostOpenCodeOptions, command: Command) => {
				try {
					// Reconstruct args: prepend pathArg if provided, then add any remaining args
					const args = pathArg ? [pathArg, ...command.args] : command.args
					await runGhostOpenCode(args, options)
				} catch (error) {
					handleError(error, { json: options.json })
				}
			},
		)
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

	// Resolve project path from args (Law 2: Parse at boundary)
	// If user provided a path, use it; otherwise fall back to cwd
	const { projectDir, remainingArgs, explicitPath } = resolveProjectPath(args, process.cwd())

	// Log explicit path usage (Law 5: Intentional Naming - user knows what happened)
	if (explicitPath && !options.quiet) {
		logger.info(`Using project directory: ${projectDir}`)
	}

	// Detect git repository context (may be null if not in a git repo)
	const gitContext = await detectGitRepo(projectDir)

	// Create symlink farm with pattern-based filtering
	// Exclude patterns handle OpenCode config files (opencode.jsonc, AGENTS.md, .opencode/)
	const ghostConfig = profile.ghost
	const { tempDir, symlinkRoots } = await createSymlinkFarm(projectDir, {
		includePatterns: ghostConfig.include,
		excludePatterns: ghostConfig.exclude,
		maxFiles: ghostConfig.maxFiles,
	})

	// Inject profile overlay - everything in profile dir except ghost.jsonc
	// This includes opencode.jsonc, AGENTS.md, .opencode/, etc.
	const overlayFiles = await injectProfileOverlay(
		tempDir,
		profileDir,
		ghostConfig.include,
		symlinkRoots,
	)

	// Track cleanup state to prevent double cleanup
	let cleanupDone = false
	let fileSync: FileSyncHandle | undefined

	// Start real-time file sync - syncs new files from temp dir to project
	// Pass overlay files to prevent profile configs from syncing back to project
	fileSync = createFileSync(tempDir, projectDir, { overlayFiles })

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
		const gitInfo = await getGitInfo(projectDir)
		setTerminalName(formatTerminalName(projectDir, profileName, gitInfo))
	}

	// Spawn opencode from the temp directory with config passed via environment
	// Only set GIT_DIR/GIT_WORK_TREE when actually in a git repository
	// If profile has opencode.jsonc, pass it via OPENCODE_CONFIG
	proc = Bun.spawn({
		cmd: ["opencode", ...remainingArgs],
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
 * Inject allowed config files from profile directory into the symlink farm.
 * Only copies files in PROFILE_OVERLAY_ALLOWED that don't exist in symlinked areas.
 * This ensures profile configs "fill holes" without overwriting project files.
 *
 * @param tempDir - Target temp directory (symlink farm)
 * @param profileDir - Source profile directory
 * @param includePatterns - User's include patterns (to avoid overwriting explicitly included project files)
 * @param symlinkRoots - Set of symlinked paths (to prevent writing into project-owned areas)
 */
async function injectProfileOverlay(
	tempDir: string,
	profileDir: string,
	includePatterns: string[],
	symlinkRoots: Set<string>,
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

		// Law 1: Early Exit - skip if not an allowed config file (allowlist approach)
		if (!isAllowedOverlayFile(relativePath)) continue

		// Law 1: Early Exit - skip if within a symlinked directory (project owns this area)
		if (isWithinSymlinkRoot(relativePath, symlinkRoots)) continue

		// Law 1: Early Exit - skip if user explicitly included the project version
		// This lets users keep project AGENTS.md by including it explicitly
		if (userExplicitlyIncluded(relativePath, compiledIncludePatterns)) continue

		// Law 1: Early Exit - skip directories, files create their parents
		if (entry.isDirectory()) continue

		const destPath = path.join(tempDir, relativePath)

		// Law 1: Early Exit - skip if file already exists (symlink or real file from project)
		// This is a safety net in case symlinkRoots doesn't cover all cases
		if (existsSync(destPath)) continue

		// Ensure parent directory exists and copy file
		await mkdir(path.dirname(destPath), { recursive: true })
		await copyFile(path.join(entry.parentPath, entry.name), destPath)

		// Track normalized path for overlay exclusion
		injectedFiles.add(normalizePath(relativePath))
	}

	// Return immutable copy (Law 3: Atomic Predictability)
	return new Set(injectedFiles)
}

/**
 * OCX Worktree Plugin
 *
 * Creates isolated git worktrees for AI development sessions with
 * seamless terminal spawning across macOS, Windows, and Linux.
 *
 * Inspired by opencode-worktree-session by Felix Anhalt
 * https://github.com/felixAnhalt/opencode-worktree-session
 * License: MIT
 *
 * Rewritten for OCX with production-proven patterns.
 */

import type { Database } from "bun:sqlite"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { type Plugin, tool } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"

import { parse as parseJsonc } from "jsonc-parser"
import { z } from "zod"

import {
	addSession,
	clearPendingDelete,
	getPendingDelete,
	getSession,
	getWorktreePath,
	initStateDb,
	removeSession,
	setPendingDelete,
} from "./worktree/state"
import { openTerminal } from "./worktree/terminal"

/** Maximum retries for database initialization */
const DB_MAX_RETRIES = 3

/** Delay between retry attempts in milliseconds */
const DB_RETRY_DELAY_MS = 100

// =============================================================================
// TYPES & SCHEMAS
// =============================================================================

/** Result type for fallible operations */
interface OkResult<T> {
	readonly ok: true
	readonly value: T
}
interface ErrResult<E> {
	readonly ok: false
	readonly error: E
}
type Result<T, E> = OkResult<T> | ErrResult<E>

const Result = {
	ok: <T>(value: T): OkResult<T> => ({ ok: true, value }),
	err: <E>(error: E): ErrResult<E> => ({ ok: false, error }),
}

/**
 * Git branch name validation - blocks invalid refs and shell metacharacters
 * Characters blocked: control chars (0x00-0x1f, 0x7f), ~^:?*[]\\, and shell metacharacters
 */
function isValidBranchName(name: string): boolean {
	// Check for control characters
	for (let i = 0; i < name.length; i++) {
		const code = name.charCodeAt(i)
		if (code <= 0x1f || code === 0x7f) return false
	}
	// Check for invalid git ref characters and shell metacharacters
	if (/[~^:?*[\]\\;&|`$()]/.test(name)) return false
	return true
}

const branchNameSchema = z
	.string()
	.min(1, "Branch name cannot be empty")
	.refine((name) => !name.startsWith("-"), {
		message: "Branch name cannot start with '-' (prevents option injection)",
	})
	.refine((name) => !name.startsWith("/") && !name.endsWith("/"), {
		message: "Branch name cannot start or end with '/'",
	})
	.refine((name) => !name.includes("//"), {
		message: "Branch name cannot contain '//'",
	})
	.refine((name) => !name.includes("@{"), {
		message: "Branch name cannot contain '@{' (git reflog syntax)",
	})
	.refine((name) => !name.includes(".."), {
		message: "Branch name cannot contain '..'",
	})
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Control character detection is intentional for security
	.refine((name) => !/[\x00-\x1f\x7f ~^:?*[\]\\]/.test(name), {
		message: "Branch name contains invalid characters",
	})
	.max(255, "Branch name too long")
	.refine((name) => isValidBranchName(name), "Contains invalid git ref characters")
	.refine((name) => !name.startsWith(".") && !name.endsWith("."), "Cannot start or end with dot")
	.refine((name) => !name.endsWith(".lock"), "Cannot end with .lock")

/**
 * Worktree plugin configuration schema.
 * Config file: .opencode/worktree.jsonc
 */
const worktreeConfigSchema = z.object({
	sync: z
		.object({
			/** Files to copy from main worktree (relative paths only) */
			copyFiles: z.array(z.string()).default([]),
			/** Directories to symlink from main worktree (saves disk space) */
			symlinkDirs: z.array(z.string()).default([]),
			/** Patterns to exclude from copying (reserved for future use) */
			exclude: z.array(z.string()).default([]),
		})
		.default(() => ({ copyFiles: [], symlinkDirs: [], exclude: [] })),
	hooks: z
		.object({
			/** Commands to run after worktree creation */
			postCreate: z.array(z.string()).default([]),
			/** Commands to run before worktree deletion */
			preDelete: z.array(z.string()).default([]),
		})
		.default(() => ({ postCreate: [], preDelete: [] })),
})

type WorktreeConfig = z.infer<typeof worktreeConfigSchema>

// =============================================================================
// MODULE-LEVEL STATE
// =============================================================================

/** Database instance - initialized once per plugin lifecycle */
let db: Database | null = null

/** Project root path - stored on first initialization */
let projectRoot: string | null = null

/** Flag to prevent duplicate cleanup handler registration */
let cleanupRegistered = false

/**
 * Register process cleanup handlers for graceful database shutdown.
 * Ensures WAL checkpoint and proper close on process termination.
 *
 * NOTE: process.once() is an EventEmitter method that never throws.
 * The boolean guard is defense-in-depth for idempotency, not error recovery.
 *
 * @param database - The database instance to clean up
 */
function registerCleanupHandlers(database: Database): void {
	if (cleanupRegistered) return // Early exit guard
	cleanupRegistered = true

	const cleanup = () => {
		try {
			database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
			database.close()
		} catch {
			// Best effort cleanup - process is exiting anyway
		}
	}

	process.once("SIGTERM", cleanup)
	process.once("SIGINT", cleanup)
	process.once("beforeExit", cleanup)
}

/**
 * Get the database instance, initializing if needed.
 * Includes retry logic for transient initialization failures.
 *
 * @returns Database instance
 * @throws {Error} if initialization fails after all retries
 */
async function getDb(): Promise<Database> {
	if (db) return db

	if (!projectRoot) {
		throw new Error("Database not initialized: projectRoot not set. Call initDb() first.")
	}

	let lastError: Error | null = null

	for (let attempt = 1; attempt <= DB_MAX_RETRIES; attempt++) {
		try {
			db = await initStateDb(projectRoot)
			registerCleanupHandlers(db)
			return db
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error))
			console.warn(
				`Database init attempt ${attempt}/${DB_MAX_RETRIES} failed: ${lastError.message}`,
			)

			if (attempt < DB_MAX_RETRIES) {
				Bun.sleepSync(DB_RETRY_DELAY_MS)
			}
		}
	}

	throw new Error(
		`Failed to initialize database after ${DB_MAX_RETRIES} attempts: ${lastError?.message}`,
	)
}

/**
 * Initialize the database with the project root path.
 * Must be called once before any getDb() calls.
 */
async function initDb(root: string): Promise<Database> {
	projectRoot = root
	return getDb()
}

// =============================================================================
// GIT MODULE
// =============================================================================

/**
 * Execute a git command safely using Bun.spawn with explicit array.
 * Avoids shell interpolation entirely by passing args as array.
 */
async function git(args: string[], cwd: string): Promise<Result<string, string>> {
	try {
		const proc = Bun.spawn(["git", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		})
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		])
		if (exitCode !== 0) {
			return Result.err(stderr.trim() || `git ${args[0]} failed`)
		}
		return Result.ok(stdout.trim())
	} catch (error) {
		return Result.err(error instanceof Error ? error.message : String(error))
	}
}

async function branchExists(cwd: string, branch: string): Promise<boolean> {
	const result = await git(["rev-parse", "--verify", branch], cwd)
	return result.ok
}

async function createWorktree(
	repoRoot: string,
	branch: string,
	baseBranch?: string,
): Promise<Result<string, string>> {
	const worktreePath = await getWorktreePath(repoRoot, branch)

	// Ensure parent directory exists
	await fs.mkdir(path.dirname(worktreePath), { recursive: true })

	const exists = await branchExists(repoRoot, branch)

	if (exists) {
		// Checkout existing branch into worktree
		const result = await git(["worktree", "add", worktreePath, branch], repoRoot)
		return result.ok ? Result.ok(worktreePath) : result
	} else {
		// Create new branch from base
		const base = baseBranch ?? "HEAD"
		const result = await git(["worktree", "add", "-b", branch, worktreePath, base], repoRoot)
		return result.ok ? Result.ok(worktreePath) : result
	}
}

async function removeWorktree(
	repoRoot: string,
	worktreePath: string,
): Promise<Result<void, string>> {
	const result = await git(["worktree", "remove", "--force", worktreePath], repoRoot)
	return result.ok ? Result.ok(undefined) : Result.err(result.error)
}

// =============================================================================
// FILE SYNC MODULE
// =============================================================================

/**
 * Validate that a path is safe (no escape from base directory)
 */
function isPathSafe(filePath: string, baseDir: string): boolean {
	// Reject absolute paths
	if (path.isAbsolute(filePath)) {
		console.warn(`[worktree] Rejected absolute path: ${filePath}`)
		return false
	}
	// Reject obvious path traversal
	if (filePath.includes("..")) {
		console.warn(`[worktree] Rejected path traversal: ${filePath}`)
		return false
	}
	// Verify resolved path stays within base directory
	const resolved = path.resolve(baseDir, filePath)
	if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
		console.warn(`[worktree] Path escapes base directory: ${filePath}`)
		return false
	}
	return true
}

/**
 * Copy files from source directory to target directory.
 * Skips missing files silently (production pattern).
 */
async function copyFiles(sourceDir: string, targetDir: string, files: string[]): Promise<void> {
	for (const file of files) {
		if (!isPathSafe(file, sourceDir)) continue

		const sourcePath = path.join(sourceDir, file)
		const targetPath = path.join(targetDir, file)

		try {
			const sourceFile = Bun.file(sourcePath)
			if (!(await sourceFile.exists())) {
				console.debug(`[worktree] Skipping missing file: ${file}`)
				continue
			}

			// Ensure target directory exists
			const targetFileDir = path.dirname(targetPath)
			await fs.mkdir(targetFileDir, { recursive: true })

			// Copy file
			await Bun.write(targetPath, sourceFile)
			console.log(`[worktree] Copied: ${file}`)
		} catch (error) {
			const isNotFound =
				error instanceof Error &&
				(error.message.includes("ENOENT") || error.message.includes("no such file"))
			if (isNotFound) {
				console.debug(`[worktree] Skipping missing: ${file}`)
			} else {
				console.warn(`[worktree] Failed to copy ${file}: ${error}`)
			}
		}
	}
}

/**
 * Create symlinks for directories from source to target.
 * Uses absolute paths for symlink targets.
 */
async function symlinkDirs(sourceDir: string, targetDir: string, dirs: string[]): Promise<void> {
	for (const dir of dirs) {
		if (!isPathSafe(dir, sourceDir)) continue

		const sourcePath = path.join(sourceDir, dir)
		const targetPath = path.join(targetDir, dir)

		try {
			// Check if source directory exists
			const stat = await fs.stat(sourcePath).catch(() => null)
			if (!stat || !stat.isDirectory()) {
				console.debug(`[worktree] Skipping missing directory: ${dir}`)
				continue
			}

			// Ensure parent directory exists
			const targetParentDir = path.dirname(targetPath)
			await fs.mkdir(targetParentDir, { recursive: true })

			// Remove existing target if it exists (might be empty dir from git)
			await fs.rm(targetPath, { recursive: true, force: true })

			// Create symlink (use absolute path for source)
			await fs.symlink(sourcePath, targetPath, "dir")
			console.log(`[worktree] Symlinked: ${dir}`)
		} catch (error) {
			console.warn(`[worktree] Failed to symlink ${dir}: ${error}`)
		}
	}
}

/**
 * Run hook commands in the worktree directory.
 */
async function runHooks(cwd: string, commands: string[]): Promise<void> {
	for (const command of commands) {
		console.log(`[worktree] Running hook: ${command}`)
		try {
			// Use shell to properly handle quoted arguments and complex commands
			const result = Bun.spawnSync(["bash", "-c", command], {
				cwd,
				stdout: "inherit",
				stderr: "pipe",
			})
			if (result.exitCode !== 0) {
				const stderr = result.stderr?.toString() || ""
				console.warn(
					`[worktree] Hook failed (exit ${result.exitCode}): ${command}${stderr ? `\n${stderr}` : ""}`,
				)
			}
		} catch (error) {
			console.warn(`[worktree] Hook error: ${error}`)
		}
	}
}

/**
 * Load worktree-specific configuration from .opencode/worktree.jsonc
 * Auto-creates config file with helpful defaults if it doesn't exist.
 */
async function loadWorktreeConfig(directory: string): Promise<WorktreeConfig> {
	const configPath = path.join(directory, ".opencode", "worktree.jsonc")

	try {
		const file = Bun.file(configPath)
		if (!(await file.exists())) {
			// Auto-create config with helpful defaults and comments
			const defaultConfig = `{
  "$schema": "https://registry.kdco.dev/schemas/worktree.json",

  // Worktree plugin configuration
  // Documentation: https://github.com/kdcokenny/ocx

  "sync": {
    // Files to copy from main worktree to new worktrees
    // Example: [".env", ".env.local", "dev.sqlite"]
    "copyFiles": [],

    // Directories to symlink (saves disk space)
    // Example: ["node_modules"]
    "symlinkDirs": [],

    // Patterns to exclude from copying
    "exclude": []
  },

  "hooks": {
    // Commands to run after worktree creation
    // Example: ["pnpm install", "docker compose up -d"]
    "postCreate": [],

    // Commands to run before worktree deletion
    // Example: ["docker compose down"]
    "preDelete": []
  }
}
`
			// Ensure .opencode directory exists
			await fs.mkdir(path.join(directory, ".opencode"), { recursive: true })
			await Bun.write(configPath, defaultConfig)
			console.log(`[worktree] Created default config: ${configPath}`)
			return worktreeConfigSchema.parse({})
		}

		const content = await file.text()
		// Use proper JSONC parser (handles comments in strings correctly)
		const parsed = parseJsonc(content)
		if (parsed === undefined) {
			console.error(`[worktree] Invalid worktree.jsonc syntax`)
			return worktreeConfigSchema.parse({})
		}
		return worktreeConfigSchema.parse(parsed)
	} catch (error) {
		console.warn(`[worktree] Failed to load config: ${error}`)
		return worktreeConfigSchema.parse({})
	}
}

// =============================================================================
// PLUGIN ENTRY
// =============================================================================

export const WorktreePlugin: Plugin = async (ctx) => {
	const { directory } = ctx

	// Initialize SQLite database
	const database = await initDb(directory)

	return {
		tool: {
			worktree_create: tool({
				description:
					"Create a new git worktree for isolated development. A new terminal will open with OpenCode in the worktree.",
				args: {
					branch: tool.schema
						.string()
						.describe("Branch name for the worktree (e.g., 'feature/dark-mode')"),
					baseBranch: tool.schema
						.string()
						.optional()
						.describe("Base branch to create from (defaults to HEAD)"),
				},
				async execute(args, toolCtx) {
					// Validate branch name at boundary
					const branchResult = branchNameSchema.safeParse(args.branch)
					if (!branchResult.success) {
						return `❌ Invalid branch name: ${branchResult.error.issues[0]?.message}`
					}

					// Validate base branch name at boundary
					if (args.baseBranch) {
						const baseResult = branchNameSchema.safeParse(args.baseBranch)
						if (!baseResult.success) {
							return `❌ Invalid base branch name: ${baseResult.error.issues[0]?.message}`
						}
					}

					// Create worktree
					const result = await createWorktree(directory, args.branch, args.baseBranch)
					if (!result.ok) {
						return `Failed to create worktree: ${result.error}`
					}

					const worktreePath = result.value

					// Sync files from main worktree
					const worktreeConfig = await loadWorktreeConfig(directory)
					const mainWorktreePath = directory // The repo root is the main worktree

					// Copy files
					if (worktreeConfig.sync.copyFiles.length > 0) {
						await copyFiles(mainWorktreePath, worktreePath, worktreeConfig.sync.copyFiles)
					}

					// Symlink directories
					if (worktreeConfig.sync.symlinkDirs.length > 0) {
						await symlinkDirs(mainWorktreePath, worktreePath, worktreeConfig.sync.symlinkDirs)
					}

					// Run postCreate hooks
					if (worktreeConfig.hooks.postCreate.length > 0) {
						await runHooks(worktreePath, worktreeConfig.hooks.postCreate)
					}

					const sessionId = toolCtx?.sessionID ?? "unknown"

					// Spawn terminal IMMEDIATELY (not deferred - avoids race conditions)
					const terminalResult = await openTerminal(
						worktreePath,
						`opencode --session ${sessionId}`,
						args.branch,
					)

					if (!terminalResult.success) {
						console.warn(`[worktree] Failed to open terminal: ${terminalResult.error}`)
					}

					// Record session for tracking (used by delete flow)
					addSession(database, {
						id: sessionId,
						branch: args.branch,
						path: worktreePath,
						createdAt: new Date().toISOString(),
					})

					return `Worktree created at ${worktreePath}\n\nA new terminal has been opened with OpenCode.`
				},
			}),

			worktree_delete: tool({
				description:
					"Delete the current worktree and clean up. Changes will be committed before removal.",
				args: {
					reason: tool.schema
						.string()
						.describe("Brief explanation of why you are calling this tool"),
				},
				async execute(_args, toolCtx) {
					// Find current session's worktree
					const session = getSession(database, toolCtx?.sessionID ?? "")
					if (!session) {
						return `No worktree associated with this session`
					}

					// Set pending delete for session.idle (atomic operation)
					setPendingDelete(database, { branch: session.branch, path: session.path })

					return `Worktree marked for cleanup. It will be removed when this session ends.`
				},
			}),
		},

		event: async ({ event }: { event: Event }): Promise<void> => {
			if (event.type !== "session.idle") return

			// Handle pending delete
			const pendingDelete = getPendingDelete(database)
			if (pendingDelete) {
				const { path: worktreePath, branch } = pendingDelete

				// Run preDelete hooks before cleanup
				const config = await loadWorktreeConfig(directory)
				if (config.hooks.preDelete.length > 0) {
					await runHooks(worktreePath, config.hooks.preDelete)
				}

				// Commit any uncommitted changes
				const addResult = await git(["add", "-A"], worktreePath)
				if (!addResult.ok) console.warn(`[worktree] git add failed: ${addResult.error}`)

				const commitResult = await git(
					["commit", "-m", "chore(worktree): session snapshot", "--allow-empty"],
					worktreePath,
				)
				if (!commitResult.ok) console.warn(`[worktree] git commit failed: ${commitResult.error}`)

				// Remove worktree
				const removeResult = await removeWorktree(directory, worktreePath)
				if (!removeResult.ok) {
					console.warn(`[worktree] Failed to remove worktree: ${removeResult.error}`)
				}

				// Clear pending delete atomically
				clearPendingDelete(database)

				// Remove session from database
				removeSession(database, branch)
			}
		},
	}
}

export default WorktreePlugin

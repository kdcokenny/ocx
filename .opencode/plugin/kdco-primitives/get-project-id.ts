/**
 * Project ID generation for kdco registry plugins.
 *
 * Generates a stable, unique identifier for a project based on its git history.
 * Used for cross-worktree consistency in delegation storage, state databases,
 * and other plugin data that should be shared across worktrees.
 *
 * @module kdco-primitives/get-project-id
 */

import * as crypto from "node:crypto"
import { stat } from "node:fs/promises"
import * as path from "node:path"
import { logWarn } from "./log-warn"
import type { OpencodeClient } from "./types"
import { TimeoutError, withTimeout } from "./with-timeout"

/**
 * Generate a short hash from a path for project ID fallback.
 *
 * Used when git root commit is unavailable (non-git repos, empty repos).
 * Produces a 16-character hex string for reasonable uniqueness.
 *
 * @param projectRoot - Absolute path to hash
 * @returns 16-char hex hash
 */
function hashPath(projectRoot: string): string {
	const hash = crypto.createHash("sha256").update(projectRoot).digest("hex")
	return hash.slice(0, 16)
}

/**
 * Generate a unique project ID from the project root path.
 *
 * **Strategy:**
 * 1. Uses the first root commit SHA for stability across renames/moves
 * 2. Falls back to path hash for non-git repos or empty repos
 * 3. Caches result in .git/opencode for performance
 *
 * **Git Worktree Support:**
 * When .git is a file (worktree), resolves the actual .git directory
 * and uses the shared cache. This ensures all worktrees share the same
 * project ID and associated data.
 *
 * @param projectRoot - Absolute path to the project root
 * @param client - Optional OpenCode client for logging warnings
 * @returns 40-char hex SHA (git root) or 16-char hash (fallback)
 * @throws {Error} When projectRoot is invalid or .git file has invalid format
 *
 * @example
 * ```ts
 * const projectId = await getProjectId("/home/user/my-repo")
 * // Returns: "abc123..." (40-char git hash)
 *
 * const projectId = await getProjectId("/home/user/non-git-folder")
 * // Returns: "def456..." (16-char path hash)
 * ```
 */
export async function getProjectId(projectRoot: string, client?: OpencodeClient): Promise<string> {
	// Guard: Validate projectRoot (Law 1: Early Exit, Law 4: Fail Fast)
	if (!projectRoot || typeof projectRoot !== "string") {
		throw new Error("getProjectId: projectRoot is required and must be a string")
	}

	const gitPath = path.join(projectRoot, ".git")

	// Check if .git exists and what type it is
	const gitStat = await stat(gitPath).catch(() => null)

	// Guard: No .git directory - not a git repo (Law 1: Early Exit)
	if (!gitStat) {
		logWarn(client, "project-id", `No .git found at ${projectRoot}, using path hash`)
		return hashPath(projectRoot)
	}

	let gitDir = gitPath

	// Handle worktree case: .git is a file containing gitdir reference
	if (gitStat.isFile()) {
		const content = await Bun.file(gitPath).text()
		const match = content.match(/^gitdir:\s*(.+)$/m)

		// Guard: Invalid .git file format (Law 4: Fail Fast)
		if (!match) {
			throw new Error(`getProjectId: .git file exists but has invalid format at ${gitPath}`)
		}

		// Resolve path (handles both relative and absolute)
		const gitdirPath = match[1].trim()
		const resolvedGitdir = path.resolve(projectRoot, gitdirPath)

		// The gitdir contains a 'commondir' file pointing to shared .git
		const commondirPath = path.join(resolvedGitdir, "commondir")
		const commondirFile = Bun.file(commondirPath)

		if (await commondirFile.exists()) {
			const commondirContent = (await commondirFile.text()).trim()
			gitDir = path.resolve(resolvedGitdir, commondirContent)
		} else {
			// Fallback to ../.. assumption for older git or unusual setups
			gitDir = path.resolve(resolvedGitdir, "../..")
		}

		// Guard: Resolved gitdir must be a directory (Law 4: Fail Fast)
		const gitDirStat = await stat(gitDir).catch(() => null)
		if (!gitDirStat?.isDirectory()) {
			throw new Error(`getProjectId: Resolved gitdir ${gitDir} is not a directory`)
		}
	}

	// Check cache in .git/opencode
	const cacheFile = path.join(gitDir, "opencode")
	const cache = Bun.file(cacheFile)

	if (await cache.exists()) {
		const cached = (await cache.text()).trim()
		// Validate cache content (40-char hex for git hash, or 16-char for path hash)
		if (/^[a-f0-9]{40}$/i.test(cached) || /^[a-f0-9]{16}$/i.test(cached)) {
			return cached
		}
		logWarn(client, "project-id", `Invalid cache content at ${cacheFile}, regenerating`)
	}

	// Generate project ID from git root commit
	try {
		const proc = Bun.spawn(["git", "rev-list", "--max-parents=0", "--all"], {
			cwd: projectRoot,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
		})

		// 5 second timeout to prevent hangs on network filesystems
		const timeoutMs = 5000
		const exitCode = await withTimeout(proc.exited, timeoutMs, `git rev-list timed out`).catch(
			(e) => {
				if (e instanceof TimeoutError) {
					proc.kill()
				}
				return 1 // Treat timeout/errors as failure, fall back to path hash
			},
		)

		if (exitCode === 0) {
			const output = await new Response(proc.stdout).text()
			const roots = output
				.split("\n")
				.filter(Boolean)
				.map((x) => x.trim())
				.sort()

			if (roots.length > 0 && /^[a-f0-9]{40}$/i.test(roots[0])) {
				const projectId = roots[0]
				// Cache the result
				try {
					await Bun.write(cacheFile, projectId)
				} catch (e) {
					logWarn(client, "project-id", `Failed to cache project ID: ${e}`)
				}
				return projectId
			}
		} else {
			const stderr = await new Response(proc.stderr).text()
			logWarn(client, "project-id", `git rev-list failed (${exitCode}): ${stderr.trim()}`)
		}
	} catch (error) {
		logWarn(client, "project-id", `git command failed: ${error}`)
	}

	// Fallback to path hash
	return hashPath(projectRoot)
}

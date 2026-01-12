// packages/cli/src/utils/file-sync.ts
// Real-time file sync for Ghost Mode
// Based on patterns from chokidar, VSCode, and watchpack research

import { existsSync, lstatSync, mkdirSync, readFileSync, rmdirSync, unlinkSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import chokidar from "chokidar"
import ignore, { type Ignore } from "ignore"

// Minimal OS junk - always excluded (can appear when browsing temp dir in Finder/Explorer)
const OS_JUNK = [/\.DS_Store$/, /Thumbs\.db$/]

/**
 * Load .gitignore patterns from the PROJECT directory (not temp dir).
 * The temp dir is a symlink farm - the real .gitignore lives in the project.
 *
 * Handles negation patterns (!pattern) correctly via the `ignore` package.
 *
 * @param projectDir - The real project directory containing .gitignore
 * @returns Ignore instance for checking paths
 */
function loadGitignore(projectDir: string): Ignore {
	const ig = ignore()
	const gitignorePath = join(projectDir, ".gitignore")

	try {
		if (existsSync(gitignorePath)) {
			ig.add(readFileSync(gitignorePath, "utf8"))
		}
		// No .gitignore file is fine - just use empty ignore (only OS_JUNK will be excluded)
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code
		// Permission errors should be warned about (Law 4: Fail Loud)
		if (code !== "ENOENT") {
			console.warn(`Warning: Could not read .gitignore: ${(err as Error).message}`)
		}
		// Return empty ignore - still works, just no gitignore patterns
	}

	return ig
}

/**
 * Normalize path for consistent Set operations.
 * Handles trailing slashes and path separators.
 */
export function normalizePath(p: string): string {
	return p.replace(/\\/g, "/").replace(/\/$/, "")
}

/**
 * Check if a path is a symlink.
 * MUST use lstatSync, NEVER statSync (which follows symlinks).
 */
function isSymlink(filePath: string): boolean {
	try {
		return lstatSync(filePath).isSymbolicLink()
	} catch (err) {
		// File doesn't exist - not a symlink
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return false
		// Unexpected error - fail loud (Law 4)
		throw err
	}
}

/**
 * Check if a path should be excluded from syncing.
 *
 * Exclusion sources:
 * 1. OS junk files (.DS_Store, Thumbs.db) - always excluded
 * 2. .gitignore patterns from project - respects negation (!pattern)
 */
function isExcluded(relativePath: string, gitignore: Ignore): boolean {
	// Empty path = root dir - DON'T exclude or chokidar won't watch contents
	if (!relativePath) return false
	// OS junk - always excluded (fast regex check first)
	if (OS_JUNK.some((p) => p.test(relativePath))) return true
	// Gitignore patterns (handles negation correctly)
	if (gitignore.ignores(relativePath)) return true
	return false
}

/**
 * Copy a file to destination, creating parent directories as needed.
 * Uses Bun.write for atomic copy.
 */
async function syncFile(src: string, dest: string): Promise<void> {
	mkdirSync(dirname(dest), { recursive: true })
	await Bun.write(dest, Bun.file(src))
}

/**
 * Delete a file from destination.
 * Handles ENOENT gracefully (file already deleted).
 */
function syncDelete(dest: string): void {
	try {
		unlinkSync(dest)
	} catch (err) {
		// File already deleted - fine
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
	}
}

/**
 * Handle returned by createFileSync for cleanup and status.
 */
export interface FileSyncHandle {
	/** Close the watcher and stop syncing */
	close: () => Promise<void>
	/** Get list of files that failed to sync */
	getFailures: () => Array<{ path: string; error: Error }>
	/** Get count of successfully synced files */
	getSyncCount: () => number
}

/** Options for file sync behavior */
export interface FileSyncOptions {
	/**
	 * Paths injected from profile overlay. These are never synced back to the project.
	 * Paths should be normalized (forward slashes). Empty or undefined = sync all new files.
	 */
	overlayFiles?: Set<string>
}

/**
 * Create a real-time file sync watcher.
 * Watches tempDir for new files and syncs them to projectDir.
 * Only syncs non-symlink files (symlinks point to real project already).
 * Tracks synced files to safely handle deletions.
 *
 * @param tempDir - The symlink farm temp directory to watch
 * @param projectDir - The real project directory to sync to
 * @param options - Optional configuration for sync behavior
 * @returns FileSyncHandle for cleanup and status
 */
export function createFileSync(
	tempDir: string,
	projectDir: string,
	options?: FileSyncOptions,
): FileSyncHandle {
	const failures: Array<{ path: string; error: Error }> = []
	const syncedFiles = new Set<string>() // Track normalized paths of files WE created

	// Load gitignore from PROJECT dir (not temp dir - temp is symlink farm)
	const gitignore = loadGitignore(projectDir)

	// Chokidar config based on research
	// followSymlinks: false is CRITICAL - don't follow symlinks
	// awaitWriteFinish with 200ms stabilityThreshold (per watchpack pattern)
	const isCI = process.env.CI === "true"
	const watcher = chokidar.watch(tempDir, {
		followSymlinks: false,
		ignoreInitial: true,
		usePolling: isCI,
		interval: 100,
		awaitWriteFinish: {
			stabilityThreshold: 200,
			pollInterval: 50,
		},
		ignored: (filePath) => {
			const relativePath = normalizePath(relative(tempDir, filePath))
			// Check overlay files FIRST - prevents race condition with awaitWriteFinish
			if (options?.overlayFiles?.has(relativePath)) return true
			return isExcluded(relativePath, gitignore)
		},
	})

	// Watcher error handler - captures EMFILE, permission errors, etc.
	watcher.on("error", (err) => {
		failures.push({ path: "<watcher>", error: err as Error })
	})

	const handleAdd = async (filePath: string) => {
		if (isSymlink(filePath)) return // Skip symlinks - they point to real project
		const relativePath = relative(tempDir, filePath)
		const normalizedPath = normalizePath(relativePath)
		if (options?.overlayFiles?.has(normalizedPath)) return // Skip - overlay file from profile
		const destPath = join(projectDir, relativePath)
		try {
			await syncFile(filePath, destPath)
			syncedFiles.add(normalizedPath) // Track for safe deletion
		} catch (err) {
			failures.push({ path: relativePath, error: err as Error })
		}
	}

	const handleChange = async (filePath: string) => {
		if (isSymlink(filePath)) return
		const relativePath = relative(tempDir, filePath)
		const normalizedPath = normalizePath(relativePath)
		if (options?.overlayFiles?.has(normalizedPath)) return // Skip - overlay file from profile
		const destPath = join(projectDir, relativePath)
		try {
			await syncFile(filePath, destPath)
			// Note: Don't add to syncedFiles on change - already tracked from add
		} catch (err) {
			failures.push({ path: relativePath, error: err as Error })
		}
	}

	const handleUnlink = async (filePath: string) => {
		const relativePath = relative(tempDir, filePath)
		const normalizedPath = normalizePath(relativePath)
		// Safety check: Only delete if WE synced this file
		if (!syncedFiles.has(normalizedPath)) return
		const destPath = join(projectDir, relativePath)
		try {
			syncDelete(destPath)
			syncedFiles.delete(normalizedPath)
		} catch (err) {
			failures.push({ path: relativePath, error: err as Error })
		}
	}

	const handleAddDir = (dirPath: string) => {
		if (isSymlink(dirPath)) return
		const relativePath = relative(tempDir, dirPath)
		try {
			mkdirSync(join(projectDir, relativePath), { recursive: true })
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
				failures.push({ path: relativePath, error: err as Error })
			}
		}
	}

	// Directory deletion - only delete if empty, surface unexpected errors (Law 4)
	// Only catch ENOENT and ENOTEMPTY as expected errors
	const handleUnlinkDir = (dirPath: string) => {
		const relativePath = relative(tempDir, dirPath)
		const destPath = join(projectDir, relativePath)
		try {
			rmdirSync(destPath) // Only succeeds if empty
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code
			// Expected errors: directory doesn't exist or not empty
			if (code !== "ENOENT" && code !== "ENOTEMPTY") {
				failures.push({ path: relativePath, error: err as Error })
			}
		}
	}

	watcher.on("add", handleAdd)
	watcher.on("change", handleChange)
	watcher.on("unlink", handleUnlink)
	watcher.on("addDir", handleAddDir)
	watcher.on("unlinkDir", handleUnlinkDir)

	return {
		close: async () => {
			await watcher.close()
		},
		getFailures: () => [...failures],
		getSyncCount: () => syncedFiles.size,
	}
}

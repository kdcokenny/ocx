/**
 * Symlink Farm Utility
 *
 * Creates a temporary directory with symlinks to project files,
 * filtered by include/exclude patterns. Used by ghost mode to isolate
 * from project-level OpenCode configuration.
 */

import { randomBytes } from "node:crypto"
import { mkdir, readdir, rename, rm, stat, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative } from "node:path"
import { FileLimitExceededError } from "./errors"
import { createPathMatcher, normalizeForMatching, type PathMatcher } from "./pattern-filter"

/**
 * Pre-computed symlink plan - parsed once, executed without re-evaluation.
 * Makes illegal states unrepresentable (Law 2: Parse Don't Validate).
 */
export interface SymlinkPlan {
	/** Directories to symlink as-is (full inclusion) */
	wholeDirs: string[]
	/** Individual files to symlink */
	files: string[]
	/** Directories needing partial expansion - recursive structure */
	partialDirs: Map<string, SymlinkPlan>
}

/** Age threshold for stale ghost sessions (24 hours) */
const STALE_SESSION_THRESHOLD_MS = 24 * 60 * 60 * 1000

/** Age threshold for interrupted deletions (1 hour) */
const REMOVING_THRESHOLD_MS = 60 * 60 * 1000

/** Prefix for ghost temp directories */
export const GHOST_DIR_PREFIX = "ocx-ghost-"

/** Suffix for directories being removed */
export const REMOVING_SUFFIX = "-removing"

/** Marker file to identify ghost temp directories */
export const GHOST_MARKER_FILE = ".ocx-ghost-marker"

/**
 * Mutable state passed through recursive traversal.
 * Tracks total entries processed for file limit enforcement.
 */
type TraversalState = { count: number }

/**
 * Creates a temporary directory with symlinks to the source directory contents,
 * respecting include/exclude patterns for filtering.
 *
 * Uses plan-based approach: compute plan first, then execute.
 * This separates decision logic from I/O for testability and clarity.
 *
 * @param sourceDir - The source directory to create symlinks from
 * @param options - Optional include/exclude patterns for fine-grained control
 * @returns Path to the temporary directory containing symlinks
 */
export async function createSymlinkFarm(
	sourceDir: string,
	options?: {
		includePatterns?: string[]
		excludePatterns?: string[]
		maxFiles?: number
	},
): Promise<string> {
	// Guard: sourceDir must be absolute (Law 1: Early Exit)
	if (!isAbsolute(sourceDir)) {
		throw new Error(`sourceDir must be an absolute path, got: ${sourceDir}`)
	}

	const suffix = randomBytes(4).toString("hex")
	const tempDir = join(tmpdir(), `${GHOST_DIR_PREFIX}${suffix}`)

	// Create temp directory manually (mkdtemp adds random suffix, we already have one)
	await Bun.write(join(tempDir, GHOST_MARKER_FILE), "")

	try {
		// Create PathMatcher once with patterns (Law 2: Parse at boundary)
		const matcher = createPathMatcher(
			options?.includePatterns ?? [],
			options?.excludePatterns ?? [],
		)

		// Initialize traversal state for file limit tracking
		const maxFiles = options?.maxFiles ?? 10000
		const state: TraversalState = { count: 0 }

		// Compute plan (decision phase - pure logic)
		const plan = await computeSymlinkPlan(sourceDir, sourceDir, matcher, state, maxFiles)

		// Execute plan (I/O phase - creates symlinks)
		await executeSymlinkPlan(plan, sourceDir, tempDir)

		return tempDir
	} catch (error) {
		// Cleanup on failure (Law 4: Fail Fast)
		await rm(tempDir, { recursive: true, force: true }).catch(() => {})
		throw error
	}
}

/**
 * Inject files from a source directory into an existing symlink farm.
 * Used by ghost mode to add ghost config files after farm creation.
 *
 * @param tempDir - The symlink farm directory
 * @param sourceDir - Directory containing files to inject (e.g., ~/.config/ocx/)
 * @param injectPaths - Set of absolute paths to inject
 */
export async function injectGhostFiles(
	tempDir: string,
	sourceDir: string,
	injectPaths: Set<string>,
): Promise<void> {
	// Guard: Validate paths (Law 1: Early Exit)
	if (!isAbsolute(tempDir)) {
		throw new Error(`tempDir must be an absolute path, got: ${tempDir}`)
	}
	if (!isAbsolute(sourceDir)) {
		throw new Error(`sourceDir must be an absolute path, got: ${sourceDir}`)
	}

	for (const injectPath of injectPaths) {
		// Compute relative path from sourceDir
		const relativePath = relative(sourceDir, injectPath)

		// Guard: injectPath must be within sourceDir (Law 1: Early Exit)
		if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
			throw new Error(`injectPath must be within sourceDir: ${injectPath}`)
		}

		const targetPath = join(tempDir, relativePath)

		// Ensure parent directory exists
		const parentDir = dirname(targetPath)
		if (parentDir !== tempDir) {
			await mkdir(parentDir, { recursive: true })
		}

		// Create symlink (skip if already exists - defensive)
		try {
			await symlink(injectPath, targetPath)
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
				throw new Error(`Failed to inject ${injectPath} → ${targetPath}: ${(err as Error).message}`)
			}
		}
	}
}

/**
 * Clean up a symlink farm temp directory using rename-to-removing pattern.
 * This pattern ensures SIGKILL resilience: if the process dies mid-deletion,
 * the -removing directory will be cleaned up on next startup.
 *
 * @param tempDir - Path to the temp directory to remove
 */
export async function cleanupSymlinkFarm(tempDir: string): Promise<void> {
	const removingPath = `${tempDir}${REMOVING_SUFFIX}`

	try {
		await rename(tempDir, removingPath)
	} catch {
		// Directory may already be gone or renamed - that's fine
		return
	}

	await rm(removingPath, { recursive: true, force: true })
}

/**
 * Cleans up orphaned ghost temp directories from interrupted sessions.
 * Uses rename-to-removing pattern for SIGKILL resilience.
 *
 * Scans for:
 * - Directories ending in `-removing` (interrupted deletions, 1 hour threshold)
 * - Directories matching `ocx-ghost-*` (stale sessions, 24 hour threshold)
 *
 * @param tempBase - Base temp directory to scan (defaults to system tmpdir)
 * @returns Count of cleaned directories
 */
export async function cleanupOrphanedGhostDirs(tempBase: string = tmpdir()): Promise<number> {
	let cleanedCount = 0

	// Guard: tempBase must be absolute (Law 1: Early Exit)
	if (!isAbsolute(tempBase)) {
		throw new Error(`tempBase must be an absolute path, got: ${tempBase}`)
	}

	let dirNames: string[]
	try {
		dirNames = await readdir(tempBase)
	} catch {
		// Can't read temp dir - nothing to clean
		return 0
	}

	for (const dirName of dirNames) {
		const dirPath = join(tempBase, dirName)

		// Check for interrupted deletions (ends with -removing)
		const isRemovingDir = dirName.endsWith(REMOVING_SUFFIX)
		const isGhostDir = dirName.startsWith(GHOST_DIR_PREFIX) && !isRemovingDir

		// Skip unrelated entries (Law 1: Early Exit)
		if (!isRemovingDir && !isGhostDir) continue

		// Check if it's a directory and get stats
		let stats: Awaited<ReturnType<typeof stat>>
		try {
			stats = await stat(dirPath)
		} catch {
			// Can't stat - skip this entry
			continue
		}

		// Skip non-directories (Law 1: Early Exit)
		if (!stats.isDirectory()) continue

		// Determine threshold based on directory type
		const threshold = isRemovingDir ? REMOVING_THRESHOLD_MS : STALE_SESSION_THRESHOLD_MS
		const ageMs = Date.now() - stats.mtimeMs

		// Skip if not stale enough (Law 1: Early Exit)
		if (ageMs <= threshold) continue

		// Clean up the stale directory
		try {
			if (isGhostDir) {
				// Use rename-to-removing pattern for normal ghost dirs
				const removingPath = `${dirPath}${REMOVING_SUFFIX}`
				await rename(dirPath, removingPath)
				await rm(removingPath, { recursive: true, force: true })
			} else {
				// Already a -removing dir, just delete it
				await rm(dirPath, { recursive: true, force: true })
			}
			cleanedCount++
		} catch {
			// Best effort cleanup - continue with others
		}
	}

	return cleanedCount
}

/**
 * Compute symlink plan by walking source directory and applying pattern filters.
 * Pure function - no I/O side effects except reading directory.
 *
 * @param sourceDir - Current directory being processed (absolute path)
 * @param projectRoot - Root of the project (for normalizing paths)
 * @param matcher - Pre-compiled PathMatcher for efficient pattern matching
 * @returns Pre-computed symlink plan
 */
export async function computeSymlinkPlan(
	sourceDir: string,
	projectRoot: string,
	matcher: PathMatcher,
	state: TraversalState,
	maxFiles: number,
): Promise<SymlinkPlan> {
	// Guard: sourceDir must be absolute (Law 1: Early Exit)
	if (!isAbsolute(sourceDir)) {
		throw new Error(`sourceDir must be an absolute path, got: ${sourceDir}`)
	}

	const plan: SymlinkPlan = {
		wholeDirs: [],
		files: [],
		partialDirs: new Map(),
	}

	const entries = await readdir(sourceDir, { withFileTypes: true })

	// Count entries BEFORE filtering (fail-fast on massive directories)
	state.count += entries.length

	// Guard: Check file limit (0 = unlimited)
	if (maxFiles > 0 && state.count > maxFiles) {
		throw new FileLimitExceededError(state.count, maxFiles)
	}

	for (const entry of entries) {
		const sourcePath = join(sourceDir, entry.name)
		const relativePath = normalizeForMatching(sourcePath, projectRoot)

		// Law 1: Early Exit - check patterns FIRST for all paths
		const disposition = matcher.getDisposition(relativePath)

		if (disposition.type === "excluded") {
			continue // Skip this path entirely
		}

		if (disposition.type === "included") {
			// Fully included - symlink as-is
			if (entry.isDirectory()) {
				plan.wholeDirs.push(entry.name)
			} else {
				plan.files.push(entry.name)
			}
			continue
		}

		// disposition.type === "partial" - directory needs recursive expansion
		if (entry.isDirectory()) {
			const nestedPlan = await computeSymlinkPlan(sourcePath, projectRoot, matcher, state, maxFiles)
			plan.partialDirs.set(entry.name, nestedPlan)
		} else {
			// Files with "partial" disposition: when there are no include patterns,
			// this means we're in default exclude-only mode and the file should be included
			// (it wasn't matched by any exclude pattern, just marked partial due to directory
			// traversal optimization for nested excludes like **/AGENTS.md)
			plan.files.push(entry.name)
		}
	}

	return plan
}

/**
 * Execute a pre-computed symlink plan.
 * I/O phase - creates directories and symlinks.
 *
 * @param plan - Pre-computed symlink plan to execute
 * @param sourceRoot - Source directory (absolute path)
 * @param targetRoot - Target directory to create symlinks in (absolute path)
 */
export async function executeSymlinkPlan(
	plan: SymlinkPlan,
	sourceRoot: string,
	targetRoot: string,
): Promise<void> {
	// Guard: paths must be absolute (Law 1: Early Exit)
	if (!isAbsolute(sourceRoot)) {
		throw new Error(`sourceRoot must be an absolute path, got: ${sourceRoot}`)
	}
	if (!isAbsolute(targetRoot)) {
		throw new Error(`targetRoot must be an absolute path, got: ${targetRoot}`)
	}

	// Symlink all whole directories
	for (const dirName of plan.wholeDirs) {
		const sourcePath = join(sourceRoot, dirName)
		const targetPath = join(targetRoot, dirName)
		await symlink(sourcePath, targetPath)
	}

	// Symlink all files
	for (const fileName of plan.files) {
		const sourcePath = join(sourceRoot, fileName)
		const targetPath = join(targetRoot, fileName)
		await symlink(sourcePath, targetPath)
	}

	// Handle partial directories - create real directory and recurse
	for (const [dirName, nestedPlan] of plan.partialDirs) {
		const sourcePath = join(sourceRoot, dirName)
		const targetPath = join(targetRoot, dirName)

		// Create real directory (not symlink)
		await mkdir(targetPath, { recursive: true })

		// Recursively execute nested plan
		await executeSymlinkPlan(nestedPlan, sourcePath, targetPath)
	}
}

/**
 * OCX CLI - uninstall command
 * Remove OCX configuration files safely
 */

import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, unlinkSync } from "node:fs"
import path from "node:path"
import type { Command } from "commander"
import { findLocalConfigDir, getGlobalConfig, getProfilesDir } from "../profile/paths"
import { ValidationError } from "../utils/errors"
import { handleError, logger } from "../utils/index"

// =============================================================================
// EXIT CODES
// =============================================================================

/** Uninstall-specific exit codes */
const UNINSTALL_EXIT_CODES = {
	SUCCESS: 0,
	PARTIAL_FAILURE: 1,
	VALIDATION_ERROR: 2,
	SAFETY_ERROR: 3,
} as const

// =============================================================================
// TYPES
// =============================================================================

type UninstallScope = "global" | "local" | "all"

interface UninstallTarget {
	rootPath: string
	relativePath: string
	absolutePath: string
	displayPath: string
	kind: "file" | "directory" | "symlink"
	deleteIfEmpty: boolean
}

interface UninstallOptions {
	local?: boolean
	all?: boolean
	dryRun?: boolean
}

interface DeletionResult {
	target: UninstallTarget
	success: boolean
	skipped: boolean
	reason?: string
}

// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerUninstallCommand(program: Command): void {
	program
		.command("uninstall")
		.description("Remove OCX configuration files")
		.option("--local", "Remove local .opencode/ only")
		.option("--all", "Remove both global and local configs")
		.option("--dry-run", "Preview what would be removed")
		.action(async (options: UninstallOptions) => {
			try {
				await runUninstall(options)
			} catch (error) {
				handleError(error)
			}
		})
}

// =============================================================================
// MAIN COMMAND
// =============================================================================

async function runUninstall(options: UninstallOptions): Promise<void> {
	// Law 1: Early Exit - Parse flags at boundary
	const scope = parseScope(options)

	// Build targets based on scope
	const targets = buildTargets(scope)

	// Filter to only existing targets
	const existingTargets = targets.filter((t) => existsSync(t.absolutePath))

	// Early exit if nothing to remove
	if (existingTargets.length === 0) {
		logger.info("Nothing to remove")
		return
	}

	// Dry run mode - just show what would be removed
	if (options.dryRun) {
		printDryRun(existingTargets)
		return
	}

	// Print what we're about to remove
	printRemovalPlan(existingTargets)

	// Execute deletions with safety checks
	const results = executeRemovals(existingTargets)

	// Print results and exit with appropriate code
	printResults(results)
}

// =============================================================================
// FLAG PARSING
// =============================================================================

/**
 * Parse command flags into UninstallScope.
 * Law 2: Parse at boundary - validate once, trust internally.
 * @throws ValidationError if --local and --all are both set
 */
function parseScope(options: UninstallOptions): UninstallScope {
	const { local, all } = options

	// Guard: mutually exclusive flags
	if (local && all) {
		const error = new ValidationError("Cannot use --local and --all together")
		logger.error(error.message)
		process.exit(UNINSTALL_EXIT_CODES.VALIDATION_ERROR)
	}

	if (local) return "local"
	if (all) return "all"
	return "global"
}

// =============================================================================
// TARGET BUILDING
// =============================================================================

/**
 * Build list of targets based on scope.
 * Targets are constructed via path.join(root, relative) ONLY.
 */
function buildTargets(scope: UninstallScope): UninstallTarget[] {
	const targets: UninstallTarget[] = []

	if (scope === "global" || scope === "all") {
		targets.push(...buildGlobalTargets())
	}

	if (scope === "local" || scope === "all") {
		targets.push(...buildLocalTargets())
	}

	return targets
}

/**
 * Build global targets:
 * 1. profiles/ directory
 * 2. ocx.jsonc file
 * 3. Root dir ONLY IF EMPTY (marked with deleteIfEmpty)
 */
function buildGlobalTargets(): UninstallTarget[] {
	const globalConfigPath = getGlobalConfig()
	const globalConfigDir = path.dirname(globalConfigPath)

	// Root validation: must be a directory
	if (!validateRootDirectory(globalConfigDir)) {
		return []
	}

	const targets: UninstallTarget[] = []

	// 1. profiles/ directory
	const profilesDir = getProfilesDir()
	targets.push({
		rootPath: globalConfigDir,
		relativePath: "profiles",
		absolutePath: profilesDir,
		displayPath: tildify(profilesDir),
		kind: getPathKind(profilesDir),
		deleteIfEmpty: false,
	})

	// 2. ocx.jsonc file
	targets.push({
		rootPath: globalConfigDir,
		relativePath: "ocx.jsonc",
		absolutePath: globalConfigPath,
		displayPath: tildify(globalConfigPath),
		kind: getPathKind(globalConfigPath),
		deleteIfEmpty: false,
	})

	// 3. Root dir (only delete if empty after other deletions)
	targets.push({
		rootPath: globalConfigDir,
		relativePath: ".",
		absolutePath: globalConfigDir,
		displayPath: tildify(globalConfigDir),
		kind: "directory",
		deleteIfEmpty: true,
	})

	return targets
}

/**
 * Build local targets:
 * 1. .opencode/ directory (entire tree)
 * 2. ../ocx.jsonc relative to .opencode (legacy root-level config)
 * 3. ../ocx.lock relative to .opencode (legacy root-level lockfile)
 */
function buildLocalTargets(): UninstallTarget[] {
	const localConfigDir = findLocalConfigDir(process.cwd())

	if (!localConfigDir) {
		return []
	}

	// Root is parent of .opencode/
	const rootPath = path.dirname(localConfigDir)

	// Root validation: must be a directory
	if (!validateRootDirectory(rootPath)) {
		return []
	}

	const targets: UninstallTarget[] = []

	// 1. .opencode/ directory
	targets.push({
		rootPath,
		relativePath: ".opencode",
		absolutePath: localConfigDir,
		displayPath: localConfigDir,
		kind: getPathKind(localConfigDir),
		deleteIfEmpty: false,
	})

	// 2. Legacy ocx.jsonc at project root
	const legacyConfig = path.join(rootPath, "ocx.jsonc")
	targets.push({
		rootPath,
		relativePath: "ocx.jsonc",
		absolutePath: legacyConfig,
		displayPath: legacyConfig,
		kind: getPathKind(legacyConfig),
		deleteIfEmpty: false,
	})

	// 3. Legacy ocx.lock at project root
	const legacyLock = path.join(rootPath, "ocx.lock")
	targets.push({
		rootPath,
		relativePath: "ocx.lock",
		absolutePath: legacyLock,
		displayPath: legacyLock,
		kind: getPathKind(legacyLock),
		deleteIfEmpty: false,
	})

	return targets
}

// =============================================================================
// SAFETY CHECKS
// =============================================================================

/**
 * Validate that root is an existing directory (not symlink or file).
 */
function validateRootDirectory(rootPath: string): boolean {
	if (!existsSync(rootPath)) {
		return false
	}

	try {
		const stat = lstatSync(rootPath)
		// Must be a real directory, not a symlink
		return stat.isDirectory() && !stat.isSymbolicLink()
	} catch {
		return false
	}
}

/**
 * Check if target path is safely contained within root.
 * - Symlinks: lexical containment only
 * - Files/dirs: realpath containment
 * Law 4: Fail Fast - invalid state halts with descriptive error.
 */
function isPathContained(target: UninstallTarget): boolean {
	const { rootPath, absolutePath, kind } = target

	// For symlinks, use lexical containment only (don't follow)
	if (kind === "symlink") {
		return isPathInsideRoot(rootPath, absolutePath)
	}

	// For files and directories, check realpath containment
	try {
		const realRoot = realpathSync(rootPath)
		const realTarget = realpathSync(absolutePath)
		return isPathInsideRoot(realRoot, realTarget)
	} catch {
		// If we can't resolve realpath, fall back to lexical check
		return isPathInsideRoot(rootPath, absolutePath)
	}
}

/**
 * Get relative path if child is inside or equal to parent.
 * Returns null if child escapes parent boundary.
 */
function getRelativeIfContained(parent: string, child: string): string | null {
	const normalizedParent = path.resolve(parent)
	const normalizedChild = path.resolve(child)
	const relative = path.relative(normalizedParent, normalizedChild)

	// Outside parent if starts with .. or is absolute
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		return null
	}

	return relative // "" means same path, otherwise relative path
}

/**
 * Check if targetPath is lexically inside rootPath (not equal to).
 * Prevents path traversal attacks.
 */
function isPathInsideRoot(rootPath: string, targetPath: string): boolean {
	const rel = getRelativeIfContained(rootPath, targetPath)
	return rel !== null && rel !== ""
}

// =============================================================================
// DELETION EXECUTION
// =============================================================================

/**
 * Execute removals with safety checks.
 * Returns results for each target.
 */
function executeRemovals(targets: UninstallTarget[]): DeletionResult[] {
	const results: DeletionResult[] = []

	for (const target of targets) {
		const result = executeRemoval(target)
		results.push(result)
	}

	return results
}

/**
 * Execute a single removal with all safety checks.
 */
function executeRemoval(target: UninstallTarget): DeletionResult {
	const { absolutePath, displayPath, kind, deleteIfEmpty } = target

	// Skip if doesn't exist
	if (!existsSync(absolutePath)) {
		return { target, success: true, skipped: true, reason: "not found" }
	}

	// Skip deleteIfEmpty targets unless they're actually empty
	if (deleteIfEmpty) {
		if (!isDirectoryEmpty(absolutePath)) {
			logger.info(`Skipping ${displayPath} (not empty)`)
			return { target, success: true, skipped: true, reason: "not empty" }
		}
	}

	// Containment check (skip for root itself when deleteIfEmpty)
	if (!deleteIfEmpty && !isPathContained(target)) {
		logger.error(`Safety check failed: ${displayPath} is outside root boundary`)
		process.exit(UNINSTALL_EXIT_CODES.SAFETY_ERROR)
	}

	// Execute deletion
	try {
		logger.info(`Removing ${displayPath}`)

		if (kind === "symlink") {
			unlinkSync(absolutePath)
		} else if (kind === "directory") {
			rmSync(absolutePath, { recursive: true })
		} else {
			unlinkSync(absolutePath)
		}

		return { target, success: true, skipped: false }
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code

		// ENOENT: already gone, treat as success
		if (code === "ENOENT") {
			return { target, success: true, skipped: true, reason: "already removed" }
		}

		// EACCES/EPERM: permission denied
		if (code === "EACCES" || code === "EPERM") {
			const reason = "permission denied"
			logger.error(`Failed to remove ${displayPath}: ${reason}`)
			return { target, success: false, skipped: false, reason }
		}

		// Other errors
		const reason = error instanceof Error ? error.message : "unknown error"
		logger.error(`Failed to remove ${displayPath}: ${reason}`)
		return { target, success: false, skipped: false, reason }
	}
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Determine the kind of path (file, directory, or symlink).
 */
function getPathKind(filePath: string): "file" | "directory" | "symlink" {
	if (!existsSync(filePath)) {
		// Default to file for non-existent paths
		return "file"
	}

	try {
		const stat = lstatSync(filePath)
		if (stat.isSymbolicLink()) return "symlink"
		if (stat.isDirectory()) return "directory"
		return "file"
	} catch {
		return "file"
	}
}

/**
 * Check if a directory is empty.
 */
function isDirectoryEmpty(dirPath: string): boolean {
	try {
		const entries = readdirSync(dirPath)
		return entries.length === 0
	} catch {
		return false
	}
}

/**
 * Replace home directory with ~ for display.
 */
function tildify(filePath: string): string {
	const home = process.env.HOME
	if (!home) return filePath

	const rel = getRelativeIfContained(home, filePath)
	if (rel === null) return filePath
	return rel === "" ? "~" : `~/${rel}`
}

// =============================================================================
// OUTPUT
// =============================================================================

/**
 * Print dry run preview.
 */
function printDryRun(targets: UninstallTarget[]): void {
	// Filter out deleteIfEmpty targets that are not empty
	const actualTargets = targets.filter((t) => {
		if (t.deleteIfEmpty) {
			return existsSync(t.absolutePath) && isDirectoryEmpty(t.absolutePath)
		}
		return true
	})

	if (actualTargets.length === 0) {
		logger.info("Nothing would be removed")
		return
	}

	logger.info(`Would remove ${actualTargets.length} items:`)
	for (const target of actualTargets) {
		logger.log(`  ${target.displayPath}`)
	}
}

/**
 * Print what we're about to remove.
 */
function printRemovalPlan(targets: UninstallTarget[]): void {
	// Filter to non-deleteIfEmpty targets for the preview
	const mainTargets = targets.filter((t) => !t.deleteIfEmpty)

	logger.info(`Removing ${mainTargets.length} items:`)
	for (const target of mainTargets) {
		logger.log(`  ${target.displayPath}`)
	}
	logger.break()
}

/**
 * Print results and exit with appropriate code.
 */
function printResults(results: DeletionResult[]): void {
	const removed = results.filter((r) => r.success && !r.skipped)
	const failed = results.filter((r) => !r.success)

	logger.break()

	if (removed.length > 0) {
		logger.success(`Successfully removed ${removed.length} items`)
	}

	if (failed.length > 0) {
		logger.error(`Failed to remove ${failed.length} items`)
		process.exit(UNINSTALL_EXIT_CODES.PARTIAL_FAILURE)
	}
}

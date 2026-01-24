/**
 * Self Uninstall Command
 *
 * Safely removes OCX global configuration files and binary.
 * Follows the rustup uninstall model for a clean removal experience.
 *
 * Follows the 5 Laws of Elegant Defense:
 * - Early Exit: Guard clauses for safety checks at top of functions
 * - Parse Don't Validate: Path/target types are structured from the start
 * - Atomic Predictability: Each removal operation is independent and pure
 * - Fail Fast: Safety violations exit immediately with descriptive errors
 * - Intentional Naming: tildify, isLexicallyInside, classifyTargetSafety
 */

import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { Command } from "commander"
import { getGlobalConfig, getProfilesDir } from "../../profile/paths"
import {
	detectInstallMethod,
	getExecutablePath,
	type InstallMethod,
} from "../../self-update/detect-method"
import { wrapAction } from "../../utils/handle-error"
import { highlight, logger } from "../../utils/logger"

// =============================================================================
// CONSTANTS
// =============================================================================

/** Exit codes specific to uninstall operations */
export const UNINSTALL_EXIT_CODES = {
	SUCCESS: 0,
	ERROR: 1, // Permission denied, package-managed install
	SAFETY_ERROR: 2, // Containment violation, symlink root
} as const

// =============================================================================
// TYPES
// =============================================================================

/** Represents a target for removal with safety classification */
interface UninstallTarget {
	rootPath: string
	relativePath: string
	absolutePath: string
	displayPath: string // tildified
	// Note: "junction" omitted - Node's lstat doesn't reliably detect Windows junctions
	kind: "file" | "directory" | "symlink" | "missing"
	deleteIfEmpty: boolean
	safetyStatus: "safe" | "forbidden" | "error"
}

/** Result of validating the root directory */
interface RootValidationResult {
	valid: boolean
	reason?: "symlink" | "not-directory" | "not-found" | "permission"
}

/** Result of checking realpath containment */
interface RealpathContainmentResult {
	contained: boolean
	error?: "permission" | "io"
}

/** Result of attempting to delete a target */
interface DeletionResult {
	target: UninstallTarget
	success: boolean
	skipped: boolean
	reason?: "not found" | "not empty" | "permission denied" | "containment violation"
	error?: Error
}

/** Command options for uninstall */
interface UninstallOptions {
	dryRun?: boolean
}

// =============================================================================
// PATH HELPERS (Law 5: Intentional Naming)
// =============================================================================

/**
 * Type guard to check if an error is a Node.js errno exception.
 * @param err - The error to check
 * @returns True if the error has a code property
 */
function isNodeError(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && "code" in err
}

/**
 * Convert absolute path to ~/relative format for display.
 * @param absolutePath - The absolute path to tildify
 * @returns Path with home directory replaced by ~
 */
function tildify(absolutePath: string): string {
	const home = homedir()
	if (!home) return absolutePath

	// Exact match or proper child path
	if (absolutePath === home) return "~"
	if (absolutePath.startsWith(home + path.sep)) {
		return `~${absolutePath.slice(home.length)}`
	}
	return absolutePath
}

/**
 * Get the relative path from parent to child if child is contained within parent.
 * Returns null if child would escape parent (e.g., via ..).
 * @param parent - The parent directory
 * @param child - The potential child path
 * @returns Relative path if contained, null otherwise
 */
function getRelativePathIfContained(parent: string, child: string): string | null {
	const normalizedParent = path.normalize(parent)
	const normalizedChild = path.normalize(child)

	// Get relative path
	const relative = path.relative(normalizedParent, normalizedChild)

	// Check for escape: starts with .. or is absolute
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		return null
	}

	return relative
}

/**
 * Check if target is lexically inside root (no symlink resolution).
 * Safe for symlink containment checks.
 * @param root - The root directory
 * @param target - The target path to check
 * @returns True if target is lexically inside root
 */
function isLexicallyInside(root: string, target: string): boolean {
	return getRelativePathIfContained(root, target) !== null
}

/**
 * Check if target's realpath is inside root's realpath.
 * Used for file/directory containment checks.
 * @param root - The root directory (must exist)
 * @param target - The target path to check
 * @returns Result object with containment status and any error
 */
function isRealpathInside(root: string, target: string): RealpathContainmentResult {
	// Early exit: if target doesn't exist, can't resolve realpath
	if (!existsSync(target)) {
		return { contained: true } // Missing targets are safe to "delete"
	}

	try {
		const realRoot = realpathSync(root)
		const realTarget = realpathSync(target)
		return { contained: getRelativePathIfContained(realRoot, realTarget) !== null }
	} catch (err) {
		// Distinguish permission errors from other IO errors
		if (isNodeError(err) && (err.code === "EACCES" || err.code === "EPERM")) {
			return { contained: false, error: "permission" }
		}
		return { contained: false, error: "io" }
	}
}

/**
 * Validate that root directory exists, is a directory, and is not a symlink.
 * @param rootPath - The root path to validate
 * @returns Validation result with reason if invalid
 */
function validateRootDirectory(rootPath: string): RootValidationResult {
	try {
		const stats = lstatSync(rootPath)
		if (stats.isSymbolicLink()) {
			return { valid: false, reason: "symlink" }
		}
		if (!stats.isDirectory()) {
			return { valid: false, reason: "not-directory" }
		}
		return { valid: true }
	} catch (err) {
		if (isNodeError(err)) {
			if (err.code === "ENOENT") {
				return { valid: false, reason: "not-found" }
			}
			if (err.code === "EACCES" || err.code === "EPERM") {
				return { valid: false, reason: "permission" }
			}
		}
		// Default to permission error for unknown failures (operational error)
		return { valid: false, reason: "permission" }
	}
}

/**
 * Determine the kind of filesystem entry at path.
 * @param targetPath - The path to check
 * @returns The kind of entry
 */
function getPathKind(targetPath: string): UninstallTarget["kind"] {
	if (!existsSync(targetPath)) {
		return "missing"
	}

	try {
		const stats = lstatSync(targetPath)
		if (stats.isSymbolicLink()) {
			return "symlink"
		}
		if (stats.isDirectory()) {
			return "directory"
		}
		return "file"
	} catch {
		return "missing"
	}
}

/**
 * Check if a directory is empty.
 * @param dirPath - Path to the directory
 * @returns True if empty, false if not empty or not a directory
 */
function isDirectoryEmpty(dirPath: string): boolean {
	if (!existsSync(dirPath)) {
		return true
	}

	try {
		const entries = readdirSync(dirPath)
		return entries.length === 0
	} catch {
		return false
	}
}

/**
 * Classify the safety status of a target.
 * @param target - Partial target with path info
 * @returns Safety status: "safe", "forbidden", or "error" (for operational failures)
 */
function classifyTargetSafety(
	target: Pick<UninstallTarget, "rootPath" | "absolutePath" | "kind">,
): "safe" | "forbidden" | "error" {
	// Missing targets are always safe
	if (target.kind === "missing") {
		return "safe"
	}

	// Symlinks use lexical containment only (don't follow)
	if (target.kind === "symlink") {
		return isLexicallyInside(target.rootPath, target.absolutePath) ? "safe" : "forbidden"
	}

	// Files/directories use realpath containment
	const result = isRealpathInside(target.rootPath, target.absolutePath)
	if (result.error) {
		return "error" // Operational failure (permission/IO)
	}
	return result.contained ? "safe" : "forbidden"
}

// =============================================================================
// BINARY DETECTION (Law 1: Early Exit for edge cases)
// =============================================================================

/**
 * Check if install method is package-managed.
 * @param method - The install method
 * @returns True if managed by npm/pnpm/bun/yarn
 */
function isPackageManaged(method: InstallMethod): boolean {
	return method === "npm" || method === "pnpm" || method === "bun" || method === "yarn"
}

/**
 * Get the uninstall command for a package manager.
 * @param method - The package manager
 * @returns The command string to run
 */
function getPackageManagerCommand(method: InstallMethod): string {
	switch (method) {
		case "npm":
			return "npm uninstall -g ocx"
		case "pnpm":
			return "pnpm remove -g ocx"
		case "bun":
			return "bun remove -g ocx"
		case "yarn":
			return "yarn global remove ocx"
		default:
			return "npm uninstall -g ocx"
	}
}

// =============================================================================
// TARGET BUILDING (Law 2: Parse Don't Validate)
// =============================================================================

/**
 * Get the OCX global config root directory.
 * @returns Path to ~/.config/opencode/
 */
function getGlobalConfigRoot(): string {
	const base = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config")
	return path.join(base, "opencode")
}

/**
 * Build targets for config removal.
 * @returns Array of config targets
 */
function buildConfigTargets(): UninstallTarget[] {
	const rootPath = getGlobalConfigRoot()
	const targets: UninstallTarget[] = []

	// Profiles directory
	const profilesDir = getProfilesDir()
	const profilesRelative = getRelativePathIfContained(rootPath, profilesDir)
	if (profilesRelative) {
		const kind = getPathKind(profilesDir)
		targets.push({
			rootPath,
			relativePath: profilesRelative,
			absolutePath: profilesDir,
			displayPath: tildify(profilesDir),
			kind,
			deleteIfEmpty: false,
			safetyStatus: classifyTargetSafety({ rootPath, absolutePath: profilesDir, kind }),
		})
	}

	// ocx.jsonc file
	const globalConfig = getGlobalConfig()
	const configRelative = getRelativePathIfContained(rootPath, globalConfig)
	if (configRelative) {
		const kind = getPathKind(globalConfig)
		targets.push({
			rootPath,
			relativePath: configRelative,
			absolutePath: globalConfig,
			displayPath: tildify(globalConfig),
			kind,
			deleteIfEmpty: false,
			safetyStatus: classifyTargetSafety({ rootPath, absolutePath: globalConfig, kind }),
		})
	}

	// Root directory (only delete if empty after other removals)
	const rootKind = getPathKind(rootPath)
	targets.push({
		rootPath,
		relativePath: ".",
		absolutePath: rootPath,
		displayPath: tildify(rootPath),
		kind: rootKind,
		deleteIfEmpty: true,
		safetyStatus: rootKind === "missing" ? "safe" : "safe", // Root is always safe if it exists
	})

	return targets
}

/**
 * Build target for binary removal.
 * @returns Binary target or null if package-managed
 */
function buildBinaryTarget(): UninstallTarget | null {
	const method = detectInstallMethod()

	// Package-managed installs should use their own uninstall
	if (isPackageManaged(method)) {
		return null
	}

	// For curl installs, get the executable path
	if (method === "curl") {
		const binaryPath = getExecutablePath()
		const kind = getPathKind(binaryPath)
		const parentDir = path.dirname(binaryPath)

		return {
			rootPath: parentDir,
			relativePath: path.basename(binaryPath),
			absolutePath: binaryPath,
			displayPath: tildify(binaryPath),
			kind,
			deleteIfEmpty: false,
			safetyStatus: kind === "missing" ? "safe" : "safe", // Binary path is trusted
		}
	}

	// Unknown method - can't determine binary location
	return null
}

// =============================================================================
// DELETION EXECUTION (Law 3: Atomic Predictability)
// =============================================================================

/**
 * Execute removal of a single target.
 * @param target - The target to remove
 * @returns Result of the deletion attempt
 */
function executeRemoval(target: UninstallTarget): DeletionResult {
	// Early exit: missing targets are already "deleted"
	if (target.kind === "missing") {
		return { target, success: true, skipped: true, reason: "not found" }
	}

	// Early exit: forbidden targets are skipped with containment violation
	if (target.safetyStatus === "forbidden") {
		return {
			target,
			success: false,
			skipped: true,
			reason: "containment violation",
			error: new Error("Target escapes containment boundary"),
		}
	}

	// Handle deleteIfEmpty directories
	if (target.deleteIfEmpty && target.kind === "directory") {
		if (!isDirectoryEmpty(target.absolutePath)) {
			return { target, success: true, skipped: true, reason: "not empty" }
		}
	}

	try {
		if (target.kind === "directory") {
			rmSync(target.absolutePath, { recursive: true, force: true })
		} else {
			unlinkSync(target.absolutePath)
		}
		return { target, success: true, skipped: false }
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err))
		const reason =
			isNodeError(err) && (err.code === "EACCES" || err.code === "EPERM")
				? "permission denied"
				: undefined
		return { target, success: false, skipped: false, reason, error }
	}
}

/**
 * Execute removal of all targets.
 * @param targets - Array of targets to remove
 * @returns Array of results
 */
function executeRemovals(targets: UninstallTarget[]): DeletionResult[] {
	return targets.map(executeRemoval)
}

/**
 * Remove binary file (platform-specific).
 * @param binaryPath - Path to the binary
 * @returns Deletion result
 */
function removeBinary(binaryPath: string): DeletionResult {
	const target: UninstallTarget = {
		rootPath: path.dirname(binaryPath),
		relativePath: path.basename(binaryPath),
		absolutePath: binaryPath,
		displayPath: tildify(binaryPath),
		kind: getPathKind(binaryPath),
		deleteIfEmpty: false,
		safetyStatus: "safe",
	}

	// Early exit: missing binary
	if (target.kind === "missing") {
		return { target, success: true, skipped: true, reason: "not found" }
	}

	// On Windows, print instructions for v1 (binary may be locked)
	if (process.platform === "win32") {
		logger.info(`To complete uninstall, manually delete: ${target.displayPath}`)
		return { target, success: true, skipped: true }
	}

	try {
		unlinkSync(binaryPath)
		return { target, success: true, skipped: false }
	} catch (error) {
		const err = error instanceof Error ? error : new Error(String(error))
		return { target, success: false, skipped: false, reason: "permission denied", error: err }
	}
}

// =============================================================================
// OUTPUT HELPERS (Law 5: Intentional Naming)
// =============================================================================

/**
 * Print what would be removed in dry-run mode.
 * @param configTargets - Config targets
 * @param binaryTarget - Binary target (null if package-managed)
 * @param installMethod - Detected install method
 */
function printDryRun(
	configTargets: UninstallTarget[],
	binaryTarget: UninstallTarget | null,
	installMethod: InstallMethod,
): void {
	logger.info("Dry run - the following would be removed:\n")

	const existingConfigTargets = configTargets.filter((t) => t.kind !== "missing")
	for (const target of existingConfigTargets) {
		const kindLabel = target.kind === "directory" ? "[dir] " : "[file]"
		const emptyNote = target.deleteIfEmpty ? " (if empty)" : ""
		logger.log(`  ${kindLabel} ${highlight.path(target.displayPath)}${emptyNote}`)
	}

	if (binaryTarget && binaryTarget.kind !== "missing") {
		logger.log(`  [bin]  ${highlight.path(binaryTarget.displayPath)}`)
	}

	if (isPackageManaged(installMethod)) {
		logger.log("")
		logger.info(`Binary managed by ${installMethod}. Run:`)
		logger.log(`  ${highlight.command(getPackageManagerCommand(installMethod))}`)
	}

	if (existingConfigTargets.length === 0 && (!binaryTarget || binaryTarget.kind === "missing")) {
		logger.info("Nothing to remove.")
	}
}

/**
 * Print the removal plan before execution.
 * @param configTargets - Config targets
 * @param binaryTarget - Binary target
 */
function printRemovalPlan(
	configTargets: UninstallTarget[],
	binaryTarget: UninstallTarget | null,
): void {
	const existingConfigTargets = configTargets.filter((t) => t.kind !== "missing")

	if (existingConfigTargets.length > 0 || (binaryTarget && binaryTarget.kind !== "missing")) {
		logger.info("Removing OCX files...")
	}
}

/**
 * Print results of removal operations.
 * @param results - Deletion results
 * @param binaryResult - Binary deletion result
 * @param installMethod - Install method for package manager message
 */
function printResults(
	results: DeletionResult[],
	binaryResult: DeletionResult | null,
	installMethod: InstallMethod,
): void {
	logger.break()

	// Print config results
	for (const result of results) {
		if (result.skipped) {
			if (result.reason === "not found") {
				// Skip silent - already gone
				continue
			}
			if (result.reason === "not empty") {
				logger.info(`Kept ${highlight.path(result.target.displayPath)} (not empty)`)
				continue
			}
			if (result.reason === "permission denied") {
				logger.warn(`Skipped ${highlight.path(result.target.displayPath)} (permission denied)`)
				continue
			}
			if (result.reason === "containment violation") {
				logger.warn(`Skipped ${highlight.path(result.target.displayPath)} (containment violation)`)
				continue
			}
		}

		if (result.success) {
			logger.success(`Removed ${highlight.path(result.target.displayPath)}`)
		} else {
			logger.error(`Failed to remove ${result.target.displayPath}: ${result.error?.message}`)
		}
	}

	// Print binary result
	if (binaryResult) {
		if (binaryResult.skipped && binaryResult.reason === "not found") {
			// Skip silent
		} else if (binaryResult.success && !binaryResult.skipped) {
			logger.success(`Removed binary ${highlight.path(binaryResult.target.displayPath)}`)
		} else if (!binaryResult.success) {
			logger.error(
				`Failed to remove binary ${binaryResult.target.displayPath}: ${binaryResult.error?.message}`,
			)
		}
	}

	// Package manager message
	if (isPackageManaged(installMethod)) {
		logger.break()
		logger.info(`Binary is managed by ${installMethod}. To complete uninstall, run:`)
		logger.log(`  ${highlight.command(getPackageManagerCommand(installMethod))}`)
	}
}

/**
 * Print message when nothing to remove.
 */
function printNothingToRemove(): void {
	logger.info("Nothing to remove. OCX is not installed globally.")
}

// =============================================================================
// MAIN LOGIC (Law 1: Early Exit for all edge cases at top)
// =============================================================================

/**
 * Run the uninstall command.
 * @param options - Command options
 */
export async function runUninstall(options: UninstallOptions): Promise<void> {
	const rootPath = getGlobalConfigRoot()

	// 1. Validate root directory
	const rootValidation = validateRootDirectory(rootPath)
	if (!rootValidation.valid) {
		switch (rootValidation.reason) {
			case "not-found":
				// Non-existent root is valid - nothing to delete, check binary
				break
			case "symlink":
				logger.error("Safety error: Global config root is a symlink. Aborting.")
				process.exit(UNINSTALL_EXIT_CODES.SAFETY_ERROR)
				break
			case "not-directory":
				logger.error("Safety error: Global config root is not a directory. Aborting.")
				process.exit(UNINSTALL_EXIT_CODES.SAFETY_ERROR)
				break
			case "permission":
				logger.error("Error: Cannot access global config root (permission denied).")
				process.exit(UNINSTALL_EXIT_CODES.ERROR)
				break
		}
	}

	// 2. Build config targets
	const configTargets = buildConfigTargets()

	// 3. Check for containment violations and operational errors (Law 4: Fail Fast)
	const forbiddenTargets = configTargets.filter((t) => t.safetyStatus === "forbidden")
	if (forbiddenTargets.length > 0) {
		logger.error("Safety error: Target escapes containment boundary:")
		for (const target of forbiddenTargets) {
			logger.error(`  ${target.displayPath}`)
		}
		process.exit(UNINSTALL_EXIT_CODES.SAFETY_ERROR)
	}

	const errorTargets = configTargets.filter((t) => t.safetyStatus === "error")
	if (errorTargets.length > 0) {
		logger.error("Error: Cannot verify containment for targets (permission/IO error):")
		for (const target of errorTargets) {
			logger.error(`  ${target.displayPath}`)
		}
		process.exit(UNINSTALL_EXIT_CODES.ERROR)
	}

	// 4. Detect install method, build binary target
	const installMethod = detectInstallMethod()
	const binaryTarget = buildBinaryTarget()

	// 5. Check if nothing to remove
	const existingConfigTargets = configTargets.filter((t) => t.kind !== "missing")
	const hasBinary = binaryTarget && binaryTarget.kind !== "missing"
	const hasPackageManager = isPackageManaged(installMethod)

	if (existingConfigTargets.length === 0 && !hasBinary && !hasPackageManager) {
		printNothingToRemove()
		process.exit(UNINSTALL_EXIT_CODES.SUCCESS)
	}

	// 6. Dry-run mode: show what would be removed
	if (options.dryRun) {
		printDryRun(configTargets, binaryTarget, installMethod)
		process.exit(UNINSTALL_EXIT_CODES.SUCCESS)
	}

	// 7. Print removal plan
	printRemovalPlan(configTargets, binaryTarget)

	// 8. Execute config removals (order matters: children before parents)
	const configResults = executeRemovals(configTargets)

	// 9. Execute binary removal OR print package manager command
	let binaryResult: DeletionResult | null = null
	if (binaryTarget) {
		binaryResult = removeBinary(binaryTarget.absolutePath)
	}

	// 10. Print results
	printResults(configResults, binaryResult, installMethod)

	// 11. Determine exit code
	const hasFailures = configResults.some((r) => !r.success && !r.skipped)
	const binaryFailed = binaryResult && !binaryResult.success && !binaryResult.skipped

	if (hasFailures || binaryFailed) {
		process.exit(UNINSTALL_EXIT_CODES.ERROR)
	}

	// Package-managed installs exit with 1 to indicate manual step needed
	if (isPackageManaged(installMethod)) {
		process.exit(UNINSTALL_EXIT_CODES.ERROR)
	}

	process.exit(UNINSTALL_EXIT_CODES.SUCCESS)
}

// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

/**
 * Register the self uninstall command.
 * @param parent - Parent command (self)
 */
export function registerSelfUninstallCommand(parent: Command): void {
	parent
		.command("uninstall")
		.description("Remove OCX global configuration and binary")
		.option("--dry-run", "Preview what would be removed")
		.action(
			wrapAction(async (options: UninstallOptions) => {
				await runUninstall(options)
			}),
		)
}

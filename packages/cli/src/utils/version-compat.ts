/**
 * Version Compatibility Utilities
 *
 * Pure functions for checking version compatibility following the 5 Laws:
 * - Law 1 (Early Exit): Check at top of fetch flow
 * - Law 2 (Parse, Don't Validate): Work with typed results
 * - Law 3 (Atomic Predictability): Pure functions, same input = same output
 * - Law 4 (Fail Fast, Fail Loud): Clear warning messages
 * - Law 5 (Intentional Naming): Self-documenting function names
 */

import kleur from "kleur"
import { logger } from "./logger"

/**
 * Result of a version compatibility check
 */
export type CompatResult =
	| { compatible: true }
	| { compatible: false; required: string; installed: string; type: "opencode" | "ocx" }

/** Incompatible result from version check */
export type IncompatibleResult = Extract<CompatResult, { compatible: false }>

/**
 * Options for collecting compatibility issues
 */
export interface CompatCheckOptions {
	registry: { opencode?: string; ocx?: string }
	ocxVersion: string
	opencodeVersion?: string
}

/**
 * Parse a semver string into components.
 * Returns null if invalid (Law 4: explicit failure state).
 *
 * @param v - Version string (e.g., "1.2.3" or "1.2.3-beta.1")
 * @returns Parsed version or null if invalid
 */
function parseVersion(v: string): { major: number; minor: number; patch: number } | null {
	const [main = ""] = v.split("-") // Ignore prerelease for comparison
	const parts = main.split(".")
	const major = parseInt(parts[0] ?? "", 10)
	const minor = parseInt(parts[1] ?? "", 10)
	const patch = parseInt(parts[2] ?? "", 10)

	// Early exit: invalid version components
	if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) {
		return null
	}

	return { major, minor, patch }
}

/**
 * Compare two semver versions.
 * Returns null if either version is invalid (cannot compare).
 *
 * @param a - First version string (e.g., "1.2.3")
 * @param b - Second version string (e.g., "1.0.0")
 * @returns Negative if a < b, 0 if equal, positive if a > b, null if invalid
 */
function compareSemver(a: string, b: string): number | null {
	const vA = parseVersion(a)
	const vB = parseVersion(b)

	// Early exit: can't compare invalid versions
	if (!vA || !vB) {
		return null
	}

	if (vA.major !== vB.major) return vA.major - vB.major
	if (vA.minor !== vB.minor) return vA.minor - vB.minor
	return vA.patch - vB.patch
}

/**
 * Check if installed version meets minimum requirement.
 * Pure function: same input = same output.
 */
export function checkCompatibility(
	requiredVersion: string | undefined,
	installedVersion: string,
	type: "opencode" | "ocx",
): CompatResult {
	// Early exit: no requirement means compatible
	if (!requiredVersion) {
		return { compatible: true }
	}

	// Compare versions
	const cmp = compareSemver(installedVersion, requiredVersion)

	// Early exit: can't compare invalid versions, assume compatible (permissive)
	if (cmp === null) {
		return { compatible: true }
	}

	if (cmp >= 0) {
		return { compatible: true }
	}

	return {
		compatible: false,
		required: requiredVersion,
		installed: installedVersion,
		type,
	}
}

/**
 * Format a compatibility warning message (pnpm-inspired).
 * WHAT happened, WHY, IMPACT, HOW TO FIX.
 */
export function formatCompatWarning(
	registryName: string,
	result: Extract<CompatResult, { compatible: false }>,
): string {
	const typeLabel = result.type === "opencode" ? "OpenCode" : "OCX CLI"
	const updateCmd =
		result.type === "opencode" ? "Update OpenCode to the latest version" : "bun update -g ocx"

	return `
${kleur.yellow().bold("⚠ WARN")}  ${kleur.yellow("Version compatibility notice")}

  Registry ${kleur.cyan(`"${registryName}"`)} requires ${typeLabel} ${kleur.green(result.required)}
  You are running ${typeLabel} ${kleur.red(result.installed)}

  This may work fine, but if you encounter issues,
  consider updating: ${kleur.dim(updateCmd)}

  To silence: ${kleur.dim("--skip-compat-check")} or set ${kleur.dim('"skipCompatCheck": true')} in ocx.jsonc
`
}

/**
 * Collect compatibility issues for a registry (PURE).
 * Returns array of incompatible results - empty array means all compatible.
 *
 * @param options - Check options with registry requirements and installed versions
 * @returns Array of incompatible results (empty if all compatible)
 */
export function collectCompatIssues(options: CompatCheckOptions): IncompatibleResult[] {
	const { registry, ocxVersion, opencodeVersion } = options
	const issues: IncompatibleResult[] = []

	// Check OCX CLI version
	const ocxResult = checkCompatibility(registry.ocx, ocxVersion, "ocx")
	if (!ocxResult.compatible) {
		issues.push(ocxResult)
	}

	// Check OpenCode version (only if we know it)
	if (opencodeVersion) {
		const opencodeResult = checkCompatibility(registry.opencode, opencodeVersion, "opencode")
		if (!opencodeResult.compatible) {
			issues.push(opencodeResult)
		}
	}

	return issues
}

/**
 * Print compatibility warnings for collected issues (IMPURE - side effect).
 * Separated from pure collectCompatIssues() following Law 3.
 *
 * @param registryName - Name of the registry for display
 * @param issues - Array of compatibility issues to warn about
 */
export function warnCompatIssues(registryName: string, issues: IncompatibleResult[]): void {
	for (const issue of issues) {
		logger.log(formatCompatWarning(registryName, issue))
	}
}

/**
 * Semver parsing and comparison utilities.
 */

/**
 * Parsed semver version components.
 */
export interface ParsedVersion {
	major: number
	minor: number
	patch: number
}

const SEMVER_PATTERN =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

export function isValidSemver(v: string): boolean {
	return SEMVER_PATTERN.test(v)
}

/**
 * Parse a semver string into components.
 * Returns null if invalid. Ignores prerelease suffixes for comparison.
 *
 * @param v - Version string (e.g., "1.2.3" or "1.2.3-beta.1")
 * @returns Parsed version or null if invalid
 */
export function parseVersion(v: string): ParsedVersion | null {
	if (!isValidSemver(v)) {
		return null
	}

	const [main = ""] = v.split(/[+-]/) // Ignore prerelease/build metadata for comparison
	const parts = main.split(".")
	const major = Number(parts[0])
	const minor = Number(parts[1])
	const patch = Number(parts[2])

	// Early exit: invalid version components
	if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) {
		return null
	}

	return { major, minor, patch }
}

/**
 * Compare two semver versions.
 * Returns null if either version is invalid (cannot compare).
 * Compares major/minor/patch only; prerelease and build metadata are validated
 * by parseVersion, then ignored for this compatibility check.
 *
 * @param a - First version string (e.g., "1.2.3")
 * @param b - Second version string (e.g., "1.0.0")
 * @returns Negative if a < b, 0 if equal, positive if a > b, null if invalid
 */
export function compareSemver(a: string, b: string): number | null {
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

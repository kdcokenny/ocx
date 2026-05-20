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

/**
 * Parse a semver string into components.
 * Returns null if invalid. Ignores prerelease suffixes for comparison.
 *
 * @param v - Version string (e.g., "1.2.3" or "1.2.3-beta.1")
 * @returns Parsed version or null if invalid
 */
export function parseVersion(v: string): ParsedVersion | null {
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

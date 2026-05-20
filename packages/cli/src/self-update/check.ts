/**
 * Check for available updates to the OCX CLI.
 * Returns a discriminated union: { ok: true, ... } for success,
 * { ok: false, reason: '...' } for failure with typed reason.
 *
 * Follows the 5 Laws of Elegant Defense:
 * - Early Exit: Return failure reason immediately on error
 * - Parse Don't Validate: Use typed CheckResult discriminated union
 * - Atomic Predictability: Pure comparison logic
 * - Fail Fast: Abort on timeout, don't block UX
 * - Intentional Naming: Self-documenting function names
 */

import { NetworkError } from "../utils/errors"
import { fetchPackageVersion } from "../utils/npm-registry"
import { compareSemver } from "../utils/semver"
import type { VersionProvider } from "./types"
import { defaultVersionProvider } from "./version-provider"

// =============================================================================
// TYPES
// =============================================================================

/**
 * Result of checking for available updates.
 * Contains current version, latest version, and whether an update is available.
 */
export interface VersionCheckResult {
	current: string
	latest: string
	updateAvailable: boolean
}

/**
 * Result of checking for available updates.
 * Discriminated union: ok=true for success, ok=false with reason for failure.
 */
export type CheckResult =
	| { ok: true; current: string; latest: string; updateAvailable: boolean }
	| { ok: false; reason: "dev-version" | "timeout" | "network-error" | "invalid-response" }

/** Extract failure type for error message mapping */
export type CheckFailure = Extract<CheckResult, { ok: false }>

// Re-export for convenience
export type { VersionProvider } from "./types"

// =============================================================================
// CONSTANTS
// =============================================================================

/** Timeout for version check - non-blocking UX is priority */
const VERSION_CHECK_TIMEOUT_MS = 200

/** Timeout for explicit update commands (user is willing to wait) */
export const EXPLICIT_UPDATE_TIMEOUT_MS = 10_000

/** Package name on npm registry */
const PACKAGE_NAME = "ocx"

// =============================================================================
// VERSION CHECK
// =============================================================================

/**
 * Check if a newer version of OCX is available.
 *
 * Uses npm registry with configurable timeout for different contexts:
 * - Background checks: 200ms (non-blocking UX priority)
 * - Explicit update command: 10s (user is willing to wait)
 *
 * Returns discriminated union: ok=true for success, ok=false with reason for failure.
 *
 * @param versionProvider - Optional version provider for dependency injection (testing)
 * @param timeoutMs - Timeout in milliseconds (default: 200ms for background checks)
 * @returns CheckResult with success data or failure reason
 */
export async function checkForUpdate(
	versionProvider?: VersionProvider,
	timeoutMs: number = VERSION_CHECK_TIMEOUT_MS,
): Promise<CheckResult> {
	const provider = versionProvider ?? defaultVersionProvider
	const current = provider.version || "0.0.0-dev"

	// Early exit: dev version, don't check
	if (current === "0.0.0-dev") {
		return { ok: false, reason: "dev-version" }
	}

	try {
		// Fetch with timeout signal - aborts the actual HTTP request on timeout
		const result = await fetchPackageVersion(
			PACKAGE_NAME,
			undefined,
			AbortSignal.timeout(timeoutMs),
		)

		const latest = result.version

		// Compare versions
		const comparison = compareSemver(latest, current)

		// Early exit: can't compare (invalid versions)
		if (comparison === null) {
			return { ok: false, reason: "invalid-response" }
		}

		return {
			ok: true,
			current,
			latest,
			updateAvailable: comparison > 0,
		}
	} catch (error) {
		// Categorize the failure reason for caller to handle appropriately
		if (error instanceof Error) {
			// Timeout/AbortError - request was aborted
			if (error.name === "AbortError" || error.name === "TimeoutError") {
				return { ok: false, reason: "timeout" }
			}

			// Network-level failures
			if (error instanceof NetworkError || error.name === "NetworkError") {
				return { ok: false, reason: "network-error" }
			}
		}

		// Parse errors or unexpected response shapes
		return { ok: false, reason: "invalid-response" }
	}
}

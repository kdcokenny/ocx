/**
 * Build-Time Version Provider
 *
 * Provides version from build-time constant for production use.
 * @module
 */

import type { VersionProvider } from "./types"

// =============================================================================
// BUILD-TIME VERSION
// =============================================================================

/** Version injected at build time by bundler */
declare const __VERSION__: string | undefined

/**
 * Provides version from build-time constant.
 * Falls back to empty string if not defined (development mode).
 */
export class BuildTimeVersionProvider implements VersionProvider {
	readonly version = typeof __VERSION__ !== "undefined" ? __VERSION__ : ""
}

/** Default version provider instance for production use */
export const defaultVersionProvider = new BuildTimeVersionProvider()

/**
 * npm Registry Utilities
 *
 * Validates and fetches npm package metadata for OpenCode plugin installation.
 * Follows the 5 Laws of Elegant Defense:
 * - Early Exit: Guard clauses at top
 * - Parse Don't Validate: Parse specifiers at boundary into typed structures
 * - Fail Fast: Throw immediately on invalid input
 */

import { NetworkError, NotFoundError, ValidationError } from "./errors"

// =============================================================================
// TYPES
// =============================================================================

/**
 * Parsed npm specifier from "npm:package@version" syntax.
 * Discriminated union type for type-safe handling.
 */
export interface NpmSpecifier {
	type: "npm"
	name: string
	version?: string
}

/**
 * Minimal npm package metadata from registry.
 * Only includes fields we need.
 */
export interface NpmPackageMetadata {
	name: string
	"dist-tags": {
		latest: string
	}
	versions: Record<string, unknown>
}

/**
 * Version-specific package.json fields from npm registry.
 * Used for plugin validation.
 */
export interface NpmPackageVersion {
	name: string
	version: string
	type?: string
	main?: string
	exports?: unknown
}

/**
 * Result of plugin validation.
 * Contains warnings for soft checks that passed but may indicate issues.
 */
export interface PluginValidationResult {
	valid: true
	warnings: string[]
}

// =============================================================================
// CONSTANTS
// =============================================================================

const NPM_REGISTRY_BASE = "https://registry.npmjs.org"
const NPM_FETCH_TIMEOUT_MS = 30_000

/**
 * npm package name validation rules:
 * - 1-214 characters
 * - Lowercase only
 * - No spaces
 * - Cannot start with . or _
 * - No path traversal sequences
 */
const NPM_NAME_REGEX = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/
const MAX_NAME_LENGTH = 214

// =============================================================================
// PARSING
// =============================================================================

/**
 * Sanitize and validate npm package name.
 * @throws ValidationError for invalid names
 */
function validateNpmPackageName(name: string): void {
	// Guard: empty name
	if (!name) {
		throw new ValidationError("npm package name cannot be empty")
	}

	// Guard: too long
	if (name.length > MAX_NAME_LENGTH) {
		throw new ValidationError(
			`npm package name exceeds maximum length of ${MAX_NAME_LENGTH} characters: \`${name}\``,
		)
	}

	// Guard: path traversal
	if (name.includes("..") || name.includes("/./") || name.startsWith("./")) {
		throw new ValidationError(`Invalid npm package name - path traversal detected: \`${name}\``)
	}

	// Guard: invalid characters (allows scoped packages like @scope/pkg)
	if (!NPM_NAME_REGEX.test(name)) {
		throw new ValidationError(
			`Invalid npm package name: \`${name}\`. ` +
				"Must be lowercase, start with alphanumeric, and contain only letters, numbers, hyphens, dots, or underscores.",
		)
	}
}

/**
 * Parse an npm specifier string into a typed structure.
 *
 * Supported formats:
 * - "npm:lodash" -> { type: "npm", name: "lodash" }
 * - "npm:lodash@4.0.0" -> { type: "npm", name: "lodash", version: "4.0.0" }
 * - "npm:@scope/pkg" -> { type: "npm", name: "@scope/pkg" }
 * - "npm:@scope/pkg@1.0.0" -> { type: "npm", name: "@scope/pkg", version: "1.0.0" }
 *
 * @throws ValidationError if specifier format is invalid
 */
export function parseNpmSpecifier(specifier: string): NpmSpecifier {
	// Guard: empty input
	if (!specifier?.trim()) {
		throw new ValidationError("npm specifier cannot be empty")
	}

	const trimmed = specifier.trim()

	// Guard: must have npm: prefix
	if (!trimmed.startsWith("npm:")) {
		throw new ValidationError(
			`Invalid npm specifier: \`${specifier}\`. Must start with \`npm:\` prefix.`,
		)
	}

	// Strip npm: prefix
	const remainder = trimmed.slice(4)

	// Guard: empty after prefix
	if (!remainder) {
		throw new ValidationError(`Invalid npm specifier: \`${specifier}\`. Package name is required.`)
	}

	// Parse package@version using same logic as parseNpmDependency in add.ts
	const lastAt = remainder.lastIndexOf("@")

	// Handle scoped packages: @scope/pkg or @scope/pkg@version
	// If lastAt is 0, it's just @scope/pkg (no version)
	// If lastAt > 0 and there's a / before it, need to check if it's the scope @ or version @
	let name: string
	let version: string | undefined

	if (lastAt > 0) {
		// Check if @ is part of version or scope
		const beforeAt = remainder.slice(0, lastAt)
		const afterAt = remainder.slice(lastAt + 1)

		// If beforeAt contains a /, it means we have @scope/pkg@version
		// If beforeAt doesn't start with @, it's just pkg@version
		if (beforeAt.includes("/") || !beforeAt.startsWith("@")) {
			name = beforeAt
			version = afterAt || undefined
		} else {
			// This is @scope@version which is invalid (missing package name)
			throw new ValidationError(
				`Invalid npm specifier: \`${specifier}\`. Scoped packages must have format @scope/pkg.`,
			)
		}
	} else {
		// No version specified, or it's just @scope/pkg
		name = remainder
	}

	// Validate the extracted package name
	validateNpmPackageName(name)

	return { type: "npm", name, version }
}

/**
 * Check if a string looks like an npm specifier (starts with "npm:")
 */
export function isNpmSpecifier(input: string): boolean {
	return input.trim().startsWith("npm:")
}

// =============================================================================
// REGISTRY INTERACTION
// =============================================================================

/**
 * Validate that an npm package exists on the registry.
 *
 * @param packageName - The npm package name (may be scoped like @scope/pkg)
 * @param signal - Optional AbortSignal for request cancellation
 * @returns Package metadata from npm registry
 * @throws NotFoundError if package doesn't exist (404)
 * @throws NetworkError for other fetch failures
 */
export async function validateNpmPackage(
	packageName: string,
	signal?: AbortSignal,
): Promise<NpmPackageMetadata> {
	// Guard: validate package name first
	validateNpmPackageName(packageName)

	// URL encode scoped packages: @scope/pkg -> @scope%2Fpkg
	const encodedName = packageName.startsWith("@")
		? `@${encodeURIComponent(packageName.slice(1))}`
		: encodeURIComponent(packageName)

	const url = `${NPM_REGISTRY_BASE}/${encodedName}`

	try {
		// Use provided signal or create a timeout signal
		const fetchSignal = signal ?? AbortSignal.timeout(NPM_FETCH_TIMEOUT_MS)

		const response = await fetch(url, {
			signal: fetchSignal,
			headers: {
				Accept: "application/json",
			},
		})

		// Handle 404 specifically
		if (response.status === 404) {
			throw new NotFoundError(`npm package \`${packageName}\` not found on registry`)
		}

		// Handle other errors
		if (!response.ok) {
			throw new NetworkError(
				`Failed to fetch npm package \`${packageName}\`: HTTP ${response.status} ${response.statusText}`,
			)
		}

		const data = (await response.json()) as NpmPackageMetadata
		return data
	} catch (error) {
		// Re-throw our custom errors
		if (error instanceof NotFoundError || error instanceof NetworkError) {
			throw error
		}

		// Handle abort/timeout
		if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
			throw new NetworkError(`Request to npm registry timed out for package \`${packageName}\``)
		}

		// Wrap other errors
		const message = error instanceof Error ? error.message : String(error)
		throw new NetworkError(`Failed to fetch npm package \`${packageName}\`: ${message}`)
	}
}

/**
 * Format a plugin entry for opencode.json.
 * Returns the typed format: "package" or "package@version"
 */
export function formatPluginEntry(name: string, version?: string): string {
	return version ? `${name}@${version}` : name
}

// =============================================================================
// PLUGIN VALIDATION
// =============================================================================

/**
 * Validate that a package looks like a valid OpenCode plugin.
 *
 * Required checks (throws ValidationError if not met):
 * - ESM module: package.json must have "type": "module"
 * - Entry point: must have "main" or "exports" field
 *
 * Soft checks (returns warnings):
 * - Naming convention: warn if package name doesn't contain "opencode"
 *
 * @param packageJson - The package.json data from npm registry (version-specific)
 * @returns Validation result with any warnings
 * @throws ValidationError for hard failures
 */
export function validateOpenCodePlugin(packageJson: NpmPackageVersion): PluginValidationResult {
	const warnings: string[] = []

	// Guard: ESM module check - OpenCode uses Bun ESM imports
	if (packageJson.type !== "module") {
		throw new ValidationError(
			`Package \`${packageJson.name}\` is not an ESM module (missing "type": "module" in package.json)`,
		)
	}

	// Guard: Entry point check - needs to be importable
	const hasMain = Boolean(packageJson.main)
	const hasExports = packageJson.exports !== undefined
	if (!hasMain && !hasExports) {
		throw new ValidationError(
			`Package \`${packageJson.name}\` has no entry point (missing "main" or "exports")`,
		)
	}

	// Soft check: Naming convention hint
	if (!packageJson.name.includes("opencode")) {
		warnings.push(
			`Package name \`${packageJson.name}\` doesn't contain "opencode" - this may not be an OpenCode plugin`,
		)
	}

	return { valid: true, warnings }
}

/**
 * Fetch version-specific package.json from npm registry.
 *
 * @param packageName - The npm package name
 * @param version - The specific version (or "latest" to use dist-tags.latest)
 * @param signal - Optional AbortSignal for request cancellation
 * @returns Version-specific package.json fields
 * @throws NotFoundError if package/version doesn't exist
 * @throws NetworkError for fetch failures
 */
export async function fetchPackageVersion(
	packageName: string,
	version?: string,
	signal?: AbortSignal,
): Promise<NpmPackageVersion> {
	// First get package metadata to resolve version
	const metadata = await validateNpmPackage(packageName, signal)

	// Resolve version: use specified or latest
	const resolvedVersion = version ?? metadata["dist-tags"].latest

	// Get version-specific data
	const versionData = metadata.versions[resolvedVersion] as NpmPackageVersion | undefined
	if (!versionData) {
		throw new NotFoundError(
			`Version \`${resolvedVersion}\` not found for npm package \`${packageName}\``,
		)
	}

	return versionData
}

/**
 * Extract package name from a plugin entry string.
 * Handles: "lodash", "lodash@4.0.0", "@scope/pkg", "@scope/pkg@1.0.0"
 */
export function extractPackageName(pluginEntry: string): string {
	const trimmed = pluginEntry.trim()
	const lastAt = trimmed.lastIndexOf("@")

	// If @ is at position 0, it's a scoped package without version
	if (lastAt <= 0) {
		return trimmed
	}

	// Check if this @ is the version separator or part of scope
	const beforeAt = trimmed.slice(0, lastAt)

	// If beforeAt contains /, it's @scope/pkg@version
	// If beforeAt doesn't start with @, it's pkg@version
	if (beforeAt.includes("/") || !beforeAt.startsWith("@")) {
		return beforeAt
	}

	// Otherwise it's just @scope/pkg with weird format - return as-is
	return trimmed
}

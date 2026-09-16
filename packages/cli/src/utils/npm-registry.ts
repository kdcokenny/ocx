/** npm metadata used only by OCX releases and self-update. */
import { NetworkError, NotFoundError, ValidationError } from "./errors"
import { isValidSemver } from "./semver"

export interface NpmPackageMetadata {
	name: string
	"dist-tags": {
		[tag: string]: string
		latest: string
	}
	versions: Record<string, unknown>
}

export interface NpmPackageVersion {
	name: string
	version: string
}

export type ExactNpmVersionState =
	| { state: "published" }
	| { state: "missing" }
	| { state: "indeterminate-error"; reason: string }

/**
 * Injectable seam for exact npm version lookups.
 */
export type ExactNpmVersionLookup = (
	packageName: string,
	version: string,
	signal?: AbortSignal,
) => Promise<ExactNpmVersionState>

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
 * Exact npm `name@version` lookup.
 *
 * Uses `GET /<name>/<version>` as the source of truth and fails closed:
 * only a definitive 404 returns `missing`; all other irregular outcomes
 * return `indeterminate-error`.
 */
export const lookupExactNpmVersionState: ExactNpmVersionLookup = async (
	packageName,
	version,
	signal,
) => {
	try {
		validateNpmPackageName(packageName)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		return { state: "indeterminate-error", reason: `invalid-package-name:${message}` }
	}

	const trimmedVersion = version.trim()
	if (!isValidSemver(trimmedVersion)) {
		return {
			state: "indeterminate-error",
			reason: "invalid-version:exact-lookup-requires-semver",
		}
	}

	const encodedName = packageName.startsWith("@")
		? `@${encodeURIComponent(packageName.slice(1))}`
		: encodeURIComponent(packageName)
	const encodedVersion = encodeURIComponent(trimmedVersion)
	const url = `${NPM_REGISTRY_BASE}/${encodedName}/${encodedVersion}`

	try {
		const fetchSignal = signal ?? AbortSignal.timeout(NPM_FETCH_TIMEOUT_MS)
		const response = await fetch(url, {
			signal: fetchSignal,
			headers: { Accept: "application/json" },
		})

		if (response.status === 404) {
			return { state: "missing" }
		}

		if (!response.ok) {
			return {
				state: "indeterminate-error",
				reason: `http-${response.status}`,
			}
		}

		let payload: unknown
		try {
			payload = await response.json()
		} catch {
			return {
				state: "indeterminate-error",
				reason: "malformed-response:invalid-json",
			}
		}

		if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
			return {
				state: "indeterminate-error",
				reason: "malformed-response:non-object",
			}
		}

		const objectPayload = payload as Record<string, unknown>
		const responseName = objectPayload.name
		const responseVersion = objectPayload.version

		if (responseName !== packageName || responseVersion !== trimmedVersion) {
			return {
				state: "indeterminate-error",
				reason: "malformed-response:mismatched-name-or-version",
			}
		}

		return { state: "published" }
	} catch (error) {
		if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
			return { state: "indeterminate-error", reason: "timeout" }
		}

		const message = error instanceof Error ? error.message : String(error)
		return { state: "indeterminate-error", reason: `network:${message}` }
	}
}

export async function fetchPackageVersion(
	packageName: string,
	version?: string,
	signal?: AbortSignal,
): Promise<NpmPackageVersion> {
	// First get package metadata to resolve version
	const metadata = await validateNpmPackage(packageName, signal)

	// Resolve version: use specified or latest
	const resolvedVersion =
		version === undefined
			? metadata["dist-tags"].latest
			: (metadata["dist-tags"][version] ?? version)

	// Get version-specific data
	const versionData = metadata.versions[resolvedVersion] as NpmPackageVersion | undefined
	if (!versionData) {
		throw new NotFoundError(
			`Version \`${resolvedVersion}\` not found for npm package \`${packageName}\``,
		)
	}

	return versionData
}

/**
 * Registry Fetcher with in-memory caching
 * Based on: https://github.com/shadcn-ui/ui/blob/main/packages/shadcn/src/registry/fetcher.ts
 */

import { posix as posixPath } from "node:path"
import { z } from "zod"
import type { ComponentManifest, McpServer, RegistryIndex } from "../schemas/registry"
import {
	classifyRegistrySchemaIssue,
	componentManifestSchema,
	componentTypeSchema,
	packumentSchema,
	registryIndexSchema,
} from "../schemas/registry"
import {
	NetworkError,
	NotFoundError,
	type RegistryCompatIssue,
	RegistryCompatibilityError,
	ValidationError,
} from "../utils/errors"
import { isPlainObject } from "../utils/type-guards"
import { normalizeRegistryUrl } from "../utils/url"

// In-memory cache for deduplication
const cache = new Map<string, Promise<unknown>>()
type RegistrySchemaMode = "legacy-v1" | "v2"
const registrySchemaModeCache = new Map<string, RegistrySchemaMode>()

const LEGACY_COMPONENT_TYPE_ALIAS_MAP = {
	"ocx:agent": "agent",
	"ocx:skill": "skill",
	"ocx:plugin": "plugin",
	"ocx:command": "command",
	"ocx:tool": "tool",
	"ocx:bundle": "bundle",
	"ocx:profile": "profile",
} as const

const LEGACY_TARGET_KIND_MAP = {
	agent: "agents",
	skill: "skills",
	plugin: "plugins",
	command: "commands",
	tool: "tools",
	bundle: "bundles",
	profile: "profiles",
	philosophy: "tools",
} as const

const packumentEnvelopeSchema = packumentSchema.extend({
	versions: z.record(z.string(), z.unknown()),
})

function createCompatibilityError(
	url: string,
	classification: {
		issue: RegistryCompatIssue
		remediation: string
		schemaUrl?: string
		supportedMajor?: number
		detectedMajor?: number
	},
): RegistryCompatibilityError {
	return new RegistryCompatibilityError(
		`Registry at ${url} uses an incompatible format (${classification.issue}). ${classification.remediation}`,
		{
			url,
			issue: classification.issue,
			remediation: classification.remediation,
			...(classification.schemaUrl !== undefined && {
				schemaUrl: classification.schemaUrl,
			}),
			...(classification.supportedMajor !== undefined && {
				supportedMajor: classification.supportedMajor,
			}),
			...(classification.detectedMajor !== undefined && {
				detectedMajor: classification.detectedMajor,
			}),
		},
	)
}

function mapLegacyComponentType(type: unknown, context: string): string {
	if (typeof type !== "string") {
		throw new ValidationError(`Invalid ${context}: expected string, got ${typeof type}`)
	}

	const mappedType =
		LEGACY_COMPONENT_TYPE_ALIAS_MAP[type as keyof typeof LEGACY_COMPONENT_TYPE_ALIAS_MAP] ?? type
	const parsedType = componentTypeSchema.safeParse(mappedType)
	if (!parsedType.success) {
		throw new ValidationError(
			`Unsupported component type "${type}" in ${context}. ` +
				`Expected one of: ${componentTypeSchema.options.join(", ")}`,
		)
	}

	return parsedType.data
}

function isLegacyV2TypeAlias(type: unknown): type is keyof typeof LEGACY_COMPONENT_TYPE_ALIAS_MAP {
	return typeof type === "string" && Object.hasOwn(LEGACY_COMPONENT_TYPE_ALIAS_MAP, type)
}

function hasLegacyManifestTargetPrefix(target: string): boolean {
	return target.startsWith(".opencode/") || target.startsWith(".opencode\\")
}

function collectLegacyManifestTargetIssues(
	manifest: unknown,
): Array<{ path: string; target: string }> {
	if (!isPlainObject(manifest) || !Array.isArray(manifest.files)) {
		return []
	}

	const issues: Array<{ path: string; target: string }> = []

	for (const [index, file] of manifest.files.entries()) {
		if (typeof file === "string") {
			if (!hasLegacyManifestTargetPrefix(file)) {
				continue
			}

			issues.push({
				path: `files[${index}]`,
				target: file,
			})
			continue
		}

		if (!isPlainObject(file) || typeof file.target !== "string") {
			continue
		}

		if (!hasLegacyManifestTargetPrefix(file.target)) {
			continue
		}

		issues.push({
			path: `files[${index}].target`,
			target: file.target,
		})
	}

	return issues
}

function collectLegacyV2TypeIssues(data: unknown): Array<{
	path: string
	type: keyof typeof LEGACY_COMPONENT_TYPE_ALIAS_MAP
}> {
	if (!isPlainObject(data)) {
		return []
	}

	const components = data.components
	if (!Array.isArray(components)) {
		return []
	}

	const issues: Array<{
		path: string
		type: keyof typeof LEGACY_COMPONENT_TYPE_ALIAS_MAP
	}> = []

	for (const [index, component] of components.entries()) {
		if (!isPlainObject(component)) {
			continue
		}

		const type = component.type
		if (!isLegacyV2TypeAlias(type)) {
			continue
		}

		issues.push({ path: `components[${index}].type`, type })
	}

	return issues
}

function hasLegacySignalsInManifest(manifest: unknown): boolean {
	if (!isPlainObject(manifest)) {
		return false
	}

	if (typeof manifest.type === "string" && manifest.type.startsWith("ocx:")) {
		return true
	}

	return collectLegacyManifestTargetIssues(manifest).length > 0
}

async function resolveRegistrySchemaMode(baseUrl: string): Promise<RegistrySchemaMode | null> {
	const normalizedBaseUrl = normalizeRegistryUrl(baseUrl)
	const cachedMode = registrySchemaModeCache.get(normalizedBaseUrl)
	if (cachedMode) {
		return cachedMode
	}

	try {
		await fetchRegistryIndex(normalizedBaseUrl)
	} catch (error) {
		if (error instanceof NetworkError || error instanceof NotFoundError) {
			return null
		}

		throw error
	}

	if (!registrySchemaModeCache.has(normalizedBaseUrl)) {
		return null
	}

	const schemaMode = registrySchemaModeCache.get(normalizedBaseUrl)
	if (!schemaMode) {
		throw new Error(`Missing registry schema mode cache entry for ${normalizedBaseUrl}`)
	}

	return schemaMode
}

function canonicalizeLegacyTargetPath(rawTarget: string, context: string): string {
	if (rawTarget.includes("\0")) {
		throw new ValidationError(
			`Unsafe target "${rawTarget}" in ${context}: null bytes are not allowed`,
		)
	}

	if (rawTarget.includes("%")) {
		throw new ValidationError(
			`Unsafe target "${rawTarget}" in ${context}: encoded paths are not allowed`,
		)
	}

	if (rawTarget.includes("\\")) {
		throw new ValidationError(
			`Unsafe target "${rawTarget}" in ${context}: Windows separators are not allowed`,
		)
	}

	if (rawTarget.startsWith("/") || rawTarget.startsWith("//") || /^[a-zA-Z]:/.test(rawTarget)) {
		throw new ValidationError(
			`Unsafe target "${rawTarget}" in ${context}: absolute paths are not allowed`,
		)
	}

	const withoutPrefix = rawTarget.startsWith(".opencode/")
		? rawTarget.slice(".opencode/".length)
		: rawTarget

	if (!withoutPrefix) {
		throw new ValidationError(
			`Unsafe target "${rawTarget}" in ${context}: missing path after .opencode/`,
		)
	}

	const segments = withoutPrefix.split("/")
	if (segments.some((segment) => segment.length === 0)) {
		throw new ValidationError(
			`Unsafe target "${rawTarget}" in ${context}: empty path segments are not allowed`,
		)
	}

	if (segments.some((segment) => segment === "." || segment === "..")) {
		throw new ValidationError(
			`Unsafe target "${rawTarget}" in ${context}: traversal segments are not allowed`,
		)
	}

	const [firstSegment, ...restSegments] = segments
	if (!firstSegment) {
		throw new ValidationError(
			`Unsafe target "${rawTarget}" in ${context}: missing path root segment`,
		)
	}

	const mappedRoot = LEGACY_TARGET_KIND_MAP[firstSegment as keyof typeof LEGACY_TARGET_KIND_MAP]
	const rewrittenTarget = [mappedRoot ?? firstSegment, ...restSegments].join("/")

	const normalized = posixPath.normalize(rewrittenTarget)
	if (normalized !== rewrittenTarget) {
		throw new ValidationError(
			`Unsafe target "${rawTarget}" in ${context}: path normalization is ambiguous`,
		)
	}

	if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
		throw new ValidationError(
			`Unsafe target "${rawTarget}" in ${context}: target escapes project root`,
		)
	}

	return normalized
}

function adaptLegacyComponentManifest(manifest: unknown, context: string): unknown {
	if (!isPlainObject(manifest)) return manifest

	const adaptedManifest: Record<string, unknown> = { ...manifest }

	if (Object.hasOwn(adaptedManifest, "type")) {
		adaptedManifest.type = mapLegacyComponentType(adaptedManifest.type, `${context}.type`)
	}

	if (Array.isArray(adaptedManifest.files)) {
		adaptedManifest.files = adaptedManifest.files.map((file, index) => {
			if (typeof file === "string") {
				if (!hasLegacyManifestTargetPrefix(file)) {
					return file
				}

				return canonicalizeLegacyTargetPath(file, `${context}.files[${index}]`)
			}

			if (!isPlainObject(file)) return file

			const target = file.target
			if (typeof target !== "string") return file

			const isLegacyTarget = hasLegacyManifestTargetPrefix(target)
			if (!isLegacyTarget) return file

			return {
				...file,
				target: canonicalizeLegacyTargetPath(target, `${context}.files[${index}].target`),
			}
		})
	}

	return adaptedManifest
}

function adaptLegacyRegistryIndex(data: unknown, url: string): unknown {
	if (!isPlainObject(data)) {
		throw new RegistryCompatibilityError(
			`Registry at ${url} uses legacy schema v1 but does not expose an object index payload.`,
			{
				url,
				issue: "legacy-schema-v1",
				remediation:
					"Publish an object index with author/components fields, or upgrade to schema v2.",
			},
		)
	}

	const components = data.components
	if (!Array.isArray(components)) {
		throw new RegistryCompatibilityError(
			`Registry at ${url} uses legacy schema v1 but the components field is missing or invalid.`,
			{
				url,
				issue: "legacy-schema-v1",
				remediation: "Ensure the legacy index has a components array, or upgrade to schema v2.",
			},
		)
	}

	const adaptedComponents = components.map((component, index) => {
		if (!isPlainObject(component)) {
			throw new ValidationError(
				`Invalid index component at components[${index}]: expected object, got ${typeof component}`,
			)
		}

		const name = component.name
		const description = component.description
		if (typeof name !== "string") {
			throw new ValidationError(`Invalid index component name at components[${index}].name`)
		}
		if (typeof description !== "string") {
			throw new ValidationError(
				`Invalid index component description at components[${index}].description`,
			)
		}

		return {
			name,
			type: mapLegacyComponentType(component.type, `components[${index}].type`),
			description,
		}
	})

	return {
		...data,
		components: adaptedComponents,
	}
}

/**
 * Fetch with caching - deduplicates concurrent requests
 */
async function fetchWithCache<T>(
	cacheKey: string,
	parse: (data: unknown) => T | Promise<T>,
	options: {
		phase?: string
		requestUrl?: string
	} = {},
): Promise<T> {
	const cached = cache.get(cacheKey)
	if (cached) {
		return cached as Promise<T>
	}

	const requestUrl = options.requestUrl ?? cacheKey

	const promise = (async () => {
		const networkErrorContext = {
			url: requestUrl,
			phase: options.phase,
		}

		let response: Response
		try {
			response = await fetch(requestUrl)
		} catch (error) {
			throw new NetworkError(
				`Network request failed for ${requestUrl}: ${error instanceof Error ? error.message : String(error)}`,
				networkErrorContext,
			)
		}

		if (!response.ok) {
			if (response.status === 404) {
				throw new NotFoundError(`Not found: ${requestUrl}`)
			}
			throw new NetworkError(
				`Failed to fetch ${requestUrl}: ${response.status} ${response.statusText}`,
				{
					...networkErrorContext,
					status: response.status,
					statusText: response.statusText,
				},
			)
		}

		let data: unknown
		try {
			data = await response.json()
		} catch (error) {
			throw new NetworkError(
				`Invalid JSON response from ${requestUrl}: ${error instanceof Error ? error.message : String(error)}`,
				networkErrorContext,
			)
		}

		return await parse(data)
	})()

	cache.set(cacheKey, promise)

	// Clean up cache on error
	promise.catch(() => cache.delete(cacheKey))

	return promise
}

/**
 * Classify registry index schema compatibility from parsed JSON data.
 * Returns null when the schema URL is compatible.
 */
export function classifyRegistryIndexIssue(data: unknown): {
	issue: RegistryCompatIssue
	remediation: string
	schemaUrl?: string
	supportedMajor?: number
	detectedMajor?: number
} | null {
	const issue = classifyRegistrySchemaIssue(data)
	if (!issue) return null

	return {
		issue: issue.issue,
		remediation: issue.remediation,
		schemaUrl: issue.schemaUrl,
		supportedMajor: issue.supportedMajor,
		detectedMajor: issue.detectedMajor,
	}
}

/**
 * Fetch registry index
 */
export async function fetchRegistryIndex(baseUrl: string): Promise<RegistryIndex> {
	const normalizedBaseUrl = normalizeRegistryUrl(baseUrl)
	const url = `${normalizedBaseUrl}/index.json`

	return fetchWithCache(
		url,
		(data) => {
			// Pre-schema classification: detect known incompatible formats
			const classification = classifyRegistryIndexIssue(data)

			if (classification && classification.issue !== "legacy-schema-v1") {
				throw createCompatibilityError(url, classification)
			}

			let candidateData = data
			let schemaMode: RegistrySchemaMode = "v2"
			if (classification?.issue === "legacy-schema-v1") {
				schemaMode = "legacy-v1"
				try {
					candidateData = adaptLegacyRegistryIndex(data, url)
				} catch (error) {
					if (error instanceof RegistryCompatibilityError) {
						throw error
					}

					const reason = error instanceof Error ? error.message : String(error)
					throw new RegistryCompatibilityError(
						`Registry at ${url} uses legacy schema v1 but cannot be adapted safely. ${reason}`,
						{
							url,
							issue: "invalid-format",
							remediation:
								"Fix the legacy payload shape (types/descriptions/components) or upgrade the registry to v2.",
						},
					)
				}
			} else {
				const legacyTypeIssues = collectLegacyV2TypeIssues(candidateData)
				if (legacyTypeIssues.length > 0) {
					const firstIssue = legacyTypeIssues[0]
					if (!firstIssue) {
						throw new Error("Unexpected missing legacy type issue")
					}

					const canonicalType = LEGACY_COMPONENT_TYPE_ALIAS_MAP[firstIssue.type]
					throw new RegistryCompatibilityError(
						`Registry at ${url} uses legacy component type "${firstIssue.type}" in ${firstIssue.path}. Use "${canonicalType}" for v2 registries.`,
						{
							url,
							issue: "invalid-format",
							remediation: `Replace legacy type "${firstIssue.type}" with canonical "${canonicalType}" in v2 manifests.`,
						},
					)
				}
			}

			const result = registryIndexSchema.safeParse(candidateData)
			if (!result.success) {
				throw new RegistryCompatibilityError(
					`Registry at ${url} returned an unrecognized index format. Ensure it follows the OCX registry specification. Schema error: ${result.error.message}`,
					{
						url,
						issue: "invalid-format",
						remediation:
							"Ensure the registry index follows the OCX registry specification. " +
							`Schema error: ${result.error.message}`,
					},
				)
			}

			registrySchemaModeCache.set(normalizedBaseUrl, schemaMode)
			return result.data
		},
		{ phase: "registry-index-fetch" },
	)
}

/**
 * Fetch a component from registry and return the latest manifest
 */
export async function fetchComponent(baseUrl: string, name: string): Promise<ComponentManifest> {
	const result = await fetchComponentVersion(baseUrl, name)
	return result.manifest
}

/**
 * Fetch a component from registry with specific or latest version.
 * Returns both the manifest and the resolved version.
 */
export async function fetchComponentVersion(
	baseUrl: string,
	name: string,
	version?: string,
): Promise<{ manifest: ComponentManifest; version: string }> {
	const url = `${normalizeRegistryUrl(baseUrl)}/components/${name}.json`

	return fetchWithCache(
		`${url}#v=${version ?? "latest"}`,
		async (data) => {
			// 1. Parse as packument
			const packumentResult = packumentEnvelopeSchema.safeParse(data)
			if (!packumentResult.success) {
				throw new ValidationError(
					`Invalid packument format for "${name}": ${packumentResult.error.message}`,
				)
			}

			const packument = packumentResult.data

			// 2. Resolve version (specific or latest)
			const resolvedVersion = version ?? packument["dist-tags"].latest
			const manifest = packument.versions[resolvedVersion]

			if (!manifest) {
				if (version) {
					const availableVersions = Object.keys(packument.versions).join(", ")
					throw new ValidationError(
						`Component "${name}" has no version "${version}". Available: ${availableVersions}`,
					)
				}
				throw new ValidationError(
					`Component "${name}" has no manifest for latest version ${resolvedVersion}`,
				)
			}

			// 3. Validate manifest (legacy adaptation is version-gated)
			const context = `component "${name}@${resolvedVersion}"`
			let candidateManifest: unknown = manifest

			if (hasLegacySignalsInManifest(manifest)) {
				const schemaMode = await resolveRegistrySchemaMode(baseUrl)

				if (schemaMode !== "v2") {
					candidateManifest = adaptLegacyComponentManifest(manifest, context)
				} else {
					const legacyTargetIssues = collectLegacyManifestTargetIssues(manifest)
					const firstLegacyTargetIssue = legacyTargetIssues[0]
					if (firstLegacyTargetIssue) {
						throw new ValidationError(
							`Invalid component manifest for "${name}@${resolvedVersion}": target "${firstLegacyTargetIssue.target}" at ${firstLegacyTargetIssue.path} uses a legacy .opencode/ prefix. ` +
								`For v2 registries, use canonical root-relative targets like "plugins/...", "profiles/...", "agents/...", "skills/...", or "commands/..." (without .opencode/).`,
						)
					}

					if (isPlainObject(manifest) && isLegacyV2TypeAlias(manifest.type)) {
						const canonicalType = LEGACY_COMPONENT_TYPE_ALIAS_MAP[manifest.type]
						throw new ValidationError(
							`Invalid component manifest for "${name}@${resolvedVersion}": type "${manifest.type}" is a legacy v1 alias. Use "${canonicalType}" for v2 registries.`,
						)
					}
				}
			}

			const manifestResult = componentManifestSchema.safeParse(candidateManifest)
			if (!manifestResult.success) {
				throw new ValidationError(
					`Invalid component manifest for "${name}@${resolvedVersion}": ${manifestResult.error.message}`,
				)
			}

			return { manifest: manifestResult.data, version: resolvedVersion }
		},
		{ phase: "packument-fetch", requestUrl: url },
	)
}

/**
 * Fetch actual file content from registry
 */
export async function fetchFileContent(
	baseUrl: string,
	componentName: string,
	filePath: string,
): Promise<string> {
	const url = `${normalizeRegistryUrl(baseUrl)}/components/${componentName}/${filePath}`
	const networkErrorContext = {
		url,
		phase: "file-content-fetch",
		qualifiedName: componentName,
	} as const

	let response: Response
	try {
		response = await fetch(url)
	} catch (error) {
		throw new NetworkError(
			`Network request failed for ${url}: ${error instanceof Error ? error.message : String(error)}`,
			networkErrorContext,
		)
	}

	if (!response.ok) {
		throw new NetworkError(
			`Failed to fetch file ${filePath} for ${componentName} from ${url}: ${response.status} ${response.statusText}`,
			{
				...networkErrorContext,
				status: response.status,
				statusText: response.statusText,
			},
		)
	}

	return response.text()
}

// Re-export types for convenience
export type { ComponentManifest, McpServer, RegistryIndex }

/** @internal Clear cache for testing purposes only */
export function _clearFetcherCacheForTests(): void {
	cache.clear()
	registrySchemaModeCache.clear()
}

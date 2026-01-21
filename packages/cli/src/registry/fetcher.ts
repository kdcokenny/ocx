/**
 * Registry Fetcher with in-memory caching
 * Based on: https://github.com/shadcn-ui/ui/blob/main/packages/shadcn/src/registry/fetcher.ts
 */

import type { ComponentManifest, McpServer, RegistryIndex } from "../schemas/registry"
import { componentManifestSchema, packumentSchema, registryIndexSchema } from "../schemas/registry"
import { NetworkError, NotFoundError, ValidationError } from "../utils/errors"

// In-memory cache for deduplication
const cache = new Map<string, Promise<unknown>>()

/**
 * Fetch with caching - deduplicates concurrent requests
 */
async function fetchWithCache<T>(url: string, parse: (data: unknown) => T): Promise<T> {
	const cached = cache.get(url)
	if (cached) {
		return cached as Promise<T>
	}

	const promise = (async () => {
		const response = await fetch(url)

		if (!response.ok) {
			if (response.status === 404) {
				throw new NotFoundError(`Not found: ${url}`)
			}
			throw new NetworkError(`Failed to fetch ${url}: ${response.status} ${response.statusText}`)
		}

		const data = await response.json()
		return parse(data)
	})()

	cache.set(url, promise)

	// Clean up cache on error
	promise.catch(() => cache.delete(url))

	return promise
}

/**
 * Fetch registry index
 */
export async function fetchRegistryIndex(baseUrl: string): Promise<RegistryIndex> {
	const url = `${baseUrl.replace(/\/$/, "")}/index.json`

	return fetchWithCache(url, (data) => {
		const result = registryIndexSchema.safeParse(data)
		if (!result.success) {
			throw new ValidationError(`Invalid registry format at ${url}: ${result.error.message}`)
		}
		return result.data
	})
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
	const url = `${baseUrl.replace(/\/$/, "")}/components/${name}.json`

	return fetchWithCache(`${url}#v=${version ?? "latest"}`, (data) => {
		// 1. Parse as packument
		const packumentResult = packumentSchema.safeParse(data)
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

		// 3. Validate manifest
		const manifestResult = componentManifestSchema.safeParse(manifest)
		if (!manifestResult.success) {
			throw new ValidationError(
				`Invalid component manifest for "${name}@${resolvedVersion}": ${manifestResult.error.message}`,
			)
		}

		return { manifest: manifestResult.data, version: resolvedVersion }
	})
}

/**
 * Fetch actual file content from registry
 */
export async function fetchFileContent(
	baseUrl: string,
	componentName: string,
	filePath: string,
): Promise<string> {
	const url = `${baseUrl.replace(/\/$/, "")}/components/${componentName}/${filePath}`

	const response = await fetch(url)
	if (!response.ok) {
		throw new NetworkError(
			`Failed to fetch file ${filePath} for ${componentName}: ${response.status} ${response.statusText}`,
		)
	}

	return response.text()
}

// Re-export types for convenience
export type { ComponentManifest, RegistryIndex, McpServer }

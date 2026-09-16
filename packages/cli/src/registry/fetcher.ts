import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { record, string, unknown } from "zod"
import {
	type ComponentManifest,
	classifyRegistrySchemaIssue,
	componentManifestSchema,
	openCodeNameSchema,
	packumentSchema,
	type RegistryIndex,
	registryIndexSchema,
	validateSafePath,
} from "../schemas/registry"
import {
	NetworkError,
	NotFoundError,
	RegistryCompatibilityError,
	ValidationError,
} from "../utils/errors"
import { normalizeRegistryUrl } from "../utils/url"

export interface FetchOptions {
	headers?: Record<string, string>
}
const cache = new Map<string, Promise<unknown>>()
const REQUEST_TIMEOUT_MS = 15000
const packumentEnvelopeSchema = packumentSchema.extend({ versions: record(string(), unknown()) })

function requestHeaders(options: FetchOptions): Record<string, string> {
	return Object.fromEntries(
		Object.entries(options.headers ?? {}).map(([name, value]) => [
			name,
			value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => {
				const resolved = process.env[key]
				if (resolved === undefined)
					throw new ValidationError(`Registry header requires environment variable ${key}`)
				return resolved
			}),
		]),
	)
}

async function request(url: string, options: FetchOptions): Promise<Buffer> {
	const parsed = new URL(url)
	if (parsed.protocol === "file:") {
		try {
			return await readFile(fileURLToPath(parsed))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				throw new NotFoundError(`Not found: ${url}`)
			throw new NetworkError(`Cannot read registry file ${url}`, { url })
		}
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
		throw new ValidationError("Registry URLs must use https, http, or file")
	const headers = requestHeaders(options)
	let response: Response
	try {
		response = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
	} catch (error) {
		throw new NetworkError(
			`Network request failed for ${url}: ${error instanceof Error ? error.message : String(error)}`,
			{ url },
		)
	}
	if (response.status === 404) throw new NotFoundError(`Not found: ${url}`)
	if (!response.ok)
		throw new NetworkError(`Failed to fetch ${url}: ${response.status} ${response.statusText}`, {
			url,
			status: response.status,
			statusText: response.statusText,
		})
	return Buffer.from(await response.arrayBuffer())
}

async function fetchJson<T>(
	url: string,
	parse: (data: unknown) => T,
	options: FetchOptions,
	variant = "",
): Promise<T> {
	const headerHash = createHash("sha256")
		.update(JSON.stringify(requestHeaders(options)))
		.digest("hex")
	const key = `${url}#${variant}:${headerHash}`
	const existing = cache.get(key)
	if (existing) return existing as Promise<T>
	const pending = (async () => {
		const bytes = await request(url, options)
		let data: unknown
		try {
			data = JSON.parse(bytes.toString("utf8"))
		} catch {
			throw new NetworkError(`Invalid JSON response from ${url}`, { url })
		}
		return parse(data)
	})()
	cache.set(key, pending)
	pending.catch(() => cache.delete(key))
	return pending
}

export const classifyRegistryIndexIssue = classifyRegistrySchemaIssue

export async function fetchRegistryIndex(
	baseUrl: string,
	options: FetchOptions = {},
): Promise<RegistryIndex> {
	const url = `${normalizeRegistryUrl(baseUrl)}/index.json`
	return fetchJson(
		url,
		(data) => {
			const issue = classifyRegistrySchemaIssue(data)
			if (issue)
				throw new RegistryCompatibilityError(
					`Registry at ${url} uses an incompatible format. ${issue.remediation}`,
					{ url, ...issue },
				)
			const parsed = registryIndexSchema.safeParse(data)
			if (!parsed.success)
				throw new RegistryCompatibilityError(
					`Invalid registry index at ${url}: ${parsed.error.message}`,
					{
						url,
						issue: "invalid-format",
						remediation: "Publish a valid file-only OCX 3 registry index.",
					},
				)
			return parsed.data
		},
		options,
	)
}

export async function fetchComponent(
	baseUrl: string,
	name: string,
	options: FetchOptions = {},
): Promise<ComponentManifest> {
	return (await fetchComponentVersion(baseUrl, name, undefined, options)).manifest
}

export async function fetchComponentVersion(
	baseUrl: string,
	name: string,
	version?: string,
	options: FetchOptions = {},
): Promise<{ manifest: ComponentManifest; version: string }> {
	if (!openCodeNameSchema.safeParse(name).success)
		throw new ValidationError(`Invalid component name "${name}"`)
	await fetchRegistryIndex(baseUrl, options)
	const url = `${normalizeRegistryUrl(baseUrl)}/components/${name}.json`
	return fetchJson(
		url,
		(data) => {
			const parsed = packumentEnvelopeSchema.safeParse(data)
			if (!parsed.success || parsed.data.name !== name)
				throw new ValidationError(`Invalid packument for "${name}"`)
			const revision = version ?? parsed.data["dist-tags"].latest
			const raw = parsed.data.versions[revision]
			if (!raw) throw new NotFoundError(`Component "${name}" has no version "${revision}"`)
			const manifest = componentManifestSchema.safeParse(raw)
			if (!manifest.success)
				throw new ValidationError(
					`Invalid component "${name}@${revision}": ${manifest.error.message}. OCX 3 components cannot patch config or install npm dependencies.`,
				)
			if (manifest.data.name !== name)
				throw new ValidationError(`Manifest name does not match requested component "${name}"`)
			return { manifest: manifest.data, version: revision }
		},
		options,
		version ?? "latest",
	)
}

export async function fetchFileContent(
	baseUrl: string,
	componentName: string,
	filePath: string,
	options: FetchOptions = {},
): Promise<Buffer> {
	if (!openCodeNameSchema.safeParse(componentName).success)
		throw new ValidationError(`Invalid component name "${componentName}"`)
	validateSafePath(filePath)
	const encodedPath = filePath.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/")
	return request(
		`${normalizeRegistryUrl(baseUrl)}/components/${componentName}/${encodedPath}`,
		options,
	)
}

export type { ComponentManifest, RegistryIndex }
/** @internal Reset request deduplication between independent test registries. */
export function _clearFetcherCacheForTests(): void {
	cache.clear()
}

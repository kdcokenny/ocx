import type { Context } from "hono"
import { Hono } from "hono"
import { etag } from "hono/etag"
import { logger } from "hono/logger"
import { secureHeaders } from "hono/secure-headers"
import { trimTrailingSlash } from "hono/trailing-slash"
import localSchema from "../../../docs/schemas/local.schema.json"
import lockSchema from "../../../docs/schemas/lock.schema.json"
import ocxSchema from "../../../docs/schemas/ocx.schema.json"
import profileSchema from "../../../docs/schemas/profile.schema.json"
import receiptSchema from "../../../docs/schemas/receipt.schema.json"
import registrySchemaV2 from "../../../docs/schemas/registry.schema.json"
import registrySchemaV1 from "../../../docs/schemas/registry.v1.schema.json"

const MINTLIFY_HOST = "kdco.mintlify.dev"
const MINTLIFY_ORIGIN = `https://${MINTLIFY_HOST}`
const MINTLIFY_FETCH_TIMEOUT_MS = 8_000
const ALLOWED_MINTLIFY_METHODS = new Set(["GET", "HEAD", "OPTIONS", "POST"])
const ALLOWED_MINTLIFY_METHODS_HEADER = "GET, HEAD, OPTIONS, POST"
const DEFAULT_SCHEMA_CACHE_CONTROL = "public, max-age=300, s-maxage=3600"
const LATEST_SCHEMA_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=86400"
const VERSIONED_SCHEMA_CACHE_CONTROL = "public, max-age=31536000, immutable"

const VALID_SCHEMAS = ["ocx", "profile", "local", "lock", "registry", "receipt"] as const
const MINTLIFY_ROOT_DOC_PREFIXES = [
	"getting-started",
	"profiles",
	"cli",
	"registries",
	"reference",
	"guides",
	"integrations",
	"enterprise",
	"security",
	"maintainers",
] as const
const MINTLIFY_ROOT_DOC_PREFIX_SET = new Set<string>(MINTLIFY_ROOT_DOC_PREFIXES)
type SchemaName = (typeof VALID_SCHEMAS)[number]

const REGISTRY_SCHEMAS_BY_VERSION = {
	v1: registrySchemaV1,
	v2: registrySchemaV2,
} as const

const SCHEMA_PAYLOADS: Record<SchemaName, unknown> = {
	ocx: ocxSchema,
	profile: profileSchema,
	local: localSchema,
	lock: lockSchema,
	registry: registrySchemaV2,
	receipt: receiptSchema,
}

type DocsRedirectSurface = "docs-prefixed" | "root-level"

type MintlifyProxyRequest =
	| {
			kind: "docs"
			upstreamPathname: string
			redirectSurface: DocsRedirectSurface
	  }
	| {
			kind: "vercel"
			upstreamPathname: string
	  }

type NormalizedOriginTuple = {
	scheme: "http" | "https"
	host: string
	port: string
}

const SAFE_MINTLIFY_REQUEST_HEADERS = [
	"Accept",
	"Accept-Charset",
	"Accept-Encoding",
	"Accept-Language",
	"Cache-Control",
	"Pragma",
	"If-Match",
	"If-None-Match",
	"If-Modified-Since",
	"If-Unmodified-Since",
	"If-Range",
	"Range",
	"Content-Type",
	"Content-Length",
	"Content-Encoding",
	"Content-Language",
	"Content-Disposition",
] as const

const SENSITIVE_MINTLIFY_REQUEST_HEADERS = [
	"Authorization",
	"Proxy-Authorization",
	"Cookie",
	"CF-Access-Jwt-Assertion",
	"CF-Access-Client-Id",
	"CF-Access-Client-Secret",
	"X-Api-Key",
	"Api-Key",
	"X-Auth-Token",
	"X-Session-Id",
	"X-Csrf-Token",
	"X-Amzn-Oidc-Data",
	"X-Amzn-Oidc-Accesstoken",
] as const

const MINTLIFY_UPSTREAM_TUPLE = (() => {
	const tuple = normalizeOriginTuple(new URL(MINTLIFY_ORIGIN))
	if (!tuple) {
		throw new Error("Mintlify origin must use http/https")
	}
	return tuple
})()

function canonicalizePathname(pathname: string): string {
	const slashNormalizedPathname = pathname.replaceAll("\\", "/")
	let decodedPathname = slashNormalizedPathname

	try {
		decodedPathname = decodeURIComponent(slashNormalizedPathname)
	} catch {
		decodedPathname = slashNormalizedPathname
	}

	const normalizedSlashes = decodedPathname.replaceAll("\\", "/").replace(/\/{2,}/g, "/")
	const hadTrailingSlash = normalizedSlashes.endsWith("/")
	const normalizedSegments: string[] = []

	for (const segment of normalizedSlashes.split("/")) {
		if (!segment || segment === ".") continue
		if (segment === "..") {
			normalizedSegments.pop()
			continue
		}
		normalizedSegments.push(segment)
	}

	let canonicalPathname = `/${normalizedSegments.join("/")}`
	if (canonicalPathname !== "/" && hadTrailingSlash) {
		canonicalPathname = `${canonicalPathname}/`
	}

	return canonicalPathname
}

function hasUnsafeRootDocsPath(pathname: string): boolean {
	const normalizedPathname = pathname.toLowerCase()
	if (pathname.includes("\\") || normalizedPathname.includes("%5c")) return true
	if (normalizedPathname.includes("%2f") || normalizedPathname.includes("%2e")) return true
	if (pathname.includes("//")) return true

	for (const segment of pathname.split("/")) {
		if (!segment) continue
		if (segment === "." || segment === "..") return true
	}

	return false
}

function getRootPathPrefix(pathname: string): string | null {
	const firstSlashIndex = pathname.indexOf("/", 1)
	if (firstSlashIndex === -1) {
		return pathname.length > 1 ? pathname.slice(1) : null
	}

	if (firstSlashIndex === 1) return null
	return pathname.slice(1, firstSlashIndex)
}

function classifyMintlifyProxyRequest(pathname: string): MintlifyProxyRequest | null {
	const canonicalPathname = canonicalizePathname(pathname)

	if (canonicalPathname === "/docs" || canonicalPathname.startsWith("/docs/")) {
		return {
			kind: "docs",
			upstreamPathname: canonicalPathname,
			redirectSurface: "docs-prefixed",
		}
	}

	if (canonicalPathname.startsWith("/.well-known/vercel/")) {
		return {
			kind: "vercel",
			upstreamPathname: canonicalPathname,
		}
	}

	if (hasUnsafeRootDocsPath(pathname)) return null

	const rootPathPrefix = getRootPathPrefix(pathname)
	if (!rootPathPrefix || !MINTLIFY_ROOT_DOC_PREFIX_SET.has(rootPathPrefix)) return null

	return {
		kind: "docs",
		upstreamPathname: pathname,
		redirectSurface: "root-level",
	}
}

function normalizeOriginTuple(url: URL): NormalizedOriginTuple | null {
	const scheme = url.protocol.slice(0, -1).toLowerCase()
	if (scheme !== "http" && scheme !== "https") return null

	const normalizedHost = url.hostname.toLowerCase().replace(/\.+$/, "")
	const normalizedPort = url.port || (scheme === "https" ? "443" : "80")

	return {
		scheme,
		host: normalizedHost,
		port: normalizedPort,
	}
}

function sanitizeMintlifyHostLeak(value: string, originUrl: URL): string {
	return value
		.replace(/https?:\/\/([a-z0-9-]+\.)*mintlify\.(?:app|dev)(?::\d+)?/gi, originUrl.origin)
		.replace(/([a-z0-9-]+\.)*mintlify\.(?:app|dev)(?::\d+)?/gi, originUrl.host)
}

function sanitizeFailureHeaders(headers: Headers, originUrl: URL): Headers {
	const sanitizedHeaders = new Headers()
	for (const [name, value] of headers.entries()) {
		sanitizedHeaders.set(name, sanitizeMintlifyHostLeak(value, originUrl))
	}
	return sanitizedHeaders
}

function createProxyFailureResponse(status: 502 | 504, originUrl: URL): Response {
	const headers = sanitizeFailureHeaders(
		new Headers({
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "no-store",
		}),
		originUrl,
	)

	return new Response(sanitizeMintlifyHostLeak("Documentation service unavailable", originUrl), {
		status,
		headers,
	})
}

function buildMintlifyRequestHeaders(c: Context<{ Bindings: Env }>, originUrl: URL): Headers {
	const headers = new Headers()

	for (const headerName of SAFE_MINTLIFY_REQUEST_HEADERS) {
		const value = c.req.header(headerName)
		if (value) {
			headers.set(headerName, value)
		}
	}

	for (const headerName of SENSITIVE_MINTLIFY_REQUEST_HEADERS) {
		headers.delete(headerName)
	}

	for (const headerName of [...headers.keys()]) {
		const lowerCaseHeaderName = headerName.toLowerCase()
		if (
			lowerCaseHeaderName === "forwarded" ||
			lowerCaseHeaderName === "host" ||
			lowerCaseHeaderName === "cf-connecting-ip" ||
			lowerCaseHeaderName === "x-real-ip" ||
			lowerCaseHeaderName.startsWith("x-forwarded-") ||
			lowerCaseHeaderName.startsWith("cf-access-")
		) {
			headers.delete(headerName)
		}
	}

	headers.set("Origin", MINTLIFY_ORIGIN)
	headers.set("X-Forwarded-Host", originUrl.host)
	headers.set("X-Forwarded-Proto", originUrl.protocol.slice(0, -1))

	const trustedClientIp = c.req.header("CF-Connecting-IP")
	if (trustedClientIp) {
		headers.set("X-Forwarded-For", trustedClientIp)
		headers.set("X-Real-IP", trustedClientIp)
	} else {
		headers.delete("X-Forwarded-For")
		headers.delete("X-Real-IP")
	}

	const userAgent = c.req.header("User-Agent")
	if (userAgent) {
		headers.set("User-Agent", userAgent)
	} else {
		headers.delete("User-Agent")
	}

	return headers
}

function getDocsRedirectPath(pathname: string, redirectSurface: DocsRedirectSurface): string {
	let docsPath = canonicalizePathname(pathname)

	while (docsPath.startsWith("/docs/docs/")) {
		docsPath = `/docs/${docsPath.slice("/docs/docs/".length)}`
	}

	if (docsPath === "/docs/docs" || docsPath === "/docs/docs/") {
		docsPath = "/docs"
	}

	if (docsPath.startsWith("/.well-known/vercel/")) return docsPath

	if (redirectSurface === "docs-prefixed") {
		if (docsPath === "/") return "/docs"
		if (docsPath === "/docs/") return "/docs"
		if (docsPath === "/docs" || docsPath.startsWith("/docs/")) return docsPath
		return `/docs${docsPath}`
	}

	if (docsPath === "/docs" || docsPath === "/docs/") return "/docs"
	if (docsPath.startsWith("/docs/")) return docsPath.slice("/docs".length)
	return docsPath
}

function rewriteMintlifyLocation(
	location: string,
	originUrl: URL,
	upstreamUrl: URL,
	proxyRequest: MintlifyProxyRequest,
): string {
	let resolvedLocation: URL
	try {
		resolvedLocation = new URL(location, upstreamUrl)
	} catch {
		return location
	}

	const locationTuple = normalizeOriginTuple(resolvedLocation)
	if (!locationTuple) return location

	if (
		locationTuple.scheme !== MINTLIFY_UPSTREAM_TUPLE.scheme ||
		locationTuple.host !== MINTLIFY_UPSTREAM_TUPLE.host ||
		locationTuple.port !== MINTLIFY_UPSTREAM_TUPLE.port
	) {
		return location
	}

	const rewrittenLocation = new URL(resolvedLocation.toString())
	rewrittenLocation.protocol = originUrl.protocol
	rewrittenLocation.host = originUrl.host

	if (proxyRequest.kind === "docs") {
		rewrittenLocation.pathname = getDocsRedirectPath(
			rewrittenLocation.pathname,
			proxyRequest.redirectSurface,
		)
	} else {
		rewrittenLocation.pathname = canonicalizePathname(rewrittenLocation.pathname)
	}

	return rewrittenLocation.toString()
}

function isAbortError(error: unknown): boolean {
	if (error instanceof DOMException) return error.name === "AbortError"
	if (error instanceof Error) return error.name === "AbortError"
	return false
}

function respondWithSchema(
	c: Context<{ Bindings: Env }>,
	schemaPayload: unknown,
	cacheControl: string,
): Response {
	return c.json(schemaPayload, 200, {
		"Cache-Control": cacheControl,
		Vary: "Accept-Encoding",
	})
}

const app = new Hono<{ Bindings: Env }>()
const normalizeTrailingSlash = trimTrailingSlash()
const withEtag = etag()

app.use("*", logger())
app.use("*", secureHeaders())
// Skip trailing-slash normalization for Mintlify-managed paths
app.use("*", async (c, next) => {
	const proxyRequest = classifyMintlifyProxyRequest(new URL(c.req.url).pathname)
	if (proxyRequest) return next()
	return normalizeTrailingSlash(c, next)
})
app.use("*", async (c, next) => {
	const proxyRequest = classifyMintlifyProxyRequest(new URL(c.req.url).pathname)
	if (proxyRequest) return next()
	return withEtag(c, next)
})

app.get("/", (c) => {
	return c.redirect(`https://github.com/${c.env.GITHUB_REPO}`)
})

app.get("/install.sh", async (c) => {
	const githubRawBase = `https://raw.githubusercontent.com/${c.env.GITHUB_REPO}/${c.env.GITHUB_BRANCH}`
	const response = await fetch(`${githubRawBase}/packages/cli/scripts/install.sh`)
	if (!response.ok) {
		return c.text("Install script not found", 404)
	}
	const content = await response.text()
	return c.text(content, 200, {
		"Content-Type": "text/plain; charset=utf-8",
		"Cache-Control": "public, max-age=300, must-revalidate",
		"Content-Disposition": 'inline; filename="install.sh"',
		Vary: "Accept-Encoding",
	})
})

// Proxy Mintlify-managed paths, forwarding method/body and rewriting redirects
async function proxyToMintlify(
	c: Context<{ Bindings: Env }>,
	proxyRequest: MintlifyProxyRequest,
): Promise<Response> {
	const originUrl = new URL(c.req.url)
	const upstreamUrl = new URL(proxyRequest.upstreamPathname + originUrl.search, MINTLIFY_ORIGIN)
	const headers = buildMintlifyRequestHeaders(c, originUrl)

	const hasBody = c.req.method !== "GET" && c.req.method !== "HEAD"
	const abortController = new AbortController()
	const timeoutId = setTimeout(() => abortController.abort(), MINTLIFY_FETCH_TIMEOUT_MS)

	let upstreamResponse: Response
	try {
		upstreamResponse = await fetch(upstreamUrl.toString(), {
			method: c.req.method,
			headers,
			body: hasBody ? c.req.raw.body : undefined,
			redirect: "manual",
			signal: abortController.signal,
		})
	} catch (error) {
		if (isAbortError(error)) return createProxyFailureResponse(504, originUrl)
		return createProxyFailureResponse(502, originUrl)
	} finally {
		clearTimeout(timeoutId)
	}

	// Rewrite Location headers from Mintlify back to our domain
	const responseHeaders = new Headers(upstreamResponse.headers)
	const location =
		upstreamResponse.status >= 300 && upstreamResponse.status < 400
			? responseHeaders.get("Location")
			: null
	if (location !== null) {
		responseHeaders.set(
			"Location",
			rewriteMintlifyLocation(location, originUrl, upstreamUrl, proxyRequest),
		)
	}

	if (upstreamResponse.status >= 500) {
		const sanitizedHeaders = sanitizeFailureHeaders(responseHeaders, originUrl)
		sanitizedHeaders.delete("Content-Length")

		if (c.req.method === "HEAD") {
			return new Response(null, {
				status: upstreamResponse.status,
				headers: sanitizedHeaders,
			})
		}

		const upstreamBody = await upstreamResponse.text()
		return new Response(sanitizeMintlifyHostLeak(upstreamBody, originUrl), {
			status: upstreamResponse.status,
			headers: sanitizedHeaders,
		})
	}

	return new Response(upstreamResponse.body, {
		status: upstreamResponse.status,
		headers: responseHeaders,
	})
}

app.use("*", async (c, next) => {
	const proxyRequest = classifyMintlifyProxyRequest(new URL(c.req.url).pathname)
	if (!proxyRequest) return next()

	if (!ALLOWED_MINTLIFY_METHODS.has(c.req.method)) {
		return c.text("Method Not Allowed", 405, {
			Allow: ALLOWED_MINTLIFY_METHODS_HEADER,
		})
	}

	return proxyToMintlify(c, proxyRequest)
})

// Unified schema route
app.get("/schemas/:name{.+\\.json}", async (c) => {
	const nameWithExt = c.req.param("name") // "registry.json"

	const versionedRegistryMatch = nameWithExt.match(/^v(\d+)\/registry\.json$/)
	if (versionedRegistryMatch) {
		const versionToken = versionedRegistryMatch[1]
		const versionKey = `v${versionToken}`
		const schemaPayload =
			REGISTRY_SCHEMAS_BY_VERSION[versionKey as keyof typeof REGISTRY_SCHEMAS_BY_VERSION]

		if (!schemaPayload) {
			return c.json(
				{
					error: "Unsupported registry schema version",
					supportedSchemas: Object.keys(REGISTRY_SCHEMAS_BY_VERSION).map(
						(version) => `${version}/registry.json`,
					),
				},
				400,
			)
		}

		return respondWithSchema(c, schemaPayload, VERSIONED_SCHEMA_CACHE_CONTROL)
	}

	const name = nameWithExt.replace(/\.json$/, "") // "registry"

	// Validate against allowed schemas
	if (!VALID_SCHEMAS.includes(name as SchemaName)) {
		return c.json(
			{
				error: "Invalid schema",
				validSchemas: [
					...VALID_SCHEMAS.map((schemaName) => `${schemaName}.json`),
					...Object.keys(REGISTRY_SCHEMAS_BY_VERSION).map((version) => `${version}/registry.json`),
				],
			},
			400,
		)
	}

	const schemaPayload = SCHEMA_PAYLOADS[name as SchemaName]
	const cacheControl =
		name === "registry" ? LATEST_SCHEMA_CACHE_CONTROL : DEFAULT_SCHEMA_CACHE_CONTROL

	return respondWithSchema(c, schemaPayload, cacheControl)
})

export default app

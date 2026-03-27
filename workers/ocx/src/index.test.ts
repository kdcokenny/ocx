import { afterEach, describe, expect, it, mock } from "bun:test"
import app from "./index"

const TEST_ENV: Env = {
	GITHUB_REPO: "kdcokenny/ocx",
	GITHUB_BRANCH: "main",
}

const LATEST_SCHEMA_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=86400"
const VERSIONED_SCHEMA_CACHE_CONTROL = "public, max-age=31536000, immutable"
const MINTLIFY_ROOT_DOC_PATHS = [
	"/getting-started/introduction",
	"/profiles/overview",
	"/cli/commands",
	"/registries/create",
	"/reference/opencode",
	"/guides/index",
	"/integrations/workspace",
	"/enterprise/overview",
	"/security/policy",
	"/maintainers/migration-v1-4-0",
] as const
const README_REGRESSION_DOC_PATHS = [
	"/guides/index",
	"/profiles/overview",
	"/cli/commands",
	"/registries/create",
	"/profiles/security",
] as const

const originalFetch = globalThis.fetch

function getHeadersFromInit(init?: RequestInit): Headers {
	return new Headers((init?.headers ?? {}) as HeadersInit)
}

async function expectNoMintlifyLeakInResponse(response: Response): Promise<void> {
	const responseBody = await response.text()
	expect(responseBody.toLowerCase()).not.toContain("mintlify")

	for (const [headerName, headerValue] of response.headers.entries()) {
		expect(`${headerName}:${headerValue}`.toLowerCase()).not.toContain("mintlify")
	}
}

function installUnexpectedFetchMock() {
	const fetchMock = mock((_input: string | URL | Request) =>
		Promise.reject(new Error("Schema routes must not fetch GitHub")),
	)
	globalThis.fetch = fetchMock as unknown as typeof fetch
	return fetchMock
}

describe("schema routes", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch
	})

	it("serves legacy registry schema v1 at /schemas/v1/registry.json", async () => {
		const fetchMock = installUnexpectedFetchMock()

		const response = await app.request(
			"https://ocx.kdco.dev/schemas/v1/registry.json",
			{},
			TEST_ENV,
		)

		expect(response.status).toBe(200)
		expect(fetchMock).not.toHaveBeenCalled()
		expect(response.headers.get("cache-control")).toBe(VERSIONED_SCHEMA_CACHE_CONTROL)

		const payload = (await response.json()) as { $id?: string }
		expect(payload.$id).toBe("https://ocx.kdco.dev/registry.schema.json")
	})

	it("serves v2 registry schema at /schemas/v2/registry.json", async () => {
		const fetchMock = installUnexpectedFetchMock()

		const response = await app.request(
			"https://ocx.kdco.dev/schemas/v2/registry.json",
			{},
			TEST_ENV,
		)

		expect(response.status).toBe(200)
		expect(fetchMock).not.toHaveBeenCalled()
		expect(response.headers.get("cache-control")).toBe(VERSIONED_SCHEMA_CACHE_CONTROL)

		const payload = (await response.json()) as { $id?: string }
		expect(payload.$id).toBe("https://ocx.kdco.dev/schemas/v2/registry.json")
	})

	it("keeps unversioned /schemas/registry.json mapped to current default", async () => {
		const fetchMock = installUnexpectedFetchMock()

		const response = await app.request("https://ocx.kdco.dev/schemas/registry.json", {}, TEST_ENV)

		expect(response.status).toBe(200)
		expect(fetchMock).not.toHaveBeenCalled()
		expect(response.headers.get("cache-control")).toBe(LATEST_SCHEMA_CACHE_CONTROL)

		const payload = (await response.json()) as { $id?: string }
		expect(payload.$id).toBe("https://ocx.kdco.dev/schemas/v2/registry.json")
	})

	it("rejects unsupported registry schema versions with 400", async () => {
		const fetchMock = installUnexpectedFetchMock()

		const response = await app.request(
			"https://ocx.kdco.dev/schemas/v3/registry.json",
			{},
			TEST_ENV,
		)

		expect(response.status).toBe(400)
		expect(fetchMock).not.toHaveBeenCalled()
		const payload = (await response.json()) as { error?: string; supportedSchemas?: string[] }
		expect(payload.error).toBe("Unsupported registry schema version")
		expect(payload.supportedSchemas).toEqual(["v1/registry.json", "v2/registry.json"])
	})
})

describe("non-schema routes", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch
	})

	it("proxies canonicalized Mintlify paths and skips edge-case lookalikes", async () => {
		const fetchMock = mock((_input: string | URL | Request, _init?: RequestInit) =>
			Promise.resolve(new Response("ok", { status: 200 })),
		)
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const rootLevelPaths = [
			...new Set([...MINTLIFY_ROOT_DOC_PATHS, ...README_REGRESSION_DOC_PATHS]),
		]
		for (const rootLevelPath of rootLevelPaths) {
			const response = await app.request(`https://ocx.kdco.dev${rootLevelPath}`, {}, TEST_ENV)
			expect(response.status).toBe(200)
		}

		const docsRoot = await app.request("https://ocx.kdco.dev/docs", {}, TEST_ENV)
		const docsTrailingSlash = await app.request("https://ocx.kdco.dev/docs/", {}, TEST_ENV)
		const docsCollapsedSlashes = await app.request("https://ocx.kdco.dev/docs//a", {}, TEST_ENV)
		const docsBackslashPath = await app.request("https://ocx.kdco.dev/docs%5Ca", {}, TEST_ENV)
		const vercelSubpath = await app.request(
			"https://ocx.kdco.dev/.well-known/vercel/flags",
			{},
			TEST_ENV,
		)

		expect(docsRoot.status).toBe(200)
		expect(docsTrailingSlash.status).toBe(200)
		expect(docsCollapsedSlashes.status).toBe(200)
		expect(docsBackslashPath.status).toBe(200)
		expect(vercelSubpath.status).toBe(200)

		expect(fetchMock).toHaveBeenCalledTimes(rootLevelPaths.length + 5)
		expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
			...rootLevelPaths.map((rootLevelPath) => `https://kdco.mintlify.dev${rootLevelPath}`),
			"https://kdco.mintlify.dev/docs",
			"https://kdco.mintlify.dev/docs/",
			"https://kdco.mintlify.dev/docs/a",
			"https://kdco.mintlify.dev/docs/a",
			"https://kdco.mintlify.dev/.well-known/vercel/flags",
		])

		const nonProxyPaths: Array<{ path: string; expectedStatus: number }> = [
			{ path: "/doc", expectedStatus: 404 },
			{ path: "//guides/index", expectedStatus: 404 },
			{ path: "/guide/index", expectedStatus: 404 },
			{ path: "/guides-index", expectedStatus: 404 },
			{ path: "/guides%5Cindex", expectedStatus: 404 },
			{ path: "/profiles%5Coverview", expectedStatus: 404 },
			{ path: "/guides%2F..%2Findex", expectedStatus: 404 },
			{ path: "/profiles%2F%2E%2E%2Foverview", expectedStatus: 404 },
			{ path: "/docsify", expectedStatus: 404 },
			{ path: "/.well-known/anything-else", expectedStatus: 404 },
			{ path: "/docs%2F..", expectedStatus: 404 },
			{ path: "/docs/%2e%2e/", expectedStatus: 302 },
			{ path: "/.well-known/vercel/../x", expectedStatus: 404 },
			{ path: "/docs%5C..%5C", expectedStatus: 404 },
			{ path: "/.well-known/vercel%5c..%5cx", expectedStatus: 404 },
		]
		for (const nonProxyPath of nonProxyPaths) {
			const response = await app.request(`https://ocx.kdco.dev${nonProxyPath.path}`, {}, TEST_ENV)
			expect(response.status).toBe(nonProxyPath.expectedStatus)
		}

		expect(fetchMock).toHaveBeenCalledTimes(rootLevelPaths.length + 5)
	})

	it("returns 405 for disallowed methods on proxied paths", async () => {
		const fetchMock = mock((_input: string | URL | Request, _init?: RequestInit) =>
			Promise.resolve(new Response("ok", { status: 200 })),
		)
		globalThis.fetch = fetchMock as unknown as typeof fetch

		for (const method of ["PUT", "PATCH", "DELETE"]) {
			const response = await app.request("https://ocx.kdco.dev/docs/guarded", { method }, TEST_ENV)
			expect(response.status).toBe(405)
			expect(response.headers.get("allow")).toBe("GET, HEAD, OPTIONS, POST")
		}

		expect(fetchMock).not.toHaveBeenCalled()

		const nonProxyResponse = await app.request(
			"https://ocx.kdco.dev/install.sh",
			{ method: "PUT" },
			TEST_ENV,
		)
		expect(nonProxyResponse.status).toBe(404)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("preserves query passthrough with repeated and encoded params", async () => {
		const fetchMock = mock((_input: string | URL | Request, _init?: RequestInit) =>
			Promise.resolve(new Response("ok", { status: 200 })),
		)
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const response = await app.request(
			"https://ocx.kdco.dev/docs/search?tag=a&tag=b&q=hello%2Bworld&path=%2Fdocs%2Fintro&space=a+b",
			{},
			TEST_ENV,
		)

		expect(response.status).toBe(200)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"https://kdco.mintlify.dev/docs/search?tag=a&tag=b&q=hello%2Bworld&path=%2Fdocs%2Fintro&space=a+b",
		)
	})

	it("rebuilds trusted forwarding headers and strips spoofed/hop-by-hop headers", async () => {
		const upstreamResponse = new Response("<html>docs</html>", {
			status: 200,
			headers: {
				"Content-Type": "text/html; charset=utf-8",
			},
		})
		const fetchMock = mock((_input: string | URL | Request, _init?: RequestInit) =>
			Promise.resolve(upstreamResponse),
		)
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const response = await app.request(
			"https://ocx.kdco.dev/docs?from=test",
			{
				headers: {
					Accept: "text/html",
					"Accept-Language": "en-US",
					"If-None-Match": '"etag-value"',
					Range: "bytes=0-100",
					Authorization: "Bearer super-secret-token",
					Cookie: "session=super-secret-cookie",
					"CF-Access-Jwt-Assertion": "cf-access-jwt",
					"CF-Access-Client-Id": "cf-access-client-id",
					"CF-Access-Client-Secret": "cf-access-client-secret",
					"X-Api-Key": "api-key-secret",
					"X-Session-Id": "session-header-secret",
					"CF-Connecting-IP": "203.0.113.10",
					"User-Agent": "ocx-tests",
					Origin: "https://malicious.example",
					Forwarded: "for=198.51.100.44;proto=http;host=evil.example",
					"X-Forwarded-For": "198.51.100.1",
					"X-Forwarded-Host": "malicious.example",
					"X-Forwarded-Proto": "http",
					"X-Real-IP": "198.51.100.2",
					Connection: "keep-alive, x-remove-me",
					"Keep-Alive": "timeout=3",
					TE: "trailers",
					Trailer: "x-trailer",
					"Transfer-Encoding": "chunked",
					Upgrade: "websocket",
					"Proxy-Authenticate": "Basic realm=proxy",
					"Proxy-Authorization": "Basic abc",
					"x-remove-me": "sensitive",
				},
			},
			TEST_ENV,
		)

		expect(response.status).toBe(200)
		expect(await response.text()).toBe("<html>docs</html>")
		expect(response.headers.get("etag")).toBeNull()
		expect(fetchMock).toHaveBeenCalledTimes(1)

		const [upstreamUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(upstreamUrl).toBe("https://kdco.mintlify.dev/docs?from=test")
		expect(init.method).toBe("GET")
		expect(init.redirect).toBe("manual")

		const headers = getHeadersFromInit(init)
		expect(headers.get("host")).toBeNull()
		expect(headers.get("forwarded")).toBeNull()
		expect(headers.get("origin")).toBe("https://kdco.mintlify.dev")
		expect(headers.get("x-forwarded-for")).toBe("203.0.113.10")
		expect(headers.get("x-real-ip")).toBe("203.0.113.10")
		expect(headers.get("x-forwarded-proto")).toBe("https")
		expect(headers.get("x-forwarded-host")).toBe("ocx.kdco.dev")
		expect(headers.get("authorization")).toBeNull()
		expect(headers.get("cookie")).toBeNull()
		expect(headers.get("cf-access-jwt-assertion")).toBeNull()
		expect(headers.get("cf-access-client-id")).toBeNull()
		expect(headers.get("cf-access-client-secret")).toBeNull()
		expect(headers.get("x-api-key")).toBeNull()
		expect(headers.get("x-session-id")).toBeNull()
		expect(headers.get("user-agent")).toBe("ocx-tests")
		expect(headers.get("connection")).toBeNull()
		expect(headers.get("keep-alive")).toBeNull()
		expect(headers.get("te")).toBeNull()
		expect(headers.get("trailer")).toBeNull()
		expect(headers.get("transfer-encoding")).toBeNull()
		expect(headers.get("upgrade")).toBeNull()
		expect(headers.get("proxy-authenticate")).toBeNull()
		expect(headers.get("proxy-authorization")).toBeNull()
		expect(headers.get("x-remove-me")).toBeNull()
		expect(headers.get("accept")).toBe("text/html")
		expect(headers.get("accept-language")).toBe("en-US")
		expect(headers.get("if-none-match")).toBe('"etag-value"')
		expect(headers.get("range")).toBe("bytes=0-100")
	})

	it("omits X-Forwarded-For and X-Real-IP when trusted client IP is unavailable", async () => {
		const fetchMock = mock((_input: string | URL | Request, _init?: RequestInit) =>
			Promise.resolve(new Response("ok", { status: 200 })),
		)
		globalThis.fetch = fetchMock as unknown as typeof fetch

		await app.request(
			"http://ocx.kdco.dev/docs",
			{
				headers: {
					"X-Forwarded-For": "198.51.100.10",
					"X-Real-IP": "198.51.100.11",
				},
			},
			TEST_ENV,
		)

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		const headers = getHeadersFromInit(init)
		expect(headers.get("x-forwarded-proto")).toBe("http")
		expect(headers.get("origin")).toBe("https://kdco.mintlify.dev")
		expect(headers.get("x-forwarded-for")).toBeNull()
		expect(headers.get("x-real-ip")).toBeNull()
	})

	it("preserves methods for GET, HEAD, and OPTIONS on docs proxy", async () => {
		const fetchMock = mock((_input: string | URL | Request, _init?: RequestInit) =>
			Promise.resolve(new Response("ok", { status: 200 })),
		)
		globalThis.fetch = fetchMock as unknown as typeof fetch

		await app.request("https://ocx.kdco.dev/docs/methods?tab=get", { method: "GET" }, TEST_ENV)
		await app.request("https://ocx.kdco.dev/docs/methods?tab=head", { method: "HEAD" }, TEST_ENV)
		await app.request(
			"https://ocx.kdco.dev/docs/methods?tab=options",
			{ method: "OPTIONS" },
			TEST_ENV,
		)

		expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
			"https://kdco.mintlify.dev/docs/methods?tab=get",
			"https://kdco.mintlify.dev/docs/methods?tab=head",
			"https://kdco.mintlify.dev/docs/methods?tab=options",
		])
		expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].method).toBe("GET")
		expect((fetchMock.mock.calls[1] as [string, RequestInit])[1].method).toBe("HEAD")
		expect((fetchMock.mock.calls[2] as [string, RequestInit])[1].method).toBe("OPTIONS")

		const headResponse = await app.request(
			"https://ocx.kdco.dev/docs/methods?tab=head",
			{ method: "HEAD" },
			TEST_ENV,
		)
		expect(await headResponse.text()).toBe("")
	})

	it("preserves POST request body and Content-Type", async () => {
		const seenBodies: string[] = []
		const seenContentTypes: Array<string | null> = []
		const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const proxiedRequest = new Request(input, init)
			seenBodies.push(await proxiedRequest.text())
			seenContentTypes.push(proxiedRequest.headers.get("content-type"))
			return new Response("ok", { status: 200 })
		})
		globalThis.fetch = fetchMock as unknown as typeof fetch

		await app.request(
			"https://ocx.kdco.dev/docs/forms?draft=true",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: '{"name":"ocx"}',
			},
			TEST_ENV,
		)

		const [upstreamUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(upstreamUrl).toBe("https://kdco.mintlify.dev/docs/forms?draft=true")
		expect(init.method).toBe("POST")
		expect(seenBodies).toEqual(['{"name":"ocx"}'])
		expect(seenContentTypes).toEqual(["application/json"])
	})

	it("rewrites absolute upstream redirects with normalized host/port matching", async () => {
		const fetchMock = mock((_input: string | URL | Request, _init?: RequestInit) =>
			Promise.resolve(
				new Response(null, {
					status: 302,
					headers: {
						Location: "https://KDCO.MINTLIFY.DEV.:443/docs/intro?section=1#start",
					},
				}),
			),
		)
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const response = await app.request("https://ocx.kdco.dev/docs", {}, TEST_ENV)
		expect(response.headers.get("location")).toBe("https://ocx.kdco.dev/docs/intro?section=1#start")
	})

	it("rewrites root-relative, path-relative, and protocol-relative redirects", async () => {
		const locations = [
			"/guides/start?foo=bar#root",
			"next?foo=bar#path",
			"//kdco.mintlify.dev/reference?foo=bar#protocol",
		]
		let callIndex = 0
		const fetchMock = mock((_input: string | URL | Request, _init?: RequestInit) => {
			const location = locations[callIndex]
			callIndex += 1
			return Promise.resolve(
				new Response(null, {
					status: 302,
					headers: {
						Location: location,
					},
				}),
			)
		})
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const rootRelativeResponse = await app.request("https://ocx.kdco.dev/docs", {}, TEST_ENV)
		expect(rootRelativeResponse.headers.get("location")).toBe(
			"https://ocx.kdco.dev/docs/guides/start?foo=bar#root",
		)

		const pathRelativeResponse = await app.request(
			"https://ocx.kdco.dev/docs/guide/current",
			{},
			TEST_ENV,
		)
		expect(pathRelativeResponse.headers.get("location")).toBe(
			"https://ocx.kdco.dev/docs/guide/next?foo=bar#path",
		)

		const protocolRelativeResponse = await app.request("https://ocx.kdco.dev/docs", {}, TEST_ENV)
		expect(protocolRelativeResponse.headers.get("location")).toBe(
			"https://ocx.kdco.dev/docs/reference?foo=bar#protocol",
		)
	})

	it("rewrites redirects from root-level docs requests back to root-level URLs", async () => {
		const locations = [
			"/guides/start?foo=bar#root",
			"next?foo=bar#path",
			"//kdco.mintlify.dev/reference?foo=bar#protocol",
			"https://kdco.mintlify.dev/docs/cli/commands?foo=bar#legacy-prefix",
		]
		let callIndex = 0
		const fetchMock = mock((_input: string | URL | Request, _init?: RequestInit) => {
			const location = locations[callIndex]
			callIndex += 1
			return Promise.resolve(
				new Response(null, {
					status: 302,
					headers: {
						Location: location,
					},
				}),
			)
		})
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const rootRelativeResponse = await app.request(
			"https://ocx.kdco.dev/guides/index",
			{},
			TEST_ENV,
		)
		expect(rootRelativeResponse.headers.get("location")).toBe(
			"https://ocx.kdco.dev/guides/start?foo=bar#root",
		)

		const pathRelativeResponse = await app.request(
			"https://ocx.kdco.dev/guides/current",
			{},
			TEST_ENV,
		)
		expect(pathRelativeResponse.headers.get("location")).toBe(
			"https://ocx.kdco.dev/guides/next?foo=bar#path",
		)

		const protocolRelativeResponse = await app.request(
			"https://ocx.kdco.dev/reference/opencode",
			{},
			TEST_ENV,
		)
		expect(protocolRelativeResponse.headers.get("location")).toBe(
			"https://ocx.kdco.dev/reference?foo=bar#protocol",
		)

		const legacyPrefixResponse = await app.request(
			"https://ocx.kdco.dev/cli/commands",
			{},
			TEST_ENV,
		)
		expect(legacyPrefixResponse.headers.get("location")).toBe(
			"https://ocx.kdco.dev/cli/commands?foo=bar#legacy-prefix",
		)
	})

	it("keeps root-level docs redirects anchored at /docs", async () => {
		const locations = ["/docs", "/docs/"]
		let callIndex = 0
		const fetchMock = mock((_input: string | URL | Request, _init?: RequestInit) => {
			const location = locations[callIndex]
			callIndex += 1
			return Promise.resolve(
				new Response(null, {
					status: 302,
					headers: {
						Location: location,
					},
				}),
			)
		})
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const docsResponse = await app.request("https://ocx.kdco.dev/guides/index", {}, TEST_ENV)
		const docsSlashResponse = await app.request(
			"https://ocx.kdco.dev/reference/opencode",
			{},
			TEST_ENV,
		)

		expect(docsResponse.headers.get("location")).toBe("https://ocx.kdco.dev/docs")
		expect(docsSlashResponse.headers.get("location")).toBe("https://ocx.kdco.dev/docs")
	})

	it("prevents double /docs prefixing and converges /docs and /docs/ redirects", async () => {
		let callCount = 0
		const fetchMock = mock((_input: string | URL | Request, _init?: RequestInit) => {
			callCount += 1
			if (callCount === 1) {
				return Promise.resolve(
					new Response(null, {
						status: 302,
						headers: {
							Location: "https://kdco.mintlify.dev/docs/docs/guide?x=1#sec",
						},
					}),
				)
			}

			return Promise.resolve(
				new Response(null, {
					status: 302,
					headers: {
						Location: "/docs/",
					},
				}),
			)
		})
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const doublePrefixResponse = await app.request("https://ocx.kdco.dev/docs", {}, TEST_ENV)
		expect(doublePrefixResponse.headers.get("location")).toBe(
			"https://ocx.kdco.dev/docs/guide?x=1#sec",
		)

		const docsResponse = await app.request("https://ocx.kdco.dev/docs", {}, TEST_ENV)
		const docsSlashResponse = await app.request("https://ocx.kdco.dev/docs/", {}, TEST_ENV)
		expect(docsResponse.headers.get("location")).toBe("https://ocx.kdco.dev/docs")
		expect(docsSlashResponse.headers.get("location")).toBe("https://ocx.kdco.dev/docs")
	})

	it("keeps /.well-known/vercel redirect targets rooted even from /docs", async () => {
		const fetchMock = mock((_input: string | URL | Request, _init?: RequestInit) =>
			Promise.resolve(
				new Response(null, {
					status: 302,
					headers: {
						Location: "/.well-known/vercel/status?state=ok#ready",
					},
				}),
			),
		)
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const response = await app.request("https://ocx.kdco.dev/docs", {}, TEST_ENV)
		expect(response.headers.get("location")).toBe(
			"https://ocx.kdco.dev/.well-known/vercel/status?state=ok#ready",
		)
	})

	it("leaves non-http schemes unchanged in redirect locations", async () => {
		const mailtoLocation = "mailto:support@kdco.mintlify.dev"
		const fetchMock = mock((_input: string | URL | Request, _init?: RequestInit) =>
			Promise.resolve(
				new Response(null, {
					status: 302,
					headers: {
						Location: mailtoLocation,
					},
				}),
			),
		)
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const response = await app.request("https://ocx.kdco.dev/docs", {}, TEST_ENV)
		expect(response.headers.get("location")).toBe(mailtoLocation)
	})

	it("keeps external redirects unchanged", async () => {
		const externalLocation = "https://example.com/auth?next=%2Fdocs#continue"
		const fetchMock = mock((_input: string | URL | Request, _init?: RequestInit) =>
			Promise.resolve(
				new Response(null, {
					status: 302,
					headers: {
						Location: externalLocation,
					},
				}),
			),
		)
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const response = await app.request("https://ocx.kdco.dev/docs", {}, TEST_ENV)
		expect(response.headers.get("location")).toBe(externalLocation)
	})

	it("keeps /.well-known/vercel redirects rooted", async () => {
		const fetchMock = mock((_input: string | URL | Request, _init?: RequestInit) =>
			Promise.resolve(
				new Response(null, {
					status: 302,
					headers: {
						Location: "/deployment-ready?state=ok#done",
					},
				}),
			),
		)
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const response = await app.request(
			"https://ocx.kdco.dev/.well-known/vercel/flags",
			{},
			TEST_ENV,
		)
		expect(response.headers.get("location")).toBe(
			"https://ocx.kdco.dev/deployment-ready?state=ok#done",
		)
	})

	it("maps AbortError failures to 504 without mintlify leakage", async () => {
		const fetchMock = mock((_input: string | URL | Request, _init?: RequestInit) =>
			Promise.reject(new DOMException("aborted", "AbortError")),
		)
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const response = await app.request("https://ocx.kdco.dev/docs", {}, TEST_ENV)
		expect(response.status).toBe(504)
		await expectNoMintlifyLeakInResponse(response)
	})

	it("maps network failures to 502 without mintlify leakage", async () => {
		const fetchMock = mock((_input: string | URL | Request, _init?: RequestInit) =>
			Promise.reject(new TypeError("getaddrinfo ENOTFOUND kdco.mintlify.dev")),
		)
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const response = await app.request("https://ocx.kdco.dev/docs", {}, TEST_ENV)
		expect(response.status).toBe(502)
		await expectNoMintlifyLeakInResponse(response)
	})

	it("sanitizes upstream 5xx responses to avoid mintlify host leakage", async () => {
		const fetchMock = mock((_input: string | URL | Request, _init?: RequestInit) =>
			Promise.resolve(
				new Response("upstream error at https://kdco.mintlify.dev/oops and kdco.mintlify.dev", {
					status: 502,
					headers: {
						"X-Upstream": "kdco.mintlify.dev",
						Location: "https://kdco.mintlify.dev/error",
					},
				}),
			),
		)
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const response = await app.request("https://ocx.kdco.dev/docs", {}, TEST_ENV)
		expect(response.status).toBe(502)
		await expectNoMintlifyLeakInResponse(response)
	})

	it("keeps root redirect behavior", async () => {
		const response = await app.request("https://ocx.kdco.dev/", {}, TEST_ENV)
		expect(response.status).toBe(302)
		expect(response.headers.get("location")).toBe("https://github.com/kdcokenny/ocx")
	})

	it("keeps /install.sh behavior and response headers", async () => {
		const installScript = "#!/usr/bin/env bash\necho install\n"
		const fetchMock = mock((input: string | URL | Request, _init?: RequestInit) => {
			expect(input).toBe(
				"https://raw.githubusercontent.com/kdcokenny/ocx/main/packages/cli/scripts/install.sh",
			)
			return Promise.resolve(new Response(installScript, { status: 200 }))
		})
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const response = await app.request("https://ocx.kdco.dev/install.sh", {}, TEST_ENV)

		expect(response.status).toBe(200)
		expect(await response.text()).toBe(installScript)
		expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8")
		expect(response.headers.get("cache-control")).toBe("public, max-age=300, must-revalidate")
		expect(response.headers.get("content-disposition")).toBe('inline; filename="install.sh"')
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})
})

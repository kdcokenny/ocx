import { afterEach, describe, expect, it, mock } from "bun:test"
import {
	_clearFetcherCacheForTests,
	classifyRegistryIndexIssue,
	fetchComponentVersion,
	fetchFileContent,
	fetchRegistryIndex,
} from "../../src/registry/fetcher"
import {
	NetworkError,
	NotFoundError,
	RegistryCompatibilityError,
	ValidationError,
} from "../../src/utils/errors"
import { startLegacyFixtureRegistry } from "../legacy-fixture-registry"

const REGISTRY_SCHEMA_V2_URL = "https://ocx.kdco.dev/schemas/v2/registry.json"
const REGISTRY_SCHEMA_UNVERSIONED_URL = "https://ocx.kdco.dev/schemas/registry.json"

describe("fetcher", () => {
	const originalFetch = globalThis.fetch

	afterEach(() => {
		globalThis.fetch = originalFetch
		_clearFetcherCacheForTests()
	})

	describe("network error handling", () => {
		it("throws NetworkError on DNS failure", async () => {
			globalThis.fetch = mock(() =>
				Promise.reject(new Error("getaddrinfo ENOTFOUND registry.example.com")),
			)

			await expect(fetchRegistryIndex("https://registry.example.com")).rejects.toThrow(NetworkError)
			await expect(fetchRegistryIndex("https://registry.example2.com")).rejects.toThrow(
				/network request failed/i,
			)
		})

		it("throws NetworkError on connection refused", async () => {
			globalThis.fetch = mock(() =>
				Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:3000")),
			)

			await expect(fetchRegistryIndex("https://localhost:3000")).rejects.toThrow(NetworkError)
		})

		it("throws NetworkError on timeout", async () => {
			globalThis.fetch = mock(() => Promise.reject(new Error("The operation timed out")))

			await expect(fetchRegistryIndex("https://registry.example.com")).rejects.toThrow(NetworkError)
		})

		it("throws NetworkError on HTTP 500", async () => {
			globalThis.fetch = mock(() =>
				Promise.resolve(
					new Response("Internal Server Error", {
						status: 500,
						statusText: "Internal Server Error",
					}),
				),
			)

			await expect(fetchRegistryIndex("https://registry.example.com")).rejects.toThrow(NetworkError)
			await expect(fetchRegistryIndex("https://registry.example2.com")).rejects.toThrow(/500/)
		})

		it("throws NetworkError on HTTP 503", async () => {
			globalThis.fetch = mock(() =>
				Promise.resolve(
					new Response("Service Unavailable", {
						status: 503,
						statusText: "Service Unavailable",
					}),
				),
			)

			await expect(fetchRegistryIndex("https://registry.example.com")).rejects.toThrow(NetworkError)
		})

		it("throws NotFoundError on HTTP 404", async () => {
			globalThis.fetch = mock(() =>
				Promise.resolve(new Response("Not Found", { status: 404, statusText: "Not Found" })),
			)

			await expect(fetchRegistryIndex("https://registry.example.com")).rejects.toThrow(
				NotFoundError,
			)
		})

		it("throws NetworkError on malformed JSON response", async () => {
			globalThis.fetch = mock(() =>
				Promise.resolve(
					new Response("not valid json {{{", {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				),
			)

			await expect(fetchRegistryIndex("https://registry.example.com")).rejects.toThrow(NetworkError)
			await expect(fetchRegistryIndex("https://registry.example2.com")).rejects.toThrow(
				/invalid json/i,
			)
		})

		it("includes URL in network error message", async () => {
			globalThis.fetch = mock(() => Promise.reject(new Error("connection failed")))

			try {
				await fetchRegistryIndex("https://registry.example.com")
				expect.unreachable("Should have thrown")
			} catch (error) {
				expect(error).toBeInstanceOf(NetworkError)
				expect((error as NetworkError).message).toContain("registry.example.com")
			}
		})
	})

	describe("fetchFileContent network errors", () => {
		it("retains structured details for packument transport failures", async () => {
			globalThis.fetch = mock(() => Promise.reject(new Error("socket hang up")))

			try {
				await fetchComponentVersion("https://registry.example.com", "button")
				expect.unreachable("Should have thrown")
			} catch (error) {
				expect(error).toBeInstanceOf(NetworkError)
				const networkError = error as NetworkError & { phase?: string }
				expect(networkError.url).toBe("https://registry.example.com/components/button.json")
				expect(networkError.url).not.toContain("#v=")
				expect(networkError.phase).toBe("packument-fetch")
				expect(networkError.status).toBeUndefined()
			}
		})

		it("retains structured details for packument HTTP failures", async () => {
			globalThis.fetch = mock(() =>
				Promise.resolve(
					new Response("Service Unavailable", {
						status: 503,
						statusText: "Service Unavailable",
					}),
				),
			)

			try {
				await fetchComponentVersion("https://registry.example.com", "button")
				expect.unreachable("Should have thrown")
			} catch (error) {
				expect(error).toBeInstanceOf(NetworkError)
				const networkError = error as NetworkError & { phase?: string }
				expect(networkError.url).toBe("https://registry.example.com/components/button.json")
				expect(networkError.url).not.toContain("#v=")
				expect(networkError.phase).toBe("packument-fetch")
				expect(networkError.status).toBe(503)
			}
		})

		it("throws NetworkError on DNS failure", async () => {
			globalThis.fetch = mock(() => Promise.reject(new Error("getaddrinfo ENOTFOUND")))

			await expect(
				fetchFileContent("https://registry.example.com", "button", "index.ts"),
			).rejects.toThrow(NetworkError)
		})

		it("throws NetworkError on connection timeout", async () => {
			globalThis.fetch = mock(() => Promise.reject(new Error("The operation timed out")))

			await expect(
				fetchFileContent("https://registry.example.com", "button", "index.ts"),
			).rejects.toThrow(NetworkError)
		})

		it("includes URL in fetchFileContent network error", async () => {
			globalThis.fetch = mock(() => Promise.reject(new Error("connection refused")))

			try {
				await fetchFileContent("https://registry.example.com", "button", "index.ts")
				expect.unreachable("Should have thrown")
			} catch (error) {
				expect(error).toBeInstanceOf(NetworkError)
				expect((error as NetworkError).message).toContain("registry.example.com")
				expect((error as NetworkError).message).toContain("button")
			}
		})

		it("retains structured details for file-content transport failures", async () => {
			globalThis.fetch = mock(() => Promise.reject(new Error("socket hang up")))

			try {
				await fetchFileContent("https://registry.example.com", "button", "index.ts")
				expect.unreachable("Should have thrown")
			} catch (error) {
				expect(error).toBeInstanceOf(NetworkError)
				const networkError = error as NetworkError & { phase?: string; qualifiedName?: string }
				expect(networkError.url).toBe("https://registry.example.com/components/button/index.ts")
				expect(networkError.phase).toBe("file-content-fetch")
				expect(networkError.qualifiedName).toBe("button")
				expect(networkError.status).toBeUndefined()
			}
		})

		it("retains structured details for file-content HTTP failures", async () => {
			globalThis.fetch = mock(() =>
				Promise.resolve(
					new Response("Bad Gateway", {
						status: 502,
						statusText: "Bad Gateway",
					}),
				),
			)

			try {
				await fetchFileContent("https://registry.example.com", "button", "index.ts")
				expect.unreachable("Should have thrown")
			} catch (error) {
				expect(error).toBeInstanceOf(NetworkError)
				const networkError = error as NetworkError & { phase?: string; qualifiedName?: string }
				expect(networkError.url).toBe("https://registry.example.com/components/button/index.ts")
				expect(networkError.phase).toBe("file-content-fetch")
				expect(networkError.qualifiedName).toBe("button")
				expect(networkError.status).toBe(502)
			}
		})
	})
})

// =============================================================================
// Registry Index Classification Tests
// =============================================================================

describe("classifyRegistryIndexIssue", () => {
	it("returns 'legacy-schema-v1' for top-level array with no $schema", () => {
		const result = classifyRegistryIndexIssue([
			{ name: "button", type: "plugin" },
			{ name: "card", type: "plugin" },
		])

		expect(result).not.toBeNull()
		expect(result?.issue).toBe("legacy-schema-v1")
		expect(result?.remediation).toContain("v2")
	})

	it("returns 'legacy-schema-v1' when $schema is missing", () => {
		const result = classifyRegistryIndexIssue({
			author: "Test Author",
			components: [{ name: "button", type: "plugin", description: "A button" }],
		})

		expect(result).not.toBeNull()
		expect(result?.issue).toBe("legacy-schema-v1")
	})

	it("returns 'legacy-schema-v1' for canonical unversioned schema URL", () => {
		const result = classifyRegistryIndexIssue({
			$schema: REGISTRY_SCHEMA_UNVERSIONED_URL,
		})

		expect(result).not.toBeNull()
		expect(result?.issue).toBe("legacy-schema-v1")
	})

	it("returns 'invalid-schema-url' for empty schema string", () => {
		const result = classifyRegistryIndexIssue({
			$schema: "",
		})

		expect(result).not.toBeNull()
		expect(result?.issue).toBe("invalid-schema-url")
	})

	it("returns 'invalid-schema-url' for foreign schema URL", () => {
		const result = classifyRegistryIndexIssue({
			$schema: "https://example.com/registry.json",
		})

		expect(result).not.toBeNull()
		expect(result?.issue).toBe("invalid-schema-url")
	})

	it("returns 'invalid-schema-url' for credentialed canonical URL", () => {
		const result = classifyRegistryIndexIssue({
			$schema: "https://user:pass@ocx.kdco.dev/schemas/v2/registry.json",
		})

		expect(result).not.toBeNull()
		expect(result?.issue).toBe("invalid-schema-url")
	})

	it("returns 'invalid-schema-url' for explicit-port canonical URL", () => {
		const result = classifyRegistryIndexIssue({
			$schema: "https://ocx.kdco.dev:8443/schemas/v2/registry.json",
		})

		expect(result).not.toBeNull()
		expect(result?.issue).toBe("invalid-schema-url")
	})

	it("returns 'invalid-schema-url' for explicit default HTTPS port (:443)", () => {
		const result = classifyRegistryIndexIssue({
			$schema: "https://ocx.kdco.dev:443/schemas/v2/registry.json",
		})

		expect(result).not.toBeNull()
		expect(result?.issue).toBe("invalid-schema-url")
	})

	it("returns 'unsupported-schema-version' for unsupported major", () => {
		const result = classifyRegistryIndexIssue({
			$schema: "https://ocx.kdco.dev/schemas/v3/registry.json",
		})

		expect(result).not.toBeNull()
		expect(result?.issue).toBe("unsupported-schema-version")
	})

	it("returns 'invalid-schema-url' for zero-padded canonical major", () => {
		const result = classifyRegistryIndexIssue({
			$schema: "https://ocx.kdco.dev/schemas/v02/registry.json",
		})

		expect(result).not.toBeNull()
		expect(result?.issue).toBe("invalid-schema-url")
	})

	it("returns null for supported v2 schema URL", () => {
		const result = classifyRegistryIndexIssue({
			$schema: REGISTRY_SCHEMA_V2_URL,
			author: "Test Author",
			components: [{ name: "button", type: "plugin", description: "A button" }],
		})

		expect(result).toBeNull()
	})

	it("returns null for null/undefined/primitive data", () => {
		expect(classifyRegistryIndexIssue(null)).toBeNull()
		expect(classifyRegistryIndexIssue(undefined)).toBeNull()
		expect(classifyRegistryIndexIssue("string")).toBeNull()
		expect(classifyRegistryIndexIssue(42)).toBeNull()
	})

	it("returns 'legacy-schema-v1' for empty array", () => {
		const result = classifyRegistryIndexIssue([])
		expect(result).not.toBeNull()
		expect(result?.issue).toBe("legacy-schema-v1")
	})
})

describe("fetchRegistryIndex compatibility detection", () => {
	const originalFetch = globalThis.fetch

	afterEach(() => {
		globalThis.fetch = originalFetch
		_clearFetcherCacheForTests()
	})

	const prefixedTypeCases = [
		{ prefixed: "ocx:agent", canonical: "agent" },
		{ prefixed: "ocx:skill", canonical: "skill" },
		{ prefixed: "ocx:plugin", canonical: "plugin" },
		{ prefixed: "ocx:command", canonical: "command" },
		{ prefixed: "ocx:tool", canonical: "tool" },
		{ prefixed: "ocx:profile", canonical: "profile" },
		{ prefixed: "ocx:bundle", canonical: "bundle" },
	] as const

	for (const typeCase of prefixedTypeCases) {
		it(`rejects v2 index entries that use legacy prefixed type ${typeCase.prefixed}`, async () => {
			globalThis.fetch = mock(() =>
				Promise.resolve(
					new Response(
						JSON.stringify({
							$schema: REGISTRY_SCHEMA_V2_URL,
							author: "Test",
							components: [
								{
									name: "legacy-prefixed",
									type: typeCase.prefixed,
									description: "Legacy-prefixed type in v2",
								},
							],
						}),
						{
							status: 200,
							headers: { "content-type": "application/json" },
						},
					),
				),
			)

			await expect(fetchRegistryIndex("https://v2-prefixed.example.com")).rejects.toThrow(
				typeCase.prefixed,
			)
			await expect(fetchRegistryIndex("https://v2-prefixed.example.com")).rejects.toThrow(
				`Use "${typeCase.canonical}"`,
			)
		})
	}

	const prototypeLikeTypeKeys = ["__proto__", "toString", "constructor"] as const

	for (const prototypeKey of prototypeLikeTypeKeys) {
		it(`does not treat prototype key ${prototypeKey} as legacy v2 type alias`, async () => {
			globalThis.fetch = mock(() =>
				Promise.resolve(
					new Response(
						JSON.stringify({
							$schema: REGISTRY_SCHEMA_V2_URL,
							author: "Test",
							components: [
								{
									name: "prototype-key",
									type: prototypeKey,
									description: "Prototype key should fail schema, not alias remediation",
								},
							],
						}),
						{
							status: 200,
							headers: { "content-type": "application/json" },
						},
					),
				),
			)

			try {
				await fetchRegistryIndex(`https://prototype-${prototypeKey}.example.com`)
				expect.unreachable("Should have thrown")
			} catch (error) {
				expect(error).toBeInstanceOf(RegistryCompatibilityError)
				const compatError = error as RegistryCompatibilityError
				expect(compatError.issue).toBe("invalid-format")
				expect(compatError.message).not.toContain("uses legacy component type")
				expect(compatError.message).not.toContain("Replace legacy type")
			}
		})
	}

	it("accepts v2 index entries that use canonical profile/bundle types", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						$schema: REGISTRY_SCHEMA_V2_URL,
						author: "Test",
						components: [
							{ name: "workspace", type: "bundle", description: "Bundle" },
							{ name: "starter", type: "profile", description: "Profile" },
						],
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
			),
		)

		const index = await fetchRegistryIndex("https://v2-canonical.example.com")
		expect(index.components.map((component) => component.type)).toEqual(["bundle", "profile"])
	})

	it("adapts legacy v1 object index when schema URL is missing", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						author: "Test",
						components: [{ name: "button", type: "ocx:plugin", description: "Button" }],
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
			),
		)

		const index = await fetchRegistryIndex("https://legacy.example.com")
		expect(index.components).toHaveLength(1)
		expect(index.components[0]?.type).toBe("plugin")
	})

	it("adapts legacy v1 object index for canonical unversioned schema URL", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						$schema: REGISTRY_SCHEMA_UNVERSIONED_URL,
						author: "Test",
						components: [{ name: "workspace", type: "ocx:bundle", description: "Bundle" }],
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
			),
		)

		const index = await fetchRegistryIndex("https://incomplete.example.com")
		expect(index.components[0]?.type).toBe("bundle")
	})

	it("loads legacy fixture index for kdco/workspace", async () => {
		const fixtureRegistry = startLegacyFixtureRegistry("kdco")

		try {
			const index = await fetchRegistryIndex(fixtureRegistry.url)
			expect(index.components.map((component) => component.name)).toContain("workspace")
			expect(index.components[0]?.type).toBe("bundle")
		} finally {
			fixtureRegistry.stop()
		}
	})

	it("throws RegistryCompatibilityError for invalid schema URL", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						$schema: "https://foreign.example.com/registry.json",
						author: "Test",
						components: [],
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
			),
		)

		try {
			await fetchRegistryIndex("https://random.example.com")
			expect.unreachable("Should have thrown")
		} catch (error) {
			expect(error).toBeInstanceOf(RegistryCompatibilityError)
			const compatError = error as RegistryCompatibilityError
			expect(compatError.issue).toBe("invalid-schema-url")
		}
	})

	it("throws RegistryCompatibilityError for unsupported schema major", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						$schema: "https://ocx.kdco.dev/schemas/v3/registry.json",
						author: "Test",
						components: [],
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
			),
		)

		try {
			await fetchRegistryIndex("https://future.example.com")
			expect.unreachable("Should have thrown")
		} catch (error) {
			expect(error).toBeInstanceOf(RegistryCompatibilityError)
			const compatError = error as RegistryCompatibilityError
			expect(compatError.issue).toBe("unsupported-schema-version")
		}
	})

	it("throws RegistryCompatibilityError for zero-padded schema major", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						$schema: "https://ocx.kdco.dev/schemas/v02/registry.json",
						author: "Test",
						components: [],
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
			),
		)

		try {
			await fetchRegistryIndex("https://zero-padded.example.com")
			expect.unreachable("Should have thrown")
		} catch (error) {
			expect(error).toBeInstanceOf(RegistryCompatibilityError)
			const compatError = error as RegistryCompatibilityError
			expect(compatError.issue).toBe("invalid-schema-url")
		}
	})

	it("uses fallback template with schema error for schema-valid-shape but invalid data", async () => {
		// Has author and components (passes classifier) but components have invalid format
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						$schema: REGISTRY_SCHEMA_V2_URL,
						author: "Test",
						components: [{ invalid: true }],
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
			),
		)

		try {
			await fetchRegistryIndex("https://schema-fail.example.com")
			expect.unreachable("Should have thrown")
		} catch (error) {
			expect(error).toBeInstanceOf(RegistryCompatibilityError)
			const compatError = error as RegistryCompatibilityError
			expect(compatError.issue).toBe("invalid-format")
			expect(compatError.message).toContain("unrecognized index format")
			expect(compatError.message).toContain("Schema error:")
		}
	})

	it("fails loud for legacy array payloads that cannot be adapted", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify([{ name: "button", type: "plugin" }]), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			),
		)

		try {
			await fetchRegistryIndex("https://legacy-array.example.com")
			expect.unreachable("Should have thrown")
		} catch (error) {
			expect(error).toBeInstanceOf(RegistryCompatibilityError)
			expect((error as RegistryCompatibilityError).issue).toBe("legacy-schema-v1")
		}
	})

	it("does not cache failed compatibility errors (subsequent call re-fetches)", async () => {
		let callCount = 0

		// Return unsupported schema each time to force compatibility failure.
		globalThis.fetch = mock(() => {
			callCount++
			return Promise.resolve(
				new Response(
					JSON.stringify({
						$schema: "https://ocx.kdco.dev/schemas/v3/registry.json",
						author: "Test",
						components: [],
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
			)
		})

		// First call should fail
		try {
			await fetchRegistryIndex("https://cache-test.example.com")
		} catch (error) {
			expect(error).toBeInstanceOf(RegistryCompatibilityError)
			expect((error as RegistryCompatibilityError).issue).toBe("unsupported-schema-version")
		}

		expect(callCount).toBe(1)

		// Second call should re-fetch (not return cached error)
		try {
			await fetchRegistryIndex("https://cache-test.example.com")
		} catch (error) {
			expect(error).toBeInstanceOf(RegistryCompatibilityError)
			expect((error as RegistryCompatibilityError).issue).toBe("unsupported-schema-version")
		}

		expect(callCount).toBe(2)
	})
})

describe("fetchComponentVersion legacy manifest adaptation", () => {
	const originalFetch = globalThis.fetch
	const prefixedTypeCases = [
		{ prefixed: "ocx:agent", canonical: "agent" },
		{ prefixed: "ocx:skill", canonical: "skill" },
		{ prefixed: "ocx:plugin", canonical: "plugin" },
		{ prefixed: "ocx:command", canonical: "command" },
		{ prefixed: "ocx:tool", canonical: "tool" },
		{ prefixed: "ocx:bundle", canonical: "bundle" },
		{ prefixed: "ocx:profile", canonical: "profile" },
	] as const
	const legacyTargetPrefixCases = [
		".opencode/plugins/legacy-target.ts",
		".opencode\\plugins\\legacy-target.ts",
	] as const
	const legacyTargetPrefixShorthandCases = [
		".opencode/plugins/x.ts",
		".opencode\\plugins\\x.ts",
	] as const

	afterEach(() => {
		globalThis.fetch = originalFetch
		_clearFetcherCacheForTests()
	})

	it("adapts .opencode/plugin target and ocx:* type to v2 manifest", async () => {
		globalThis.fetch = mock((input) => {
			const requestUrl = new URL(String(input))

			if (requestUrl.pathname === "/index.json") {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							author: "Legacy",
							components: [
								{ name: "legacy-plugin", type: "ocx:plugin", description: "Legacy plugin" },
							],
						}),
						{
							status: 200,
							headers: { "content-type": "application/json" },
						},
					),
				)
			}

			return Promise.resolve(
				new Response(
					JSON.stringify({
						name: "legacy-plugin",
						"dist-tags": { latest: "1.4.6" },
						versions: {
							"1.4.6": {
								name: "legacy-plugin",
								type: "ocx:plugin",
								description: "Legacy plugin",
								files: [{ path: "plugin.ts", target: ".opencode/plugin/legacy-plugin.ts" }],
								dependencies: [],
							},
						},
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
			)
		})

		const { manifest } = await fetchComponentVersion("https://legacy.example.com", "legacy-plugin")
		expect(manifest.type).toBe("plugin")
		expect(manifest.files[0]).toEqual({ path: "plugin.ts", target: "plugins/legacy-plugin.ts" })
	})

	it("adapts legacy manifest when schema mode is null (index fetch fails)", async () => {
		globalThis.fetch = mock((input) => {
			const requestUrl = new URL(String(input))

			if (requestUrl.pathname === "/index.json") {
				return Promise.resolve(
					new Response("Service Unavailable", {
						status: 503,
						statusText: "Service Unavailable",
					}),
				)
			}

			return Promise.resolve(
				new Response(
					JSON.stringify({
						name: "null-mode-legacy-plugin",
						"dist-tags": { latest: "1.0.0" },
						versions: {
							"1.0.0": {
								name: "null-mode-legacy-plugin",
								type: "ocx:plugin",
								description: "Legacy-signaled manifest",
								files: [
									{
										path: "index.ts",
										target: ".opencode/plugin/null-mode-legacy-plugin.ts",
									},
								],
								dependencies: [],
							},
						},
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
			)
		})

		const { manifest } = await fetchComponentVersion(
			"https://null-mode-index-fails.example.com",
			"null-mode-legacy-plugin",
		)

		expect(manifest.type).toBe("plugin")
		expect(manifest.files[0]).toEqual({
			path: "index.ts",
			target: "plugins/null-mode-legacy-plugin.ts",
		})
	})

	it("does not apply v2-only legacy rejection errors when schema mode is null", async () => {
		globalThis.fetch = mock((input) => {
			const requestUrl = new URL(String(input))

			if (requestUrl.pathname === "/index.json") {
				return Promise.resolve(new Response("Not Found", { status: 404, statusText: "Not Found" }))
			}

			return Promise.resolve(
				new Response(
					JSON.stringify({
						name: "null-mode-legacy-target",
						"dist-tags": { latest: "2.0.0" },
						versions: {
							"2.0.0": {
								name: "null-mode-legacy-target",
								type: "plugin",
								description: "Legacy target shorthand with unknown schema mode",
								files: [".opencode/profiles/null-mode-legacy-target.jsonc"],
								dependencies: [],
							},
						},
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
			)
		})

		const result = await fetchComponentVersion(
			"https://null-mode-no-v2-rejection.example.com",
			"null-mode-legacy-target",
		)

		expect(result.manifest.files[0]).toBe("profiles/null-mode-legacy-target.jsonc")
	})

	const incompatibleIndexCases = [
		{
			title: "unsupported schema version",
			indexPayload: {
				$schema: "https://ocx.kdco.dev/schemas/v3/registry.json",
				author: "Future Registry",
				components: [],
			},
			expectedIssue: "unsupported-schema-version",
		},
		{
			title: "invalid schema URL",
			indexPayload: {
				$schema: "https://foreign.example.com/registry.json",
				author: "Foreign Registry",
				components: [],
			},
			expectedIssue: "invalid-schema-url",
		},
		{
			title: "invalid index format",
			indexPayload: {
				$schema: REGISTRY_SCHEMA_V2_URL,
				author: "Broken Registry",
				components: [{ invalid: true }],
			},
			expectedIssue: "invalid-format",
		},
	] as const

	for (const incompatibleIndexCase of incompatibleIndexCases) {
		it(`fails loud for ${incompatibleIndexCase.title} (no null-mode fallback)`, async () => {
			globalThis.fetch = mock((input) => {
				const requestUrl = new URL(String(input))

				if (requestUrl.pathname === "/index.json") {
					return Promise.resolve(
						new Response(JSON.stringify(incompatibleIndexCase.indexPayload), {
							status: 200,
							headers: { "content-type": "application/json" },
						}),
					)
				}

				return Promise.resolve(
					new Response(
						JSON.stringify({
							name: "incompatible-index-no-fallback",
							"dist-tags": { latest: "1.0.0" },
							versions: {
								"1.0.0": {
									name: "incompatible-index-no-fallback",
									type: "ocx:plugin",
									description: "Legacy-signaled manifest should not bypass index incompatibility",
									files: [".opencode/plugins/incompatible-index-no-fallback.ts"],
									dependencies: [],
								},
							},
						}),
						{
							status: 200,
							headers: { "content-type": "application/json" },
						},
					),
				)
			})

			try {
				await fetchComponentVersion(
					"https://incompatible-index-no-fallback.example.com",
					"incompatible-index-no-fallback",
				)
				expect.unreachable("Should have thrown")
			} catch (error) {
				expect(error).toBeInstanceOf(RegistryCompatibilityError)
				const compatibilityError = error as RegistryCompatibilityError
				expect(compatibilityError.issue).toBe(incompatibleIndexCase.expectedIssue)
			}
		})
	}

	for (const typeCase of prefixedTypeCases) {
		it(`rejects v2 manifests that use legacy prefixed type ${typeCase.prefixed}`, async () => {
			globalThis.fetch = mock((input) => {
				const requestUrl = new URL(String(input))

				if (requestUrl.pathname === "/index.json") {
					return Promise.resolve(
						new Response(
							JSON.stringify({
								$schema: REGISTRY_SCHEMA_V2_URL,
								author: "Canonical",
								components: [
									{
										name: "legacy-prefixed-manifest",
										type: typeCase.canonical,
										description: "Canonical v2 index entry",
									},
								],
							}),
							{
								status: 200,
								headers: { "content-type": "application/json" },
							},
						),
					)
				}

				return Promise.resolve(
					new Response(
						JSON.stringify({
							name: "legacy-prefixed-manifest",
							"dist-tags": { latest: "1.0.0" },
							versions: {
								"1.0.0": {
									name: "legacy-prefixed-manifest",
									type: typeCase.prefixed,
									description: "Legacy-prefixed manifest type in v2",
									files: [{ path: "index.ts", target: "plugins/legacy-prefixed-manifest.ts" }],
									dependencies: [],
								},
							},
						}),
						{
							status: 200,
							headers: { "content-type": "application/json" },
						},
					),
				)
			})

			await expect(
				fetchComponentVersion(
					"https://v2-prefixed-manifest.example.com",
					"legacy-prefixed-manifest",
				),
			).rejects.toThrow(typeCase.prefixed)
			await expect(
				fetchComponentVersion(
					"https://v2-prefixed-manifest.example.com",
					"legacy-prefixed-manifest",
				),
			).rejects.toThrow(`Use "${typeCase.canonical}"`)
		})
	}

	for (const legacyTarget of legacyTargetPrefixCases) {
		it(`rejects v2 manifests that use legacy target prefix: ${legacyTarget}`, async () => {
			globalThis.fetch = mock((input) => {
				const requestUrl = new URL(String(input))

				if (requestUrl.pathname === "/index.json") {
					return Promise.resolve(
						new Response(
							JSON.stringify({
								$schema: REGISTRY_SCHEMA_V2_URL,
								author: "Canonical",
								components: [
									{
										name: "legacy-target-prefix",
										type: "plugin",
										description: "Canonical v2 index entry",
									},
								],
							}),
							{
								status: 200,
								headers: { "content-type": "application/json" },
							},
						),
					)
				}

				return Promise.resolve(
					new Response(
						JSON.stringify({
							name: "legacy-target-prefix",
							"dist-tags": { latest: "1.0.0" },
							versions: {
								"1.0.0": {
									name: "legacy-target-prefix",
									type: "plugin",
									description: "Legacy target prefix in v2",
									files: [{ path: "index.ts", target: legacyTarget }],
									dependencies: [],
								},
							},
						}),
						{
							status: 200,
							headers: { "content-type": "application/json" },
						},
					),
				)
			})

			await expect(
				fetchComponentVersion("https://v2-legacy-target.example.com", "legacy-target-prefix"),
			).rejects.toThrow(`target "${legacyTarget}"`)
			await expect(
				fetchComponentVersion("https://v2-legacy-target.example.com", "legacy-target-prefix"),
			).rejects.toThrow("use canonical root-relative targets")
			await expect(
				fetchComponentVersion("https://v2-legacy-target.example.com", "legacy-target-prefix"),
			).rejects.toThrow("without .opencode/")
		})
	}

	for (const legacyTarget of legacyTargetPrefixShorthandCases) {
		it(`rejects v2 manifests that use legacy target shorthand prefix: ${legacyTarget}`, async () => {
			globalThis.fetch = mock((input) => {
				const requestUrl = new URL(String(input))

				if (requestUrl.pathname === "/index.json") {
					return Promise.resolve(
						new Response(
							JSON.stringify({
								$schema: REGISTRY_SCHEMA_V2_URL,
								author: "Canonical",
								components: [
									{
										name: "legacy-target-shorthand",
										type: "plugin",
										description: "Canonical v2 index entry",
									},
								],
							}),
							{
								status: 200,
								headers: { "content-type": "application/json" },
							},
						),
					)
				}

				return Promise.resolve(
					new Response(
						JSON.stringify({
							name: "legacy-target-shorthand",
							"dist-tags": { latest: "1.0.0" },
							versions: {
								"1.0.0": {
									name: "legacy-target-shorthand",
									type: "plugin",
									description: "Legacy target shorthand prefix in v2",
									files: [legacyTarget],
									dependencies: [],
								},
							},
						}),
						{
							status: 200,
							headers: { "content-type": "application/json" },
						},
					),
				)
			})

			await expect(
				fetchComponentVersion(
					"https://v2-legacy-target-shorthand.example.com",
					"legacy-target-shorthand",
				),
			).rejects.toThrow(`target "${legacyTarget}"`)
			await expect(
				fetchComponentVersion(
					"https://v2-legacy-target-shorthand.example.com",
					"legacy-target-shorthand",
				),
			).rejects.toThrow("use canonical root-relative targets")
			await expect(
				fetchComponentVersion(
					"https://v2-legacy-target-shorthand.example.com",
					"legacy-target-shorthand",
				),
			).rejects.toThrow("without .opencode/")
		})
	}

	it("keeps canonical v2 manifest targets working", async () => {
		globalThis.fetch = mock((input) => {
			const requestUrl = new URL(String(input))

			if (requestUrl.pathname === "/index.json") {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							$schema: REGISTRY_SCHEMA_V2_URL,
							author: "Canonical",
							components: [
								{
									name: "canonical-target",
									type: "plugin",
									description: "Canonical v2 manifest",
								},
							],
						}),
						{
							status: 200,
							headers: { "content-type": "application/json" },
						},
					),
				)
			}

			return Promise.resolve(
				new Response(
					JSON.stringify({
						name: "canonical-target",
						"dist-tags": { latest: "1.0.0" },
						versions: {
							"1.0.0": {
								name: "canonical-target",
								type: "plugin",
								description: "Canonical manifest",
								files: [{ path: "index.ts", target: "plugins/canonical-target.ts" }],
								dependencies: [],
							},
						},
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
			)
		})

		const { manifest } = await fetchComponentVersion(
			"https://v2-canonical-target.example.com",
			"canonical-target",
		)
		expect(manifest.files[0]).toEqual({ path: "index.ts", target: "plugins/canonical-target.ts" })
	})

	it("loads legacy fixture manifests for kit/ws and kit/omo", async () => {
		const fixtureRegistry = startLegacyFixtureRegistry("kit")

		try {
			const ws = await fetchComponentVersion(fixtureRegistry.url, "ws")
			expect(ws.manifest.name).toBe("ws")
			expect(ws.manifest.type).toBe("profile")
			expect(
				ws.manifest.files.map((file) => (typeof file === "string" ? file : file.target)),
			).toEqual(["profiles/ws/ocx.jsonc", "profiles/ws/opencode.jsonc"])

			const omo = await fetchComponentVersion(fixtureRegistry.url, "omo")
			expect(omo.manifest.name).toBe("omo")
			expect(omo.manifest.type).toBe("profile")
			expect(
				omo.manifest.files.map((file) => (typeof file === "string" ? file : file.target)),
			).toEqual(["profiles/omo/ocx.jsonc", "profiles/omo/opencode.jsonc"])
		} finally {
			fixtureRegistry.stop()
		}
	})

	const unsafeTargets = [
		{
			target: ".opencode/plugin/../../escape.ts",
			reason: "traversal",
		},
		{
			target: ".opencode/plugin/%2e%2e/escape.ts",
			reason: "encoded",
		},
		{
			target: ".opencode\\plugin\\escape.ts",
			reason: "Windows separators",
		},
		{
			target: ".opencode/plugin//escape.ts",
			reason: "empty path segments",
		},
	]

	for (const unsafe of unsafeTargets) {
		it(`rejects unsafe canonicalization target: ${unsafe.target}`, async () => {
			globalThis.fetch = mock((input) => {
				const requestUrl = new URL(String(input))

				if (requestUrl.pathname === "/index.json") {
					return Promise.resolve(
						new Response(
							JSON.stringify({
								author: "Legacy",
								components: [
									{ name: "unsafe-plugin", type: "ocx:plugin", description: "Unsafe plugin" },
								],
							}),
							{
								status: 200,
								headers: { "content-type": "application/json" },
							},
						),
					)
				}

				return Promise.resolve(
					new Response(
						JSON.stringify({
							name: "unsafe-plugin",
							"dist-tags": { latest: "1.4.6" },
							versions: {
								"1.4.6": {
									name: "unsafe-plugin",
									type: "ocx:plugin",
									description: "Unsafe plugin",
									files: [{ path: "plugin.ts", target: unsafe.target }],
									dependencies: [],
								},
							},
						}),
						{
							status: 200,
							headers: { "content-type": "application/json" },
						},
					),
				)
			})

			try {
				await fetchComponentVersion("https://legacy.example.com", "unsafe-plugin")
				expect.unreachable("Should have thrown")
			} catch (error) {
				expect(error).toBeInstanceOf(ValidationError)
				expect((error as ValidationError).message).toContain("Unsafe target")
				expect((error as ValidationError).message).toContain(unsafe.reason)
			}
		})
	}
})

import { afterEach, describe, expect, it, mock } from "bun:test"
import {
	_clearFetcherCacheForTests,
	fetchFileContent,
	fetchRegistryIndex,
} from "../../src/registry/fetcher"
import { NetworkError, NotFoundError } from "../../src/utils/errors"

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
	})
})

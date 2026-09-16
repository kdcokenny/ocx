import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { lookupExactNpmVersionState } from "../src/utils/npm-registry"

describe("lookupExactNpmVersionState", () => {
	let fetchSpy: ReturnType<typeof spyOn>

	beforeEach(() => {
		fetchSpy = spyOn(globalThis, "fetch")
	})

	afterEach(() => {
		fetchSpy.mockRestore()
	})

	it("returns published for an exact preview release", async () => {
		fetchSpy.mockResolvedValue(
			new Response(JSON.stringify({ name: "ocx", version: "3.0.0-alpha.1" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		)

		const result = await lookupExactNpmVersionState("ocx", "3.0.0-alpha.1")
		expect(result).toEqual({ state: "published" })
		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://registry.npmjs.org/ocx/3.0.0-alpha.1")
	})

	it("calls exact encoded scoped name/version endpoint", async () => {
		fetchSpy.mockResolvedValue(
			new Response(JSON.stringify({ name: "@scope/pkg", version: "1.2.3" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		)

		const result = await lookupExactNpmVersionState("@scope/pkg", "1.2.3")
		expect(result).toEqual({ state: "published" })
		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://registry.npmjs.org/@scope%2Fpkg/1.2.3")
	})

	it("returns missing on 404", async () => {
		fetchSpy.mockResolvedValue(new Response("Not Found", { status: 404, statusText: "Not Found" }))

		const result = await lookupExactNpmVersionState("ocx", "1.2.3")
		expect(result).toEqual({ state: "missing" })
	})

	it("returns indeterminate-error for non-404 HTTP status", async () => {
		fetchSpy.mockResolvedValue(
			new Response("Bad Gateway", { status: 502, statusText: "Bad Gateway" }),
		)

		const result = await lookupExactNpmVersionState("ocx", "1.2.3")
		expect(result).toEqual({ state: "indeterminate-error", reason: "http-502" })
	})

	it("returns indeterminate-error for malformed JSON response", async () => {
		fetchSpy.mockResolvedValue(
			new Response("{not valid json", {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		)

		const result = await lookupExactNpmVersionState("ocx", "1.2.3")
		expect(result).toEqual({
			state: "indeterminate-error",
			reason: "malformed-response:invalid-json",
		})
	})

	it("returns indeterminate-error for non-object JSON payload", async () => {
		fetchSpy.mockResolvedValue(
			new Response(JSON.stringify(["ocx", "1.2.3"]), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		)

		const result = await lookupExactNpmVersionState("ocx", "1.2.3")
		expect(result).toEqual({
			state: "indeterminate-error",
			reason: "malformed-response:non-object",
		})
	})

	it("returns indeterminate-error for mismatched response payload", async () => {
		fetchSpy.mockResolvedValue(
			new Response(JSON.stringify({ name: "ocx", version: "9.9.9" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		)

		const result = await lookupExactNpmVersionState("ocx", "1.2.3")
		expect(result).toEqual({
			state: "indeterminate-error",
			reason: "malformed-response:mismatched-name-or-version",
		})
	})

	it("returns indeterminate-error for timeout/network exceptions", async () => {
		fetchSpy.mockRejectedValue(Object.assign(new Error("timed out"), { name: "TimeoutError" }))

		const timeoutResult = await lookupExactNpmVersionState("ocx", "1.2.3")
		expect(timeoutResult).toEqual({ state: "indeterminate-error", reason: "timeout" })

		fetchSpy.mockRejectedValue(new Error("socket hang up"))
		const networkResult = await lookupExactNpmVersionState("ocx", "1.2.3")
		expect(networkResult.state).toBe("indeterminate-error")
		if (networkResult.state === "indeterminate-error") {
			expect(networkResult.reason).toContain("network:")
		}
	})
})

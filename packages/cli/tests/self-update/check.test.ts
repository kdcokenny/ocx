import { afterEach, expect, mock, test } from "bun:test"
import { checkForUpdate } from "../../src/self-update/check"

const originalFetch = globalThis.fetch
afterEach(() => {
	globalThis.fetch = originalFetch
})
function registry(latest: string, next = latest) {
	globalThis.fetch = mock(async () =>
		Response.json({
			name: "ocx",
			"dist-tags": { latest, next },
			versions: Object.fromEntries(
				[latest, next].map((version) => [version, { name: "ocx", version }]),
			),
		}),
	)
}
test("development mode never requests npm metadata", async () => {
	globalThis.fetch = mock(() => {
		throw new Error("unexpected fetch")
	})
	expect(await checkForUpdate()).toEqual({ ok: false, reason: "dev-version" })
	expect(await checkForUpdate({ version: "" })).toEqual({ ok: false, reason: "dev-version" })
	expect(globalThis.fetch).not.toHaveBeenCalled()
})
test.each([
	["1.0.0", "1.0.1", true],
	["1.1.0", "1.0.0", false],
	["1.0.0", "1.0.0", false],
	["3.0.0-alpha.1", "3.0.0-alpha.2", true],
	["3.0.0-beta.2", "3.0.0-beta.10", true],
	["3.0.0", "3.0.0-rc.1", false],
])("compares release precedence from %s to %s", async (current, latest, updateAvailable) => {
	registry(latest as string)
	expect(await checkForUpdate({ version: current as string })).toEqual({
		ok: true,
		current,
		latest,
		updateAvailable,
	})
})
test("selects next rather than the frozen latest for OCX 3", async () => {
	registry("2.0.15", "3.0.0-alpha.2")
	expect(await checkForUpdate({ version: "3.0.0-alpha.1" })).toEqual({
		ok: true,
		current: "3.0.0-alpha.1",
		latest: "3.0.0-alpha.2",
		updateAvailable: true,
	})
})
test("refuses a different major even if next points there", async () => {
	registry("2.0.15", "4.0.0")
	expect(await checkForUpdate({ version: "3.0.0-alpha.1" })).toEqual({
		ok: false,
		reason: "incompatible-major",
	})
})
test("rejects malformed latest versions before constructing download URLs", async () => {
	registry("3.0.0/../../evil")
	expect(await checkForUpdate({ version: "3.0.0-alpha.1" })).toEqual({
		ok: false,
		reason: "invalid-response",
	})
})
test("reports unavailable or malformed registry metadata", async () => {
	globalThis.fetch = mock(async () => {
		throw new Error("offline")
	})
	expect(await checkForUpdate({ version: "3.0.0-alpha.1" })).toEqual({
		ok: false,
		reason: "network-error",
	})
	globalThis.fetch = mock(async () => Response.json({ bad: true }))
	expect(await checkForUpdate({ version: "3.0.0-alpha.1" })).toEqual({
		ok: false,
		reason: "invalid-response",
	})
})
test("aborts requests at the caller's timeout", async () => {
	let signal: AbortSignal | undefined
	globalThis.fetch = mock(
		(_url, init) =>
			new Promise((_resolve, reject) => {
				signal = init?.signal ?? undefined
				signal?.addEventListener("abort", () => reject(signal?.reason), { once: true })
			}),
	)
	expect((await checkForUpdate({ version: "3.0.0-alpha.1" }, 20)).ok).toBe(false)
	expect(signal?.aborted).toBe(true)
})

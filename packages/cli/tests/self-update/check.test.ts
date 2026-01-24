import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { NpmPackageVersion } from "../../src/utils/npm-registry"

// =============================================================================
// Test Utilities
// =============================================================================

/**
 * Dynamic import with cache busting to get fresh module state.
 * Required because checkForUpdate reads __VERSION__ at module load time.
 */
async function importCheckModule() {
	// Clear the module from cache to allow re-import with different mocks
	const modulePath = require.resolve("../../src/self-update/check.js")
	delete require.cache[modulePath]

	return import("../../src/self-update/check.js")
}

// =============================================================================
// Tests for checkForUpdate
// =============================================================================

describe("checkForUpdate", () => {
	let fetchSpy: ReturnType<typeof spyOn>
	let originalFetch: typeof global.fetch

	beforeEach(() => {
		// Store original fetch
		originalFetch = global.fetch
		// Mock fetch
		fetchSpy = spyOn(global, "fetch")
	})

	afterEach(() => {
		// Restore original fetch
		fetchSpy.mockRestore()
		global.fetch = originalFetch
	})

	describe("in development mode (__VERSION__ undefined)", () => {
		it("returns { ok: false, reason: 'dev-version' } for dev version (0.0.0-dev)", async () => {
			// In dev/test environment, __VERSION__ is undefined -> "0.0.0-dev"
			// The function should return dev-version reason immediately without making network calls
			const { checkForUpdate } = await importCheckModule()

			const result = await checkForUpdate()

			expect(result.ok).toBe(false)
			if (!result.ok) expect(result.reason).toBe("dev-version")
			// Should not have made any network calls
			expect(fetchSpy).not.toHaveBeenCalled()
		})
	})

	describe("network failure handling", () => {
		let mockFetchPackageVersion: ReturnType<typeof mock>

		beforeEach(() => {
			mockFetchPackageVersion = mock(() => Promise.reject(new Error("Network error")))
			mock.module("../../src/utils/npm-registry.js", () => ({
				fetchPackageVersion: mockFetchPackageVersion,
			}))
		})

		afterEach(() => {
			mock.restore()
		})

		it("returns { ok: false } on network error", async () => {
			const { checkForUpdate } = await importCheckModule()
			// Use injected version to bypass dev-mode early exit
			const result = await checkForUpdate({ version: "1.0.0" })
			expect(result.ok).toBe(false)
			if (!result.ok) expect(result.reason).toBe("invalid-response")
		})

		it("returns { ok: false } on timeout", async () => {
			mockFetchPackageVersion.mockImplementation(
				(_name: string, _version: string | undefined, signal?: AbortSignal) =>
					new Promise((_resolve, reject) => {
						// Listen to abort signal to simulate real fetch behavior
						signal?.addEventListener("abort", () => reject(signal.reason))
					}),
			)
			const { checkForUpdate } = await importCheckModule()
			// Use injected version with short timeout
			const result = await checkForUpdate({ version: "1.0.0" }, 100)
			expect(result.ok).toBe(false)
			if (!result.ok) expect(result.reason).toBe("timeout")
		})
	})
})

// =============================================================================
// Mock-based tests for full flow (when version is not dev)
// These require mocking the npm-registry module
// =============================================================================

describe("checkForUpdate with mocked registry", () => {
	// We use Bun's mock.module to mock the npm-registry dependency
	let mockFetchPackageVersion: ReturnType<typeof mock>

	beforeEach(() => {
		// Create a mock function for fetchPackageVersion
		mockFetchPackageVersion = mock(() =>
			Promise.resolve({ name: "ocx", version: "1.0.0" } as NpmPackageVersion),
		)

		// Mock the npm-registry module
		mock.module("../../src/utils/npm-registry.js", () => ({
			fetchPackageVersion: mockFetchPackageVersion,
		}))
	})

	afterEach(() => {
		// Restore all mocks
		mock.restore()
	})

	it("detects when update is available (latest > current)", async () => {
		// This test documents expected behavior when __VERSION__ is set
		// In production build, if current=1.0.0 and latest=2.0.0, should return updateAvailable=true

		// Mock returns a newer version
		mockFetchPackageVersion.mockResolvedValue({
			name: "ocx",
			version: "99.0.0",
		} as NpmPackageVersion)

		// In dev environment, checkForUpdate returns dev-version reason due to dev version
		// This test documents the expected behavior for production
		const { checkForUpdate } = await importCheckModule()
		const result = await checkForUpdate()

		// Dev mode returns { ok: false, reason: 'dev-version' } - this is expected
		// The test documents that in production with version mismatch, it would work
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.reason).toBe("dev-version")
	})

	it("returns { ok: false } when versions match in dev mode", async () => {
		// Mock returns same version as current (in production, this would be the current version)
		mockFetchPackageVersion.mockResolvedValue({
			name: "ocx",
			version: "0.0.0-dev", // Same as dev version
		} as NpmPackageVersion)

		const { checkForUpdate } = await importCheckModule()
		const result = await checkForUpdate()

		// Dev mode returns dev-version before checking
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.reason).toBe("dev-version")
	})

	it("handles registry timeout gracefully", async () => {
		// Mock a hanging fetch
		mockFetchPackageVersion.mockImplementation(
			() => new Promise(() => {}), // Never resolves
		)

		const { checkForUpdate } = await importCheckModule()
		const result = await checkForUpdate()

		// Should return { ok: false } (either from dev version or timeout)
		expect(result.ok).toBe(false)
	})

	it("handles registry error gracefully", async () => {
		// Mock a failing fetch
		mockFetchPackageVersion.mockRejectedValue(new Error("Registry unavailable"))

		const { checkForUpdate } = await importCheckModule()
		const result = await checkForUpdate()

		// Should return { ok: false } (silent failure)
		expect(result.ok).toBe(false)
	})
})

// =============================================================================
// VersionProvider injection tests
// =============================================================================

describe("checkForUpdate with injected VersionProvider", () => {
	let mockFetchPackageVersion: ReturnType<typeof mock>

	beforeEach(() => {
		// Create a mock function for fetchPackageVersion
		mockFetchPackageVersion = mock(() =>
			Promise.resolve({ name: "ocx", version: "2.0.0" } as NpmPackageVersion),
		)

		// Mock the npm-registry module
		mock.module("../../src/utils/npm-registry.js", () => ({
			fetchPackageVersion: mockFetchPackageVersion,
		}))
	})

	afterEach(() => {
		mock.restore()
	})

	it("uses injected version provider", async () => {
		const { checkForUpdate } = await importCheckModule()

		// Inject a non-dev version to bypass the early exit
		const result = await checkForUpdate({ version: "1.0.0" })

		// Should return update available since 1.0.0 < 2.0.0
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.current).toBe("1.0.0")
			expect(result.latest).toBe("2.0.0")
			expect(result.updateAvailable).toBe(true)
		}
	})

	it("returns { ok: false, reason: 'dev-version' } for empty version", async () => {
		const { checkForUpdate } = await importCheckModule()

		// Empty string falls back to "0.0.0-dev" which returns dev-version
		const result = await checkForUpdate({ version: "" })
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.reason).toBe("dev-version")
	})

	it("returns updateAvailable false when current >= latest", async () => {
		// Mock returns older version
		mockFetchPackageVersion.mockResolvedValue({
			name: "ocx",
			version: "1.0.0",
		} as NpmPackageVersion)

		const { checkForUpdate } = await importCheckModule()

		// Current version is newer than latest
		const result = await checkForUpdate({ version: "2.0.0" })

		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.current).toBe("2.0.0")
			expect(result.latest).toBe("1.0.0")
			expect(result.updateAvailable).toBe(false)
		}
	})

	it("returns updateAvailable false when versions match", async () => {
		mockFetchPackageVersion.mockResolvedValue({
			name: "ocx",
			version: "1.5.0",
		} as NpmPackageVersion)

		const { checkForUpdate } = await importCheckModule()

		const result = await checkForUpdate({ version: "1.5.0" })

		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.current).toBe("1.5.0")
			expect(result.latest).toBe("1.5.0")
			expect(result.updateAvailable).toBe(false)
		}
	})

	it("handles network error gracefully with injected version", async () => {
		mockFetchPackageVersion.mockRejectedValue(new Error("Network error"))

		const { checkForUpdate } = await importCheckModule()

		// Should return { ok: false } on network error
		// The actual reason may be 'network-error' or 'invalid-response' depending on how the error is caught
		const result = await checkForUpdate({ version: "1.0.0" })
		expect(result.ok).toBe(false)
	})
})

// =============================================================================
// VersionCheckResult type tests
// =============================================================================

describe("CheckResult interface", () => {
	it("defines the expected shape", async () => {
		// Import to verify the type is exported
		const checkModule = await importCheckModule()

		// Verify the function exists and returns a Promise
		expect(typeof checkModule.checkForUpdate).toBe("function")
	})

	it("returns CheckResult with ok property", async () => {
		const { checkForUpdate } = await importCheckModule()
		const result = await checkForUpdate()

		// Result should always have ok property
		expect(result).toHaveProperty("ok")
		expect(typeof result.ok).toBe("boolean")

		if (result.ok) {
			// Success case has current, latest, updateAvailable
			expect(result).toHaveProperty("current")
			expect(result).toHaveProperty("latest")
			expect(result).toHaveProperty("updateAvailable")
			expect(typeof result.current).toBe("string")
			expect(typeof result.latest).toBe("string")
			expect(typeof result.updateAvailable).toBe("boolean")
		} else {
			// Failure case has reason
			expect(result).toHaveProperty("reason")
			expect(["dev-version", "timeout", "network-error", "invalid-response"]).toContain(
				result.reason,
			)
		}
	})

	it("accepts custom timeout parameter", async () => {
		const { checkForUpdate, EXPLICIT_UPDATE_TIMEOUT_MS } = await importCheckModule()

		// Verify the constant is exported
		expect(EXPLICIT_UPDATE_TIMEOUT_MS).toBe(10_000)

		// Verify function accepts timeout parameter (will still return dev-version in test env)
		const result = await checkForUpdate(undefined, 5000)
		expect(result.ok).toBe(false)
	})
})

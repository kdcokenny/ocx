import { describe, expect, it } from "bun:test"

describe("CLI startup performance", () => {
	it("should not load token-estimation module during CLI startup", async () => {
		// This test verifies that importing index.ts (CLI entry point)
		// does NOT load the token-estimation module, which would cause
		// overhead even though tiktoken itself uses dynamic import.
		//
		// The token-estimation module should only be loaded when
		// the `component info` command is actually executed.

		// Check modules before importing CLI
		const modulesBeforeImport = Object.keys(require.cache || {})
		const hasTokenEstimationBefore = modulesBeforeImport.some((path) =>
			path.includes("token-estimation"),
		)

		// Token estimation module should NOT be loaded yet
		expect(hasTokenEstimationBefore).toBe(false)

		// Import the CLI entry point (this triggers all command registrations)
		await import("../src/index")

		// After importing CLI, check if token-estimation was loaded
		const modulesAfterImport = Object.keys(require.cache || {})
		const hasTokenEstimationAfter = modulesAfterImport.some((path) =>
			path.includes("token-estimation"),
		)

		// Token estimation should STILL not be loaded
		// (it should only load when component info command runs)
		expect(hasTokenEstimationAfter).toBe(false)
	})

	it("should not load tiktoken during CLI startup", async () => {
		// Double-check that tiktoken itself is also not loaded
		const modulesBeforeImport = Object.keys(require.cache || {})
		const hasTiktokenBefore = modulesBeforeImport.some((path) => path.includes("tiktoken"))

		expect(hasTiktokenBefore).toBe(false)

		// Import CLI
		await import("../src/index")

		// tiktoken should still not be loaded
		const modulesAfterImport = Object.keys(require.cache || {})
		const hasTiktokenAfter = modulesAfterImport.some((path) => path.includes("tiktoken"))

		expect(hasTiktokenAfter).toBe(false)
	})
})

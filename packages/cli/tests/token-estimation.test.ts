import { describe, expect, it } from "bun:test"
import { estimateTokens, estimateTokensMultiModel } from "../src/utils/token-estimation"

describe("token estimation", () => {
	describe("lazy loading", () => {
		it("should not load tiktoken module until estimateTokens is called", async () => {
			// This test verifies that tiktoken is loaded lazily (dynamic import)
			// to avoid the 24MB WASM binary loading at CLI startup

			// Check that tiktoken is not in the require cache before we call estimateTokens
			const tiktokenModuleName = "tiktoken"
			const initialModules = Object.keys(require.cache || {})
			const hasTiktokenBeforeCall = initialModules.some((path) => path.includes(tiktokenModuleName))

			// tiktoken should NOT be loaded yet (this will fail with static import)
			expect(hasTiktokenBeforeCall).toBe(false)

			// Now call estimateTokens - this should trigger the lazy load
			await estimateTokens("test", "gpt4o")

			// After calling, tiktoken should now be loaded
			const modulesAfterCall = Object.keys(require.cache || {})
			const hasTiktokenAfterCall = modulesAfterCall.some((path) =>
				path.includes(tiktokenModuleName),
			)
			expect(hasTiktokenAfterCall).toBe(true)
		})
	})

	describe("estimateTokens", () => {
		it("should count GPT-4o tokens accurately", async () => {
			const text = "Hello, world! This is a test."
			const count = await estimateTokens(text, "gpt4o")

			expect(count).toBeGreaterThan(0)
			expect(typeof count).toBe("number")
		})

		it("should approximate Claude tokens", async () => {
			const text = "Hello, world! This is a test."
			const count = await estimateTokens(text, "claude")

			expect(count).toBeGreaterThan(0)
			expect(typeof count).toBe("number")
		})

		it("should return 0 for empty string", async () => {
			const count = await estimateTokens("", "gpt4o")
			expect(count).toBe(0)
		})
	})

	describe("estimateTokensMultiModel", () => {
		it("should return estimates for claude and gpt4o", async () => {
			const text = "Hello, world! This is a test."
			const estimates = await estimateTokensMultiModel(text)

			expect(estimates).toHaveProperty("claude")
			expect(estimates).toHaveProperty("gpt4o")
			expect(estimates).toHaveProperty("average")

			expect(typeof estimates.claude).toBe("number")
			expect(typeof estimates.gpt4o).toBe("number")
			expect(typeof estimates.average).toBe("number")
		})

		it("should calculate average of claude and gpt4o", async () => {
			const text = "Hello, world! This is a test."
			const estimates = await estimateTokensMultiModel(text)

			// Average should be reasonable
			expect(estimates.average).toBeGreaterThan(0)

			// Average should be the mean of claude and gpt4o
			const expectedAvg = (estimates.claude + estimates.gpt4o) / 2
			expect(Math.abs(estimates.average - expectedAvg)).toBeLessThan(1)
		})
	})
})

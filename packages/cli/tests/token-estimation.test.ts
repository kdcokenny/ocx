import { describe, expect, it } from "bun:test"
import { estimateTokens, estimateTokensMultiModel } from "../src/utils/token-estimation"

describe("token estimation", () => {
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

		it("should count Gemini tokens when available", async () => {
			const text = "Hello, world! This is a test."
			const count = await estimateTokens(text, "gemini")

			// Gemini may return null if API not available
			expect(count === null || typeof count === "number").toBe(true)
			if (count !== null) {
				expect(count).toBeGreaterThan(0)
			}
		})

		it("should return 0 for empty string", async () => {
			const count = await estimateTokens("", "gpt4o")
			expect(count).toBe(0)
		})
	})

	describe("estimateTokensMultiModel", () => {
		it("should return estimates for all models", async () => {
			const text = "Hello, world! This is a test."
			const estimates = await estimateTokensMultiModel(text)

			expect(estimates).toHaveProperty("claude")
			expect(estimates).toHaveProperty("gpt4o")
			expect(estimates).toHaveProperty("gemini")
			expect(estimates).toHaveProperty("average")

			expect(typeof estimates.claude).toBe("number")
			expect(typeof estimates.gpt4o).toBe("number")
			expect(estimates.gemini === null || typeof estimates.gemini === "number").toBe(true)
			expect(typeof estimates.average).toBe("number")
		})

		it("should calculate average correctly", async () => {
			const text = "Hello, world! This is a test."
			const estimates = await estimateTokensMultiModel(text)

			// Average should be reasonable
			expect(estimates.average).toBeGreaterThan(0)

			// If gemini is available, average should include it
			if (estimates.gemini !== null) {
				const expectedAvg = (estimates.claude + estimates.gpt4o + estimates.gemini) / 3
				expect(Math.abs(estimates.average - expectedAvg)).toBeLessThan(1)
			} else {
				// If gemini is null, average should only include claude and gpt4o
				const expectedAvg = (estimates.claude + estimates.gpt4o) / 2
				expect(Math.abs(estimates.average - expectedAvg)).toBeLessThan(1)
			}
		})
	})
})

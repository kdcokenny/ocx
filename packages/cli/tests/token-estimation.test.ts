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

		it("should return 0 for empty string", async () => {
			const count = await estimateTokens("", "gpt4o")
			expect(count).toBe(0)
		})
	})

	describe("estimateTokensMultiModel", () => {
		it("should return estimates for claude and gpt4o only", async () => {
			const text = "Hello, world! This is a test."
			const estimates = await estimateTokensMultiModel(text)

			expect(estimates).toHaveProperty("claude")
			expect(estimates).toHaveProperty("gpt4o")
			expect(estimates).toHaveProperty("average")
			expect(estimates).not.toHaveProperty("gemini")

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

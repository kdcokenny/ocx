import { encoding_for_model } from "tiktoken"

/**
 * Supported model types for token estimation.
 */
export type ModelType = "claude" | "gpt4o"

/**
 * Token estimation result for multiple models.
 */
export type TokenEstimate = {
	/**
	 * Approximate token count for Claude models.
	 * Note: This is an approximation using GPT-4o tokenizer.
	 */
	claude: number
	/**
	 * Exact token count for GPT-4o.
	 */
	gpt4o: number
	/**
	 * Average token count across models.
	 */
	average: number
}

/**
 * Estimate token count for a given text and model.
 *
 * @param text - The text to estimate tokens for
 * @param model - The model type to use for estimation
 * @returns Promise resolving to token count, or null if estimation fails (Gemini only)
 *
 * @example
 * ```typescript
 * const count = await estimateTokens("Hello world", "gpt4o")
 * console.log(count) // e.g., 2
 * ```
 */
export async function estimateTokens(text: string, model: ModelType): Promise<number | null> {
	// Handle empty string
	if (text.length === 0) {
		return 0
	}

	switch (model) {
		case "gpt4o":
		case "claude": {
			// Use cl100k_base encoding for both GPT-4o (exact) and Claude (approximation)
			// Note: Claude uses a different tokenizer, but cl100k_base provides
			// a reasonable approximation (typically within ±10-15%)
			const encoder = encoding_for_model("gpt-4o")
			try {
				const tokens = encoder.encode(text)
				return tokens.length
			} finally {
				encoder.free()
			}
		}

		default: {
			const _exhaustive: never = model
			throw new Error(`Unknown model type: ${_exhaustive}`)
		}
	}
}

/**
 * Estimate token count for a text across all supported models.
 *
 * @param text - The text to estimate tokens for
 * @returns Promise resolving to token estimates for all models
 *
 * @example
 * ```typescript
 * const estimates = await estimateTokensMultiModel("Hello world")
 * console.log(estimates)
 * // { claude: 2, gpt4o: 2, gemini: 3, average: 2.33 }
 * ```
 */
export async function estimateTokensMultiModel(text: string): Promise<TokenEstimate> {
	// Get estimates for all models in parallel
	const [claude, gpt4o] = await Promise.all([
		estimateTokens(text, "claude"),
		estimateTokens(text, "gpt4o"),
	])

	// Calculate average of claude and gpt4o
	const counts: number[] = []
	if (claude !== null) counts.push(claude)
	if (gpt4o !== null) counts.push(gpt4o)

	const average = counts.length > 0 ? counts.reduce((a, b) => a + b, 0) / counts.length : 0

	return {
		claude: claude ?? 0,
		gpt4o: gpt4o ?? 0,
		average,
	}
}

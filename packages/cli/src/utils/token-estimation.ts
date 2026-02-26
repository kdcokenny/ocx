import { GoogleGenerativeAI } from "@google/generative-ai"
import { encoding_for_model } from "tiktoken"

/**
 * Supported model types for token estimation.
 */
export type ModelType = "claude" | "gpt4o" | "gemini"

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
	 * Token count for Gemini 2.0 Flash.
	 * May be null if API initialization fails.
	 */
	gemini: number | null
	/**
	 * Average token count across available models.
	 * Excludes null values from calculation.
	 */
	average: number
}

let geminiModel: ReturnType<GoogleGenerativeAI["getGenerativeModel"]> | null = null
let geminiInitError: Error | null = null

/**
 * Initialize Gemini model for token counting.
 * This is lazy-initialized on first use.
 */
function initGeminiModel() {
	if (geminiModel || geminiInitError) {
		return
	}

	try {
		// Gemini API key is not required for countTokens in some configurations
		// We'll try to initialize without an API key first
		const genAI = new GoogleGenerativeAI("")
		geminiModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" })
	} catch (error) {
		geminiInitError = error instanceof Error ? error : new Error(String(error))
	}
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

		case "gemini": {
			// Initialize Gemini model if not already done
			initGeminiModel()

			// Return null if initialization failed
			if (geminiInitError || !geminiModel) {
				return null
			}

			try {
				// Use Gemini's countTokens API for accurate token counting
				const result = await geminiModel.countTokens(text)
				return result.totalTokens
			} catch {
				// If token counting fails, return null
				// This can happen if API is not available or other network issues
				return null
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
	const [claude, gpt4o, gemini] = await Promise.all([
		estimateTokens(text, "claude"),
		estimateTokens(text, "gpt4o"),
		estimateTokens(text, "gemini"),
	])

	// Calculate average excluding null values
	const counts: number[] = []
	if (claude !== null) counts.push(claude)
	if (gpt4o !== null) counts.push(gpt4o)
	if (gemini !== null) counts.push(gemini)

	const average = counts.length > 0 ? counts.reduce((a, b) => a + b, 0) / counts.length : 0

	return {
		claude: claude ?? 0,
		gpt4o: gpt4o ?? 0,
		gemini,
		average,
	}
}

/**
 * Promise timeout utility for kdco registry plugins.
 *
 * Provides a clean wrapper around Promise.race for timeout handling,
 * replacing inline timeout patterns throughout the codebase.
 *
 * @module kdco-primitives/with-timeout
 */

/**
 * Error thrown when a promise times out.
 * Extends Error for proper instanceof checks and stack traces.
 */
export class TimeoutError extends Error {
	readonly name = "TimeoutError" as const
	readonly timeoutMs: number

	constructor(message: string, timeoutMs: number) {
		super(message)
		this.timeoutMs = timeoutMs
	}
}

/**
 * Wraps a promise with a timeout.
 *
 * Uses Promise.race to implement timeout semantics. If the wrapped promise
 * doesn't resolve within the specified time, throws a TimeoutError.
 *
 * **Important:** This does NOT abort the underlying promise - it continues
 * running in the background. Use AbortController for true cancellation.
 *
 * @param promise - The promise to wrap
 * @param ms - Timeout in milliseconds
 * @param message - Optional error message (defaults to "Operation timed out")
 * @returns The resolved value from the promise
 * @throws {TimeoutError} When the timeout expires before the promise resolves
 *
 * @example
 * ```ts
 * // Basic usage
 * const result = await withTimeout(
 *   fetchData(),
 *   5000,
 *   "Data fetch timed out"
 * )
 *
 * // Handling timeout
 * try {
 *   const result = await withTimeout(slowOperation(), 1000)
 * } catch (error) {
 *   if (error instanceof TimeoutError) {
 *     console.log(`Timed out after ${error.timeoutMs}ms`)
 *   }
 * }
 * ```
 */
export async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	message = "Operation timed out",
): Promise<T> {
	// Guard: Invalid timeout value (Law 1: Early Exit, Law 4: Fail Fast)
	if (typeof ms !== "number" || ms < 0) {
		throw new Error(`withTimeout: timeout must be a non-negative number, got ${ms}`)
	}

	// Guard: Zero timeout means immediate rejection
	if (ms === 0) {
		throw new TimeoutError(message, ms)
	}

	// Race between the promise and a timeout
	// Clear timer when promise resolves to prevent leaks
	let timeoutId: Timer
	return Promise.race([
		promise.finally(() => clearTimeout(timeoutId)),
		new Promise<never>((_, reject) => {
			timeoutId = setTimeout(() => {
				reject(new TimeoutError(message, ms))
			}, ms)
		}),
	])
}

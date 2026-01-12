/**
 * Promise-based mutex for serializing async operations.
 *
 * Provides a simple lock mechanism using native Promise mechanics.
 * No external dependencies required.
 *
 * @module kdco-primitives/mutex
 */

/**
 * Simple promise-based mutex for serializing async operations.
 *
 * Uses a queue of pending waiters to ensure fair ordering.
 * Each waiter is resolved in FIFO order when the lock is released.
 *
 * @example
 * ```ts
 * const mutex = new Mutex()
 *
 * // Option 1: Manual acquire/release (use try-finally!)
 * await mutex.acquire()
 * try {
 *   await criticalSection()
 * } finally {
 *   mutex.release()
 * }
 *
 * // Option 2: Automatic acquire/release (preferred)
 * const result = await mutex.runExclusive(async () => {
 *   return await criticalSection()
 * })
 * ```
 */
export class Mutex {
	private locked = false
	private queue: (() => void)[] = []

	/**
	 * Acquire the mutex lock.
	 *
	 * If the mutex is unlocked, immediately acquires and returns.
	 * If locked, waits in queue until released by current holder.
	 *
	 * @returns Promise that resolves when lock is acquired
	 *
	 * @example
	 * ```ts
	 * await mutex.acquire()
	 * try {
	 *   // Critical section - only one caller at a time
	 * } finally {
	 *   mutex.release() // Always release in finally!
	 * }
	 * ```
	 */
	async acquire(): Promise<void> {
		// Fast path: lock is available (Law 1: Early Exit)
		if (!this.locked) {
			this.locked = true
			return
		}

		// Slow path: wait in queue for lock release
		return new Promise<void>((resolve) => {
			this.queue.push(resolve)
		})
	}

	/**
	 * Release the mutex lock.
	 *
	 * If waiters are queued, passes the lock to the next waiter (FIFO).
	 * Otherwise, marks the mutex as unlocked.
	 *
	 * @example
	 * ```ts
	 * mutex.release() // Must be called after acquire()
	 * ```
	 */
	release(): void {
		const next = this.queue.shift()
		if (next) {
			// Pass lock to next waiter (stays locked)
			next()
		} else {
			// No waiters, unlock
			this.locked = false
		}
	}

	/**
	 * Execute a function exclusively under mutex protection.
	 *
	 * Automatically acquires the lock before execution and releases
	 * after completion, even if the function throws an error.
	 * This is the preferred way to use the mutex.
	 *
	 * @param fn - Async function to execute exclusively
	 * @returns The function's return value
	 *
	 * @example
	 * ```ts
	 * // Serialize tmux commands to prevent socket races
	 * const result = await tmuxMutex.runExclusive(async () => {
	 *   return await execTmuxCommand(["list-windows"])
	 * })
	 *
	 * // Serialize database writes
	 * await dbMutex.runExclusive(async () => {
	 *   await db.update(record)
	 * })
	 * ```
	 */
	async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
		await this.acquire()
		try {
			return await fn()
		} finally {
			this.release()
		}
	}
}

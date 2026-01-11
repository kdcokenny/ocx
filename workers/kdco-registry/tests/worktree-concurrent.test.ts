/**
 * Integration tests for concurrent operations in the worktree plugin.
 *
 * These tests verify that race condition fixes work correctly:
 * - SQLite concurrent writes with WAL mode
 * - Mutex serialization of async operations
 * - Read-modify-write atomicity for pending operations
 * - Cross-handle database access
 */

import type { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
	addSession,
	clearPendingSpawn,
	getAllSessions,
	getPendingSpawn,
	initStateDb,
	setPendingSpawn,
} from "../files/plugin/worktree/state"
import { Mutex } from "../files/plugin/worktree/terminal"

// =============================================================================
// TEST SETUP
// =============================================================================

let testProjectRoot: string
let db: Database

beforeEach(async () => {
	// Create unique temp directory for test isolation
	testProjectRoot = path.join(os.tmpdir(), `worktree-test-${Bun.randomUUIDv7()}`)
	fs.mkdirSync(testProjectRoot, { recursive: true })
	db = await initStateDb(testProjectRoot)
})

afterEach(() => {
	// Cleanup database and temp directory
	try {
		db.close()
	} catch {
		// Already closed
	}

	try {
		fs.rmSync(testProjectRoot, { recursive: true, force: true })
	} catch {
		// Cleanup is best effort
	}
})

// =============================================================================
// SQLITE CONCURRENT WRITES
// =============================================================================

describe("SQLite Concurrent Writes", () => {
	it("handles concurrent session additions without data loss", async () => {
		// Create 10 concurrent addSession calls
		const promises = Array.from({ length: 10 }, (_, i) =>
			Promise.resolve().then(() =>
				addSession(db, {
					id: `session-${i}`,
					branch: `branch-${i}`,
					path: `/path/${i}`,
					createdAt: new Date().toISOString(),
				}),
			),
		)
		await Promise.all(promises)

		const sessions = getAllSessions(db)
		expect(sessions.length).toBe(10)

		// Verify all sessions were written correctly
		for (let i = 0; i < 10; i++) {
			const session = sessions.find((s) => s.id === `session-${i}`)
			expect(session).toBeDefined()
			expect(session?.branch).toBe(`branch-${i}`)
			expect(session?.path).toBe(`/path/${i}`)
		}
	})

	it("handles rapid sequential writes without corruption", async () => {
		// Simulate rapid writes that would have caused issues with JSON files
		for (let i = 0; i < 50; i++) {
			addSession(db, {
				id: `rapid-${i}`,
				branch: `rapid-branch-${i}`,
				path: `/rapid/${i}`,
				createdAt: new Date().toISOString(),
			})
		}

		const sessions = getAllSessions(db)
		expect(sessions.length).toBe(50)
	})

	it("handles interleaved reads and writes", async () => {
		const operations: Promise<void>[] = []

		// Interleave writes and reads
		for (let i = 0; i < 20; i++) {
			operations.push(
				Promise.resolve().then(() => {
					addSession(db, {
						id: `interleaved-${i}`,
						branch: `interleaved-branch-${i}`,
						path: `/interleaved/${i}`,
						createdAt: new Date().toISOString(),
					})
				}),
			)
			operations.push(
				Promise.resolve().then(() => {
					getAllSessions(db)
				}),
			)
		}

		await Promise.all(operations)

		const sessions = getAllSessions(db)
		expect(sessions.length).toBe(20)
	})
})

// =============================================================================
// MUTEX SERIALIZATION
// =============================================================================

describe("Mutex Serialization", () => {
	it("mutex serializes concurrent operations", async () => {
		const mutex = new Mutex()
		const order: number[] = []

		// Launch 5 concurrent operations
		const promises = Array.from({ length: 5 }, (_, i) =>
			mutex.runExclusive(async () => {
				await Bun.sleep(10) // Simulate async work
				order.push(i)
			}),
		)

		await Promise.all(promises)

		// All operations completed
		expect(order.length).toBe(5)
		// Order should be sequential (0,1,2,3,4) due to mutex
		expect(order).toEqual([0, 1, 2, 3, 4])
	})

	it("mutex prevents concurrent access to shared resource", async () => {
		const mutex = new Mutex()
		let activeCount = 0
		let maxActiveCount = 0

		const promises = Array.from({ length: 10 }, () =>
			mutex.runExclusive(async () => {
				activeCount++
				maxActiveCount = Math.max(maxActiveCount, activeCount)
				await Bun.sleep(5) // Simulate work
				activeCount--
			}),
		)

		await Promise.all(promises)

		// Only one operation should have been active at a time
		expect(maxActiveCount).toBe(1)
		expect(activeCount).toBe(0)
	})

	it("mutex handles errors without deadlocking", async () => {
		const mutex = new Mutex()
		const results: string[] = []

		const promises = [
			mutex
				.runExclusive(async () => {
					results.push("first-start")
					throw new Error("intentional error")
				})
				.catch(() => results.push("first-error")),

			mutex.runExclusive(async () => {
				results.push("second-completed")
			}),

			mutex.runExclusive(async () => {
				results.push("third-completed")
			}),
		]

		await Promise.all(promises)

		// Despite error, subsequent operations should complete
		expect(results).toContain("first-start")
		expect(results).toContain("first-error")
		expect(results).toContain("second-completed")
		expect(results).toContain("third-completed")
	})

	it("mutex maintains order under high contention", async () => {
		const mutex = new Mutex()
		const order: number[] = []

		// High contention: 20 concurrent operations
		const promises = Array.from({ length: 20 }, (_, i) =>
			mutex.runExclusive(async () => {
				order.push(i)
			}),
		)

		await Promise.all(promises)

		// All should complete in submission order
		expect(order).toEqual(Array.from({ length: 20 }, (_, i) => i))
	})
})

// =============================================================================
// READ-MODIFY-WRITE ATOMICITY
// =============================================================================

describe("Read-Modify-Write Atomicity", () => {
	it("prevents read-modify-write races on pending operations", async () => {
		// Simulate the old race condition pattern
		// Multiple "writers" that would have caused data loss with JSON

		const promises = Array.from({ length: 5 }, (_, i) =>
			Promise.resolve().then(() => {
				setPendingSpawn(db, {
					branch: `branch-${i}`,
					path: `/path/${i}`,
					sessionId: `session-${i}`,
				})
			}),
		)

		await Promise.all(promises)

		// Only one pending spawn should exist (last writer wins, but no corruption)
		const pending = getPendingSpawn(db)
		expect(pending).not.toBeNull()
		expect(pending?.branch).toMatch(/^branch-\d$/)
	})

	it("clear operation is atomic with set operation", async () => {
		// Set then immediately clear in rapid succession
		const operations: Promise<void>[] = []

		for (let i = 0; i < 10; i++) {
			operations.push(
				Promise.resolve().then(() => {
					setPendingSpawn(db, {
						branch: `branch-${i}`,
						path: `/path/${i}`,
						sessionId: `session-${i}`,
					})
				}),
			)
			operations.push(
				Promise.resolve().then(() => {
					clearPendingSpawn(db)
				}),
			)
		}

		await Promise.all(operations)

		// Final state should be consistent (either set or cleared)
		const pending = getPendingSpawn(db)
		// We accept either null or a valid pending spawn
		if (pending !== null) {
			expect(pending.branch).toMatch(/^branch-\d$/)
			expect(pending.path).toMatch(/^\/path\/\d$/)
			expect(pending.sessionId).toMatch(/^session-\d$/)
		}
	})

	it("concurrent set operations don't corrupt data", async () => {
		// Rapidly set different values
		const promises = Array.from({ length: 100 }, (_, i) =>
			Promise.resolve().then(() => {
				setPendingSpawn(db, {
					branch: `branch-${i}`,
					path: `/path/${i}`,
					sessionId: `session-${i}`,
				})
			}),
		)

		await Promise.all(promises)

		const pending = getPendingSpawn(db)
		expect(pending).not.toBeNull()

		// Data should be internally consistent (from same iteration)
		if (pending) {
			const match = pending.branch.match(/^branch-(\d+)$/)
			expect(match).not.toBeNull()
			const idx = match?.[1]
			expect(pending.path).toBe(`/path/${idx}`)
			expect(pending.sessionId).toBe(`session-${idx}`)
		}
	})
})

// =============================================================================
// CROSS-HANDLE DATABASE ACCESS
// =============================================================================

describe("Cross-Handle Database Access", () => {
	it("handles multiple database handles to same file", async () => {
		// Simulate cross-process access via multiple handles
		const db1 = await initStateDb(testProjectRoot)
		const db2 = await initStateDb(testProjectRoot)

		addSession(db1, { id: "s1", branch: "b1", path: "/p1", createdAt: new Date().toISOString() })
		addSession(db2, { id: "s2", branch: "b2", path: "/p2", createdAt: new Date().toISOString() })

		// Both sessions should be visible from either handle
		expect(getAllSessions(db1).length).toBe(2)
		expect(getAllSessions(db2).length).toBe(2)

		// Cleanup
		db1.close()
		db2.close()
	})

	it("handles concurrent writes from multiple handles", async () => {
		const db1 = await initStateDb(testProjectRoot)
		const db2 = await initStateDb(testProjectRoot)

		const promises = [
			...Array.from({ length: 5 }, (_, i) =>
				Promise.resolve().then(() =>
					addSession(db1, {
						id: `db1-session-${i}`,
						branch: `db1-branch-${i}`,
						path: `/db1/${i}`,
						createdAt: new Date().toISOString(),
					}),
				),
			),
			...Array.from({ length: 5 }, (_, i) =>
				Promise.resolve().then(() =>
					addSession(db2, {
						id: `db2-session-${i}`,
						branch: `db2-branch-${i}`,
						path: `/db2/${i}`,
						createdAt: new Date().toISOString(),
					}),
				),
			),
		]

		await Promise.all(promises)

		// All 10 sessions should be visible from either handle
		const sessionsFrom1 = getAllSessions(db1)
		const sessionsFrom2 = getAllSessions(db2)

		expect(sessionsFrom1.length).toBe(10)
		expect(sessionsFrom2.length).toBe(10)

		// Verify both sets of sessions exist
		expect(sessionsFrom1.filter((s) => s.id.startsWith("db1-")).length).toBe(5)
		expect(sessionsFrom1.filter((s) => s.id.startsWith("db2-")).length).toBe(5)

		// Cleanup
		db1.close()
		db2.close()
	})

	it("pending operations are visible across handles", async () => {
		const db1 = await initStateDb(testProjectRoot)
		const db2 = await initStateDb(testProjectRoot)

		setPendingSpawn(db1, {
			branch: "cross-handle-branch",
			path: "/cross-handle",
			sessionId: "cross-handle-session",
		})

		// Should be visible from the other handle
		const pending = getPendingSpawn(db2)
		expect(pending).not.toBeNull()
		expect(pending?.branch).toBe("cross-handle-branch")

		// Clear from db2
		clearPendingSpawn(db2)

		// Should be cleared from db1's perspective too
		expect(getPendingSpawn(db1)).toBeNull()

		// Cleanup
		db1.close()
		db2.close()
	})

	it("handles handle closure gracefully", async () => {
		const db1 = await initStateDb(testProjectRoot)

		addSession(db1, {
			id: "before-close",
			branch: "before-close-branch",
			path: "/before-close",
			createdAt: new Date().toISOString(),
		})

		db1.close()

		// Open a new handle and verify data persisted
		const db2 = await initStateDb(testProjectRoot)
		const sessions = getAllSessions(db2)

		expect(sessions.length).toBe(1)
		expect(sessions[0].id).toBe("before-close")

		db2.close()
	})
})

// =============================================================================
// STRESS TESTS
// =============================================================================

describe("Stress Tests", () => {
	it("handles high-volume concurrent operations", async () => {
		const operationCount = 100
		const promises: Promise<unknown>[] = []

		// Mix of all operation types
		for (let i = 0; i < operationCount; i++) {
			const opType = i % 4

			switch (opType) {
				case 0:
					promises.push(
						Promise.resolve().then(() =>
							addSession(db, {
								id: `stress-${i}`,
								branch: `stress-branch-${i}`,
								path: `/stress/${i}`,
								createdAt: new Date().toISOString(),
							}),
						),
					)
					break
				case 1:
					promises.push(Promise.resolve().then(() => getAllSessions(db)))
					break
				case 2:
					promises.push(
						Promise.resolve().then(() =>
							setPendingSpawn(db, {
								branch: `stress-pending-${i}`,
								path: `/stress-pending/${i}`,
								sessionId: `stress-session-${i}`,
							}),
						),
					)
					break
				case 3:
					promises.push(Promise.resolve().then(() => getPendingSpawn(db)))
					break
			}
		}

		// Should complete without errors or deadlocks
		await Promise.all(promises)

		// Verify state is consistent
		const sessions = getAllSessions(db)
		expect(sessions.length).toBe(25) // operationCount / 4 for type 0
	})

	it("mutex handles long-running operations", async () => {
		const mutex = new Mutex()
		const completionOrder: number[] = []

		const promises = [
			mutex.runExclusive(async () => {
				await Bun.sleep(50) // Long operation
				completionOrder.push(1)
			}),
			mutex.runExclusive(async () => {
				await Bun.sleep(10)
				completionOrder.push(2)
			}),
			mutex.runExclusive(async () => {
				await Bun.sleep(5)
				completionOrder.push(3)
			}),
		]

		await Promise.all(promises)

		// Should complete in submission order, not duration order
		expect(completionOrder).toEqual([1, 2, 3])
	})
})

/**
 * Tests for the SQLite State Module (worktree-state.ts)
 * Tests database initialization, session CRUD, pending operations, and concurrent access.
 */

import type { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
	addSession,
	clearPendingDelete,
	clearPendingSpawn,
	getAllSessions,
	getPendingDelete,
	getPendingSpawn,
	getProjectId,
	getSession,
	getWorktreePath,
	initStateDb,
	removeSession,
	setPendingDelete,
	setPendingSpawn,
} from "../files/plugin/worktree/state"

/** Use temp directory for test databases to avoid polluting user's system */
let testDir: string

beforeEach(() => {
	testDir = path.join(os.tmpdir(), `worktree-state-test-${Date.now()}-${Math.random()}`)
	fs.mkdirSync(testDir, { recursive: true })
})

afterEach(() => {
	// Clean up test directory
	try {
		fs.rmSync(testDir, { recursive: true, force: true })
	} catch {
		// Ignore cleanup errors
	}
})

describe("worktree-state", () => {
	describe("Database Initialization", () => {
		it("should create database file in correct location", async () => {
			const projectRoot = path.join(testDir, "my-project")
			fs.mkdirSync(projectRoot, { recursive: true })

			const db = await initStateDb(projectRoot)
			db.close()

			// Check that a SQLite file was created in the worktree plugin directory
			const dbDir = path.join(os.homedir(), ".local", "share", "opencode", "plugins", "worktree")
			const files = fs.existsSync(dbDir) ? fs.readdirSync(dbDir) : []
			expect(files.some((f: string) => f.endsWith(".sqlite"))).toBe(true)
		})

		it("should enable WAL mode", async () => {
			const projectRoot = path.join(testDir, "wal-test")
			fs.mkdirSync(projectRoot, { recursive: true })

			const db = await initStateDb(projectRoot)
			const result = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }
			db.close()

			expect(result.journal_mode).toBe("wal")
		})

		it("should create tables on first init", async () => {
			const projectRoot = path.join(testDir, "tables-test")
			fs.mkdirSync(projectRoot, { recursive: true })

			const db = await initStateDb(projectRoot)

			// Check sessions table exists
			const sessionsTable = db
				.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
				.get()
			expect(sessionsTable).toBeTruthy()

			// Check pending_operations table exists
			const pendingTable = db
				.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_operations'")
				.get()
			expect(pendingTable).toBeTruthy()

			db.close()
		})

		it("should return same database schema on multiple calls with same projectRoot", async () => {
			const projectRoot = path.join(testDir, "multi-init")
			fs.mkdirSync(projectRoot, { recursive: true })

			// First init
			const db1 = await initStateDb(projectRoot)
			addSession(db1, {
				id: "session-1",
				branch: "feature-test",
				path: "/tmp/worktree",
				createdAt: new Date().toISOString(),
			})
			db1.close()

			// Second init should see the same data
			const db2 = await initStateDb(projectRoot)
			const session = getSession(db2, "session-1")
			db2.close()

			expect(session).not.toBeNull()
			expect(session?.branch).toBe("feature-test")
		})

		it("should throw for invalid project root", async () => {
			await expect(initStateDb("")).rejects.toThrow("valid project root path")
			await expect(initStateDb(null as unknown as string)).rejects.toThrow(
				"valid project root path",
			)
		})
	})

	describe("Project ID and Worktree Paths", () => {
		it("should getProjectId return consistent ID for same project", async () => {
			const projectRoot = path.join(testDir, "id-test")
			fs.mkdirSync(projectRoot, { recursive: true })

			// Call twice, should get the same result
			const id1 = await getProjectId(projectRoot)
			const id2 = await getProjectId(projectRoot)

			expect(id1).toBe(id2)
			// Should be a 16-char hex hash for non-git repos (path-based fallback)
			expect(id1).toMatch(/^[a-f0-9]{16}$/)
		})

		it("should getProjectId throw for empty project root", async () => {
			await expect(getProjectId("")).rejects.toThrow("projectRoot is required")
		})

		it("should getWorktreePath return correct path structure", async () => {
			const projectRoot = path.join(testDir, "worktree-path-test")
			fs.mkdirSync(projectRoot, { recursive: true })

			const worktreePath = await getWorktreePath(projectRoot, "feature-branch")

			// Should include ~/.local/share/opencode/worktree/{project-id}/{branch}
			expect(worktreePath).toContain(os.homedir())
			expect(worktreePath).toContain(".local")
			expect(worktreePath).toContain("share")
			expect(worktreePath).toContain("opencode")
			expect(worktreePath).toContain("worktree")
			expect(worktreePath).toContain("feature-branch")
		})

		it("should getWorktreePath use consistent project ID", async () => {
			const projectRoot = path.join(testDir, "worktree-consistent-test")
			fs.mkdirSync(projectRoot, { recursive: true })

			const projectId = await getProjectId(projectRoot)
			const worktreePath = await getWorktreePath(projectRoot, "test-branch")

			// Path should contain the project ID
			expect(worktreePath).toContain(projectId)
		})
	})

	describe("Session CRUD", () => {
		let db: Database
		const projectRoot = () => path.join(testDir, "crud-project")

		beforeEach(async () => {
			fs.mkdirSync(projectRoot(), { recursive: true })
			db = await initStateDb(projectRoot())
		})

		afterEach(() => {
			db.close()
		})

		it("should addSession and create a new session", () => {
			const session = {
				id: "test-session-123",
				branch: "feature/new-feature",
				path: "/path/to/worktree",
				createdAt: "2026-01-07T12:00:00.000Z",
			}

			addSession(db, session)

			const retrieved = getSession(db, "test-session-123")
			expect(retrieved).toEqual(session)
		})

		it("should getSession retrieve existing session by ID", () => {
			addSession(db, {
				id: "lookup-session",
				branch: "main",
				path: "/main/path",
				createdAt: "2026-01-07T10:00:00.000Z",
			})

			const session = getSession(db, "lookup-session")

			expect(session).not.toBeNull()
			expect(session?.id).toBe("lookup-session")
			expect(session?.branch).toBe("main")
			expect(session?.path).toBe("/main/path")
		})

		it("should getSession return null for non-existent session", () => {
			const session = getSession(db, "non-existent-id")
			expect(session).toBeNull()
		})

		it("should getSession return null for empty session ID", () => {
			const session = getSession(db, "")
			expect(session).toBeNull()
		})

		it("should removeSession remove session by branch", () => {
			addSession(db, {
				id: "remove-me",
				branch: "delete-this-branch",
				path: "/some/path",
				createdAt: "2026-01-07T09:00:00.000Z",
			})

			// Verify it exists
			expect(getSession(db, "remove-me")).not.toBeNull()

			// Remove by branch
			removeSession(db, "delete-this-branch")

			// Verify it's gone
			expect(getSession(db, "remove-me")).toBeNull()
		})

		it("should removeSession be idempotent (no error if session doesn't exist)", () => {
			// Should not throw even if branch doesn't exist
			expect(() => removeSession(db, "non-existent-branch")).not.toThrow()
		})

		it("should removeSession handle empty branch", () => {
			// Should not throw for empty branch
			expect(() => removeSession(db, "")).not.toThrow()
		})

		it("should getAllSessions return all sessions", () => {
			addSession(db, {
				id: "session-1",
				branch: "branch-1",
				path: "/path/1",
				createdAt: "2026-01-07T08:00:00.000Z",
			})
			addSession(db, {
				id: "session-2",
				branch: "branch-2",
				path: "/path/2",
				createdAt: "2026-01-07T09:00:00.000Z",
			})
			addSession(db, {
				id: "session-3",
				branch: "branch-3",
				path: "/path/3",
				createdAt: "2026-01-07T10:00:00.000Z",
			})

			const sessions = getAllSessions(db)

			expect(sessions).toHaveLength(3)
			expect(sessions.map((s) => s.id)).toContain("session-1")
			expect(sessions.map((s) => s.id)).toContain("session-2")
			expect(sessions.map((s) => s.id)).toContain("session-3")
		})

		it("should getAllSessions return sessions ordered by created_at ASC", () => {
			addSession(db, {
				id: "later",
				branch: "later-branch",
				path: "/path/later",
				createdAt: "2026-01-07T12:00:00.000Z",
			})
			addSession(db, {
				id: "earlier",
				branch: "earlier-branch",
				path: "/path/earlier",
				createdAt: "2026-01-07T08:00:00.000Z",
			})
			addSession(db, {
				id: "middle",
				branch: "middle-branch",
				path: "/path/middle",
				createdAt: "2026-01-07T10:00:00.000Z",
			})

			const sessions = getAllSessions(db)

			expect(sessions[0].id).toBe("earlier")
			expect(sessions[1].id).toBe("middle")
			expect(sessions[2].id).toBe("later")
		})

		it("should getAllSessions return empty array when no sessions", () => {
			const sessions = getAllSessions(db)
			expect(sessions).toEqual([])
		})

		it("should addSession replace session with same ID (upsert)", () => {
			addSession(db, {
				id: "upsert-test",
				branch: "original-branch",
				path: "/original/path",
				createdAt: "2026-01-07T08:00:00.000Z",
			})

			// Add same ID with different data
			addSession(db, {
				id: "upsert-test",
				branch: "updated-branch",
				path: "/updated/path",
				createdAt: "2026-01-07T10:00:00.000Z",
			})

			const session = getSession(db, "upsert-test")
			expect(session?.branch).toBe("updated-branch")
			expect(session?.path).toBe("/updated/path")

			// Should only have one session
			const all = getAllSessions(db)
			expect(all).toHaveLength(1)
		})

		it("should addSession throw for invalid session data", () => {
			expect(() =>
				addSession(db, {
					id: "",
					branch: "branch",
					path: "/path",
					createdAt: "2026-01-07T00:00:00.000Z",
				}),
			).toThrow()

			expect(() =>
				addSession(db, {
					id: "valid-id",
					branch: "",
					path: "/path",
					createdAt: "2026-01-07T00:00:00.000Z",
				}),
			).toThrow()
		})
	})

	describe("Pending Spawn Operations", () => {
		let db: Database
		const projectRoot = () => path.join(testDir, "spawn-project")

		beforeEach(async () => {
			fs.mkdirSync(projectRoot(), { recursive: true })
			db = await initStateDb(projectRoot())
		})

		afterEach(() => {
			db.close()
		})

		it("should setPendingSpawn store pending spawn", () => {
			setPendingSpawn(db, {
				branch: "feature/spawn-test",
				path: "/worktree/path",
				sessionId: "spawn-session-123",
			})

			const pending = getPendingSpawn(db)
			expect(pending).not.toBeNull()
			expect(pending?.branch).toBe("feature/spawn-test")
			expect(pending?.path).toBe("/worktree/path")
			expect(pending?.sessionId).toBe("spawn-session-123")
		})

		it("should getPendingSpawn retrieve stored spawn", () => {
			setPendingSpawn(db, {
				branch: "test-branch",
				path: "/test/path",
				sessionId: "session-abc",
			})

			const spawn = getPendingSpawn(db)

			expect(spawn).toEqual({
				branch: "test-branch",
				path: "/test/path",
				sessionId: "session-abc",
			})
		})

		it("should getPendingSpawn return null when no pending spawn", () => {
			const spawn = getPendingSpawn(db)
			expect(spawn).toBeNull()
		})

		it("should clearPendingSpawn remove pending spawn", () => {
			setPendingSpawn(db, {
				branch: "clear-me",
				path: "/clear/path",
				sessionId: "clear-session",
			})

			// Verify it exists
			expect(getPendingSpawn(db)).not.toBeNull()

			// Clear it
			clearPendingSpawn(db)

			// Verify it's gone
			expect(getPendingSpawn(db)).toBeNull()
		})

		it("should clearPendingSpawn be idempotent", () => {
			// Should not throw even if nothing to clear
			expect(() => clearPendingSpawn(db)).not.toThrow()
		})

		it("should setPendingSpawn replace existing spawn (singleton behavior)", () => {
			setPendingSpawn(db, {
				branch: "first-spawn",
				path: "/first/path",
				sessionId: "first-session",
			})

			setPendingSpawn(db, {
				branch: "second-spawn",
				path: "/second/path",
				sessionId: "second-session",
			})

			const spawn = getPendingSpawn(db)
			expect(spawn?.branch).toBe("second-spawn")
			expect(spawn?.path).toBe("/second/path")
			expect(spawn?.sessionId).toBe("second-session")
		})

		it("should setPendingSpawn throw for invalid spawn data", () => {
			expect(() =>
				setPendingSpawn(db, {
					branch: "",
					path: "/path",
					sessionId: "session",
				}),
			).toThrow()

			expect(() =>
				setPendingSpawn(db, {
					branch: "branch",
					path: "",
					sessionId: "session",
				}),
			).toThrow()

			expect(() =>
				setPendingSpawn(db, {
					branch: "branch",
					path: "/path",
					sessionId: "",
				}),
			).toThrow()
		})
	})

	describe("Pending Delete Operations", () => {
		let db: Database
		const projectRoot = () => path.join(testDir, "delete-project")

		beforeEach(async () => {
			fs.mkdirSync(projectRoot(), { recursive: true })
			db = await initStateDb(projectRoot())
		})

		afterEach(() => {
			db.close()
		})

		it("should setPendingDelete store pending delete", () => {
			setPendingDelete(db, {
				branch: "feature/delete-test",
				path: "/worktree/to/delete",
			})

			const pending = getPendingDelete(db)
			expect(pending).not.toBeNull()
			expect(pending?.branch).toBe("feature/delete-test")
			expect(pending?.path).toBe("/worktree/to/delete")
		})

		it("should getPendingDelete retrieve stored delete", () => {
			setPendingDelete(db, {
				branch: "delete-branch",
				path: "/delete/path",
			})

			const del = getPendingDelete(db)

			expect(del).toEqual({
				branch: "delete-branch",
				path: "/delete/path",
			})
		})

		it("should getPendingDelete return null when no pending delete", () => {
			const del = getPendingDelete(db)
			expect(del).toBeNull()
		})

		it("should clearPendingDelete remove pending delete", () => {
			setPendingDelete(db, {
				branch: "clear-delete",
				path: "/clear/delete/path",
			})

			// Verify it exists
			expect(getPendingDelete(db)).not.toBeNull()

			// Clear it
			clearPendingDelete(db)

			// Verify it's gone
			expect(getPendingDelete(db)).toBeNull()
		})

		it("should clearPendingDelete be idempotent", () => {
			// Should not throw even if nothing to clear
			expect(() => clearPendingDelete(db)).not.toThrow()
		})

		it("should setPendingDelete replace existing delete (singleton behavior)", () => {
			setPendingDelete(db, {
				branch: "first-delete",
				path: "/first/delete/path",
			})

			setPendingDelete(db, {
				branch: "second-delete",
				path: "/second/delete/path",
			})

			const del = getPendingDelete(db)
			expect(del?.branch).toBe("second-delete")
			expect(del?.path).toBe("/second/delete/path")
		})

		it("should setPendingDelete throw for invalid delete data", () => {
			expect(() =>
				setPendingDelete(db, {
					branch: "",
					path: "/path",
				}),
			).toThrow()

			expect(() =>
				setPendingDelete(db, {
					branch: "branch",
					path: "",
				}),
			).toThrow()
		})
	})

	describe("Spawn and Delete Interaction", () => {
		let db: Database
		const projectRoot = () => path.join(testDir, "interaction-project")

		beforeEach(async () => {
			fs.mkdirSync(projectRoot(), { recursive: true })
			db = await initStateDb(projectRoot())
		})

		afterEach(() => {
			db.close()
		})

		it("should setPendingDelete replace pending spawn (same row, singleton)", () => {
			setPendingSpawn(db, {
				branch: "spawn-branch",
				path: "/spawn/path",
				sessionId: "spawn-session",
			})

			// Delete replaces spawn because they share the same row (id=1)
			setPendingDelete(db, {
				branch: "delete-branch",
				path: "/delete/path",
			})

			// Spawn should be gone (replaced)
			expect(getPendingSpawn(db)).toBeNull()
			// Delete should exist
			expect(getPendingDelete(db)).not.toBeNull()
		})

		it("should setPendingSpawn replace pending delete (same row, singleton)", () => {
			setPendingDelete(db, {
				branch: "delete-branch",
				path: "/delete/path",
			})

			// Spawn replaces delete because they share the same row (id=1)
			setPendingSpawn(db, {
				branch: "spawn-branch",
				path: "/spawn/path",
				sessionId: "spawn-session",
			})

			// Delete should be gone (replaced)
			expect(getPendingDelete(db)).toBeNull()
			// Spawn should exist
			expect(getPendingSpawn(db)).not.toBeNull()
		})

		it("should clearPendingSpawn not affect pending delete", () => {
			setPendingDelete(db, {
				branch: "keep-delete",
				path: "/keep/delete/path",
			})

			clearPendingSpawn(db)

			// Delete should still exist
			expect(getPendingDelete(db)).not.toBeNull()
		})

		it("should clearPendingDelete not affect pending spawn", () => {
			setPendingSpawn(db, {
				branch: "keep-spawn",
				path: "/keep/spawn/path",
				sessionId: "keep-session",
			})

			clearPendingDelete(db)

			// Spawn should still exist
			expect(getPendingSpawn(db)).not.toBeNull()
		})
	})

	describe("Pending Operation Warnings", () => {
		let db: Database
		let warnSpy: ReturnType<typeof spyOn>
		const projectRoot = () => path.join(testDir, "warning-project")

		beforeEach(async () => {
			fs.mkdirSync(projectRoot(), { recursive: true })
			db = await initStateDb(projectRoot())
			warnSpy = spyOn(console, "warn")
		})

		afterEach(() => {
			db.close()
			warnSpy.mockRestore()
		})

		it("logs warning when replacing pending spawn with another spawn", () => {
			setPendingSpawn(db, { branch: "first", path: "/first", sessionId: "s1" })
			setPendingSpawn(db, { branch: "second", path: "/second", sessionId: "s2" })

			expect(warnSpy).toHaveBeenCalled()
			const calls = warnSpy.mock.calls
			const warningMessage = calls.find(
				(call: unknown[]) =>
					typeof call[0] === "string" && call[0].includes("Replacing pending spawn"),
			)
			expect(warningMessage).toBeTruthy()
		})

		it("logs warning when spawn replaces delete", () => {
			setPendingDelete(db, { branch: "to-delete", path: "/delete" })
			setPendingSpawn(db, { branch: "to-spawn", path: "/spawn", sessionId: "s1" })

			expect(warnSpy).toHaveBeenCalled()
			const calls = warnSpy.mock.calls
			const warningMessage = calls.find(
				(call: unknown[]) =>
					typeof call[0] === "string" && call[0].includes("replacing pending delete"),
			)
			expect(warningMessage).toBeTruthy()
		})

		it("logs warning when delete replaces spawn", () => {
			setPendingSpawn(db, { branch: "to-spawn", path: "/spawn", sessionId: "s1" })
			setPendingDelete(db, { branch: "to-delete", path: "/delete" })

			expect(warnSpy).toHaveBeenCalled()
			const calls = warnSpy.mock.calls
			const warningMessage = calls.find(
				(call: unknown[]) =>
					typeof call[0] === "string" && call[0].includes("replacing pending spawn"),
			)
			expect(warningMessage).toBeTruthy()
		})

		it("logs warning when replacing pending delete with another delete", () => {
			setPendingDelete(db, { branch: "first-delete", path: "/first" })
			setPendingDelete(db, { branch: "second-delete", path: "/second" })

			expect(warnSpy).toHaveBeenCalled()
			const calls = warnSpy.mock.calls
			const warningMessage = calls.find(
				(call: unknown[]) =>
					typeof call[0] === "string" && call[0].includes("Replacing pending delete"),
			)
			expect(warningMessage).toBeTruthy()
		})

		it("does not log warning on first pending spawn", () => {
			setPendingSpawn(db, { branch: "first", path: "/first", sessionId: "s1" })

			const calls = warnSpy.mock.calls
			const warningMessage = calls.find(
				(call: unknown[]) =>
					typeof call[0] === "string" &&
					(call[0].includes("Replacing pending") || call[0].includes("replacing pending")),
			)
			expect(warningMessage).toBeUndefined()
		})

		it("does not log warning on first pending delete", () => {
			setPendingDelete(db, { branch: "first", path: "/first" })

			const calls = warnSpy.mock.calls
			const warningMessage = calls.find(
				(call: unknown[]) =>
					typeof call[0] === "string" &&
					(call[0].includes("Replacing pending") || call[0].includes("replacing pending")),
			)
			expect(warningMessage).toBeUndefined()
		})

		it("includes branch names in warning message for spawn replacement", () => {
			setPendingSpawn(db, { branch: "old-branch", path: "/old", sessionId: "s1" })
			setPendingSpawn(db, { branch: "new-branch", path: "/new", sessionId: "s2" })

			const calls = warnSpy.mock.calls
			const warningMessage = calls.find(
				(call: unknown[]) =>
					typeof call[0] === "string" &&
					call[0].includes("old-branch") &&
					call[0].includes("new-branch"),
			)
			expect(warningMessage).toBeTruthy()
		})

		it("includes branch names in warning message for delete replacement", () => {
			setPendingDelete(db, { branch: "old-delete", path: "/old" })
			setPendingDelete(db, { branch: "new-delete", path: "/new" })

			const calls = warnSpy.mock.calls
			const warningMessage = calls.find(
				(call: unknown[]) =>
					typeof call[0] === "string" &&
					call[0].includes("old-delete") &&
					call[0].includes("new-delete"),
			)
			expect(warningMessage).toBeTruthy()
		})
	})

	describe("Concurrent Access (race condition prevention)", () => {
		const projectRoot = () => path.join(testDir, "concurrent-project")

		beforeEach(() => {
			fs.mkdirSync(projectRoot(), { recursive: true })
		})

		it("should multiple addSession calls not lose data", async () => {
			const db = await initStateDb(projectRoot())

			// Add multiple sessions rapidly
			const sessions = Array.from({ length: 10 }, (_, i) => ({
				id: `concurrent-session-${i}`,
				branch: `branch-${i}`,
				path: `/path/${i}`,
				createdAt: new Date(Date.now() + i).toISOString(),
			}))

			for (const session of sessions) {
				addSession(db, session)
			}

			const all = getAllSessions(db)
			expect(all).toHaveLength(10)

			// Verify all sessions exist
			for (const session of sessions) {
				const found = getSession(db, session.id)
				expect(found).not.toBeNull()
				expect(found?.id).toBe(session.id)
			}

			db.close()
		})

		it("should setPendingSpawn be atomic (last write wins, no corruption)", async () => {
			const db = await initStateDb(projectRoot())

			// Rapidly set multiple pending spawns
			for (let i = 0; i < 10; i++) {
				setPendingSpawn(db, {
					branch: `rapid-spawn-${i}`,
					path: `/rapid/path/${i}`,
					sessionId: `rapid-session-${i}`,
				})
			}

			// Should have exactly one pending spawn (the last one)
			const spawn = getPendingSpawn(db)
			expect(spawn).not.toBeNull()
			expect(spawn?.branch).toBe("rapid-spawn-9")
			expect(spawn?.path).toBe("/rapid/path/9")
			expect(spawn?.sessionId).toBe("rapid-session-9")

			db.close()
		})

		it("should operations work across multiple database handles", async () => {
			// First handle creates data
			const db1 = await initStateDb(projectRoot())
			addSession(db1, {
				id: "cross-handle-session",
				branch: "cross-handle-branch",
				path: "/cross/handle/path",
				createdAt: "2026-01-07T12:00:00.000Z",
			})
			setPendingSpawn(db1, {
				branch: "cross-spawn",
				path: "/cross/spawn/path",
				sessionId: "cross-spawn-session",
			})
			db1.close()

			// Second handle reads data
			const db2 = await initStateDb(projectRoot())
			const session = getSession(db2, "cross-handle-session")
			const spawn = getPendingSpawn(db2)

			expect(session).not.toBeNull()
			expect(session?.branch).toBe("cross-handle-branch")

			expect(spawn).not.toBeNull()
			expect(spawn?.branch).toBe("cross-spawn")

			// Second handle modifies data
			removeSession(db2, "cross-handle-branch")
			clearPendingSpawn(db2)
			db2.close()

			// Third handle verifies modifications
			const db3 = await initStateDb(projectRoot())
			expect(getSession(db3, "cross-handle-session")).toBeNull()
			expect(getPendingSpawn(db3)).toBeNull()
			db3.close()
		})

		it("should handle busy_timeout for concurrent access", async () => {
			// Open two handles simultaneously
			const db1 = await initStateDb(projectRoot())
			const db2 = await initStateDb(projectRoot())

			// Both should be able to operate without errors
			addSession(db1, {
				id: "busy-session-1",
				branch: "busy-branch-1",
				path: "/busy/1",
				createdAt: "2026-01-07T12:00:00.000Z",
			})

			addSession(db2, {
				id: "busy-session-2",
				branch: "busy-branch-2",
				path: "/busy/2",
				createdAt: "2026-01-07T12:01:00.000Z",
			})

			// Both sessions should exist
			const all = getAllSessions(db1)
			expect(all).toHaveLength(2)

			db1.close()
			db2.close()
		})
	})
})

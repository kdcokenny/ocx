/**
 * SQLite State Module for Worktree Plugin
 *
 * Provides atomic, crash-safe persistence for worktree sessions and pending operations.
 * Uses bun:sqlite for zero external dependencies.
 *
 * Database location: ~/.local/share/opencode/plugins/worktree/{project-id}.sqlite
 * Project ID is the first git root commit SHA (40-char hex), with SHA-256 path hash fallback (16-char).
 */

import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { z } from "zod"
import type { OpencodeClient } from "../kdco-primitives"
import { getProjectId, logWarn } from "../kdco-primitives"
import { parsePersistedLaunchMetadata, serializePersistedLaunchMetadata } from "./launch-context"

// =============================================================================
// TYPES
// =============================================================================

/** Represents an active worktree session */
export interface Session {
	id: string
	branch: string
	path: string
	createdAt: string
	launchMode: "plain" | "ocx"
	profile: string | null
	ocxBin: string | null
}

export type SessionInput = Omit<Session, "launchMode" | "profile" | "ocxBin"> & {
	launchMode?: "plain" | "ocx"
	profile?: string | null
	ocxBin?: string | null
}

/** Pending spawn operation to be processed on session.idle */
export interface PendingSpawn {
	branch: string
	path: string
	sessionId: string
}

/** Pending delete operation to be processed on session.idle */
export interface PendingDelete {
	branch: string
	path: string
}

// =============================================================================
// SCHEMAS (Boundary Validation)
// =============================================================================

const sessionSchema = z.object({
	id: z.string().min(1),
	branch: z.string().min(1),
	path: z.string().min(1),
	createdAt: z.string().min(1),
	launchMode: z.enum(["plain", "ocx"]).optional(),
	profile: z.string().nullable().optional(),
	ocxBin: z.string().nullable().optional(),
})

const pendingSpawnSchema = z.object({
	branch: z.string().min(1),
	path: z.string().min(1),
	sessionId: z.string().min(1),
})

const pendingDeleteSchema = z.object({
	branch: z.string().min(1),
	path: z.string().min(1),
})

// =============================================================================
// DATABASE UTILITIES
// =============================================================================

/**
 * Get the default base directory for worktree storage.
 * Location: ~/.local/share/opencode/worktree/
 */
function getWorktreeBaseDirectory(): string {
	return path.join(os.homedir(), ".local", "share", "opencode", "worktree")
}

/**
 * Get the worktree path for a given project and branch.
 *
 * @param projectRoot - Absolute path to the project root
 * @param branch - Branch name for the worktree
 * @param basePath - Optional custom base path (absolute). Defaults to ~/.local/share/opencode/worktree
 * @returns Absolute path to the worktree directory
 */
export async function getWorktreePath(
	projectRoot: string,
	branch: string,
	basePath?: string,
): Promise<string> {
	if (!branch || typeof branch !== "string") {
		throw new Error("branch is required")
	}
	const projectId = await getProjectId(projectRoot)
	return path.join(basePath ?? getWorktreeBaseDirectory(), projectId, branch)
}

/**
 * Get the database directory path.
 * Location: ~/.local/share/opencode/plugins/worktree/
 */
function getDbDirectory(): string {
	const home = os.homedir()
	return path.join(home, ".local", "share", "opencode", "plugins", "worktree")
}

/**
 * Get the full database file path for a project.
 * @param projectRoot - Absolute path to the project root
 */
async function getDbPath(projectRoot: string): Promise<string> {
	const projectId = await getProjectId(projectRoot)
	return path.join(getDbDirectory(), `${projectId}.sqlite`)
}

/**
 * Initialize the SQLite database for worktree state.
 * Creates the database file and schema if they don't exist.
 *
 * @param projectRoot - Absolute path to the project root
 * @returns Configured Database instance
 *
 * @example
 * ```ts
 * const db = await initStateDb("/home/user/my-project")
 * const sessions = getAllSessions(db)
 * db.close()
 * ```
 */
export async function initStateDb(projectRoot: string): Promise<Database> {
	// Guard: validate project root
	if (!projectRoot || typeof projectRoot !== "string") {
		throw new Error("initStateDb requires a valid project root path")
	}

	const dbPath = await getDbPath(projectRoot)
	const dbDir = path.dirname(dbPath)

	// Create directory synchronously (required before opening DB)
	mkdirSync(dbDir, { recursive: true })

	// Open database (creates if doesn't exist)
	const db = new Database(dbPath)

	// Configure SQLite for concurrent access
	db.exec("PRAGMA journal_mode=WAL")
	db.exec("PRAGMA busy_timeout=5000")

	// Create tables with schema
	db.exec(`
		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			branch TEXT NOT NULL,
			path TEXT NOT NULL,
			created_at TEXT NOT NULL,
			launch_mode TEXT,
			profile TEXT,
			ocx_bin TEXT
		)
	`)

	ensureSessionLaunchMetadataColumns(db)

	db.exec(`
		CREATE TABLE IF NOT EXISTS pending_operations (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			type TEXT NOT NULL,
			branch TEXT NOT NULL,
			path TEXT NOT NULL,
			session_id TEXT
		)
	`)

	return db
}

function ensureSessionLaunchMetadataColumns(db: Database): void {
	const tableInfo = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name?: string }>
	const sessionColumns = new Set(tableInfo.map((column) => column.name).filter(Boolean))

	if (!sessionColumns.has("launch_mode")) {
		addSessionColumn(db, "launch_mode", "ALTER TABLE sessions ADD COLUMN launch_mode TEXT")
	}

	if (!sessionColumns.has("profile")) {
		addSessionColumn(db, "profile", "ALTER TABLE sessions ADD COLUMN profile TEXT")
	}

	if (!sessionColumns.has("ocx_bin")) {
		addSessionColumn(db, "ocx_bin", "ALTER TABLE sessions ADD COLUMN ocx_bin TEXT")
	}
}

function addSessionColumn(db: Database, columnName: string, sql: string): void {
	try {
		db.exec(sql)
	} catch (error) {
		if (isDuplicateColumnError(error, columnName)) {
			return
		}

		throw error
	}
}

function isDuplicateColumnError(error: unknown, columnName: string): boolean {
	if (!(error instanceof Error)) {
		return false
	}

	const normalizedMessage = error.message.toLowerCase()
	return (
		normalizedMessage.includes("duplicate column name") &&
		normalizedMessage.includes(columnName.toLowerCase())
	)
}

function normalizeSessionRow(row: Record<string, string | null>): Session {
	const launchMetadata = parsePersistedLaunchMetadata({
		launchMode: row.launchMode,
		profile: row.profile,
		ocxBin: row.ocxBin,
	})
	const serialized = serializePersistedLaunchMetadata(launchMetadata)

	return {
		id: String(row.id),
		branch: String(row.branch),
		path: String(row.path),
		createdAt: String(row.createdAt),
		launchMode: serialized.launchMode,
		profile: serialized.profile,
		ocxBin: serialized.ocxBin,
	}
}

// =============================================================================
// SESSION CRUD
// =============================================================================

/**
 * Add a new session to the database.
 * Uses atomic INSERT OR REPLACE for idempotency.
 *
 * @param db - Database instance from initStateDb
 * @param session - Session data to persist
 */
export function addSession(db: Database, session: SessionInput): void {
	// Parse at boundary for type safety
	const parsed = sessionSchema.parse(session)
	const launchMetadata = parsePersistedLaunchMetadata({
		launchMode: parsed.launchMode,
		profile: parsed.profile,
		ocxBin: parsed.ocxBin,
	})
	const serializedLaunchMetadata = serializePersistedLaunchMetadata(launchMetadata)

	const stmt = db.prepare(`
		INSERT OR REPLACE INTO sessions (id, branch, path, created_at, launch_mode, profile, ocx_bin)
		VALUES ($id, $branch, $path, $createdAt, $launchMode, $profile, $ocxBin)
	`)

	stmt.run({
		$id: parsed.id,
		$branch: parsed.branch,
		$path: parsed.path,
		$createdAt: parsed.createdAt,
		$launchMode: serializedLaunchMetadata.launchMode,
		$profile: serializedLaunchMetadata.profile,
		$ocxBin: serializedLaunchMetadata.ocxBin,
	})
}

/**
 * Get a session by ID.
 *
 * @param db - Database instance from initStateDb
 * @param sessionId - Session ID to look up
 * @returns Session if found, null otherwise
 */
export function getSession(db: Database, sessionId: string): Session | null {
	// Guard: empty session ID
	if (!sessionId) return null

	const stmt = db.prepare(`
		SELECT id, branch, path, created_at as createdAt, launch_mode as launchMode, profile, ocx_bin as ocxBin
		FROM sessions
		WHERE id = $id
	`)

	const row = stmt.get({ $id: sessionId }) as Record<string, string | null> | null
	if (!row) return null

	return normalizeSessionRow(row)
}

/**
 * Remove a session by branch name.
 * Deletes all sessions matching the branch.
 *
 * @param db - Database instance from initStateDb
 * @param branch - Branch name to remove
 */
export function removeSession(db: Database, branch: string): void {
	// Guard: empty branch
	if (!branch) return

	const stmt = db.prepare(`DELETE FROM sessions WHERE branch = $branch`)
	stmt.run({ $branch: branch })
}

/**
 * Get all active sessions.
 *
 * @param db - Database instance from initStateDb
 * @returns Array of all sessions, empty if none
 */
export function getAllSessions(db: Database): Session[] {
	const stmt = db.prepare(`
		SELECT id, branch, path, created_at as createdAt, launch_mode as launchMode, profile, ocx_bin as ocxBin
		FROM sessions
		ORDER BY created_at ASC
	`)

	const rows = stmt.all() as Array<Record<string, string | null>>
	return rows.map((row) => normalizeSessionRow(row))
}

// =============================================================================
// PENDING SPAWN OPERATIONS
// =============================================================================

/**
 * Set a pending spawn operation. Uses singleton pattern (last-write-wins).
 *
 * If a pending spawn already exists, it will be REPLACED and a warning logged.
 * This is intentional: only the most recent spawn request should be processed.
 *
 * @param db - Database instance from initStateDb
 * @param spawn - Spawn operation data
 */
export function setPendingSpawn(db: Database, spawn: PendingSpawn, client?: OpencodeClient): void {
	// Parse at boundary for type safety
	const parsed = pendingSpawnSchema.parse(spawn)

	// Check for existing operations and warn about replacement
	const existingSpawn = getPendingSpawn(db)
	const existingDelete = getPendingDelete(db)

	if (existingSpawn) {
		logWarn(
			client,
			"worktree",
			`Replacing pending spawn: "${existingSpawn.branch}" → "${parsed.branch}"`,
		)
	} else if (existingDelete) {
		logWarn(
			client,
			"worktree",
			`Pending spawn replacing pending delete for: "${existingDelete.branch}"`,
		)
	}

	// Atomic: replace any existing pending operation
	const stmt = db.prepare(`
		INSERT OR REPLACE INTO pending_operations (id, type, branch, path, session_id)
		VALUES (1, 'spawn', $branch, $path, $sessionId)
	`)

	stmt.run({
		$branch: parsed.branch,
		$path: parsed.path,
		$sessionId: parsed.sessionId,
	})
}

/**
 * Get the pending spawn operation if one exists.
 *
 * @param db - Database instance from initStateDb
 * @returns PendingSpawn if exists and type is 'spawn', null otherwise
 */
export function getPendingSpawn(db: Database): PendingSpawn | null {
	const stmt = db.prepare(`
		SELECT type, branch, path, session_id as sessionId
		FROM pending_operations
		WHERE id = 1 AND type = 'spawn'
	`)

	const row = stmt.get() as Record<string, string> | null
	if (!row) return null

	return {
		branch: row.branch,
		path: row.path,
		sessionId: row.sessionId,
	}
}

/**
 * Clear any pending spawn operation.
 * Removes the row if it's a spawn type, leaves deletes untouched.
 *
 * @param db - Database instance from initStateDb
 */
export function clearPendingSpawn(db: Database): void {
	const stmt = db.prepare(`DELETE FROM pending_operations WHERE id = 1 AND type = 'spawn'`)
	stmt.run()
}

// =============================================================================
// PENDING DELETE OPERATIONS
// =============================================================================

/**
 * Set a pending delete operation. Uses singleton pattern (last-write-wins).
 *
 * If a pending delete already exists, it will be REPLACED and a warning logged.
 * This is intentional: only the most recent delete request should be processed.
 *
 * @param db - Database instance from initStateDb
 * @param del - Delete operation data
 */
export function setPendingDelete(db: Database, del: PendingDelete, client?: OpencodeClient): void {
	// Parse at boundary for type safety
	const parsed = pendingDeleteSchema.parse(del)

	// Check for existing operations and warn about replacement
	const existingDelete = getPendingDelete(db)
	const existingSpawn = getPendingSpawn(db)

	if (existingDelete) {
		logWarn(
			client,
			"worktree",
			`Replacing pending delete: "${existingDelete.branch}" → "${parsed.branch}"`,
		)
	} else if (existingSpawn) {
		logWarn(
			client,
			"worktree",
			`Pending delete replacing pending spawn for: "${existingSpawn.branch}"`,
		)
	}

	// Atomic: replace any existing pending operation
	const stmt = db.prepare(`
		INSERT OR REPLACE INTO pending_operations (id, type, branch, path, session_id)
		VALUES (1, 'delete', $branch, $path, NULL)
	`)

	stmt.run({
		$branch: parsed.branch,
		$path: parsed.path,
	})
}

/**
 * Get the pending delete operation if one exists.
 *
 * @param db - Database instance from initStateDb
 * @returns PendingDelete if exists and type is 'delete', null otherwise
 */
export function getPendingDelete(db: Database): PendingDelete | null {
	const stmt = db.prepare(`
		SELECT type, branch, path
		FROM pending_operations
		WHERE id = 1 AND type = 'delete'
	`)

	const row = stmt.get() as Record<string, string> | null
	if (!row) return null

	return {
		branch: row.branch,
		path: row.path,
	}
}

/**
 * Clear any pending delete operation.
 * Removes the row if it's a delete type, leaves spawns untouched.
 *
 * @param db - Database instance from initStateDb
 */
export function clearPendingDelete(db: Database): void {
	const stmt = db.prepare(`DELETE FROM pending_operations WHERE id = 1 AND type = 'delete'`)
	stmt.run()
}

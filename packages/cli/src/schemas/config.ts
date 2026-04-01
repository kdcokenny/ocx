/**
 * Config & Lockfile Schemas
 *
 * Schemas for ocx.jsonc (user config) and ocx.lock (auto-generated lockfile).
 * Includes Bun-specific I/O helpers.
 */

import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import { z } from "zod"
import { normalizeRegistryUrl } from "../utils/url"
import { qualifiedComponentSchema } from "./registry"

// =============================================================================
// OCX CONFIG SCHEMA (ocx.jsonc)
// =============================================================================

/**
 * Registry configuration in ocx.jsonc
 */
export const registryConfigSchema = z.object({
	/** Registry URL */
	url: z.string().url("Registry URL must be a valid URL"),

	/** Optional auth headers (supports ${ENV_VAR} expansion) */
	headers: z.record(z.string(), z.string()).optional(),
})

export type RegistryConfig = z.infer<typeof registryConfigSchema>

/**
 * Main OCX config schema (ocx.jsonc)
 * V2: Adds profile field for local profile selection
 */
export const ocxConfigSchema = z.object({
	/** Schema URL for IDE support */
	$schema: z.string().optional(),

	/** Profile selection - specifies which global profile to layer with local config */
	profile: z.string().optional(),

	/** Configured registries */
	registries: z.record(z.string(), registryConfigSchema).default({}),

	/** Lock registries - prevent adding/removing (enterprise feature) */
	lockRegistries: z.boolean().default(false),

	/** Skip version compatibility checks */
	skipCompatCheck: z.boolean().default(false),
})

export type OcxConfig = z.infer<typeof ocxConfigSchema>

export interface ReadOcxConfigOptions {
	/**
	 * Emit parse diagnostics directly to stderr.
	 * Defaults to true to preserve existing human-mode behavior.
	 */
	emitParseDiagnostics?: boolean
}

// =============================================================================
// RECEIPT SCHEMA (V1: replaces ocx.lock)
// =============================================================================

export const RECEIPT_DIR = ".ocx"
export const RECEIPT_FILE = "receipt.jsonc"

/**
 * V1: Installed component entry in receipt
 * Canonical ID format: "registryUrl::registryName/component@resolvedRevision"
 * Includes ownership tracking and sha256 baseline for integrity
 */
export const installedComponentSchema = z.object({
	/** Registry URL where this was installed from */
	registryUrl: z.string(),

	/** Registry name (configured alias from ocx.jsonc) */
	registryName: z.string(),

	/** Component name */
	name: z.string(),

	/** Resolved version/revision (not tags) */
	revision: z.string(),

	/** SHA-256 hash of installed files for integrity (baseline) */
	hash: z.string(),

	/** Target files where installed (root-relative paths) with individual hashes */
	files: z.array(
		z.object({
			/** File path relative to install root */
			path: z.string(),
			/** SHA-256 hash of this specific file */
			hash: z.string(),
		}),
	),

	/** ISO timestamp of installation */
	installedAt: z.string(),

	/** ISO timestamp of last update (optional, only set after update) */
	updatedAt: z.string().optional(),

	/** Ownership metadata - who/what installed this component */
	owner: z
		.object({
			/** Owner type: user, profile, or system */
			type: z.enum(["user", "profile", "system"]),
			/** Owner identifier (username, profile name, etc.) */
			id: z.string().optional(),
		})
		.optional(),

	/**
	 * OpenCode config provided by this component.
	 * Stored for runtime instruction path resolution.
	 * Install-root-relative paths in instructions array are resolved at runtime.
	 */
	opencode: z.record(z.string(), z.unknown()).optional(),
})

export type InstalledComponent = z.infer<typeof installedComponentSchema>

/**
 * V1: Receipt file schema (.ocx/receipt.jsonc)
 * Tracks installed components with ownership and baselines per install root.
 * Replaces the old ocx.lock format.
 *
 * Keys use canonical ID format: "registryUrl::registryName/component@resolvedRevision"
 */
export const receiptSchema = z.object({
	/** Receipt format version */
	version: z.literal(1),

	/** Install root (for validation) */
	root: z.string().optional(),

	/** Installed components, keyed by canonical ID */
	installed: z.record(z.string(), installedComponentSchema).default({}),
})

export type Receipt = z.infer<typeof receiptSchema>

// =============================================================================
// OCX LOCKFILE SCHEMA (LEGACY - V1 compat)
// =============================================================================

/**
 * LEGACY V1: Installed component entry in lockfile
 * Key format: "alias/component" (e.g., "kdco/researcher")
 */
export const legacyInstalledComponentSchema = z.object({
	/** Registry alias this was installed from */
	registry: z.string(),

	/** Version at time of install */
	version: z.string(),

	/** SHA-256 hash of installed files for integrity */
	hash: z.string(),

	/** Target files where installed (clean paths, no alias prefix) */
	files: z.array(z.string()),

	/** ISO timestamp of installation */
	installedAt: z.string(),

	/** ISO timestamp of last update (optional, only set after update) */
	updatedAt: z.string().optional(),
})

export type LegacyInstalledComponent = z.infer<typeof legacyInstalledComponentSchema>

/**
 * Profile source tracking for profiles installed from registries.
 * Optional field in OcxLock - only present for profile installs.
 */
export const installedFromSchema = z.object({
	/** Registry alias this profile was installed from */
	registry: z.string(),

	/** Component name in the registry */
	component: z.string(),

	/** Registry version at time of install */
	version: z.string().optional(),

	/** SHA-256 hash of profile files for integrity */
	hash: z.string(),

	/** ISO timestamp of installation */
	installedAt: z.string(),
})

export type InstalledFrom = z.infer<typeof installedFromSchema>

/**
 * OCX lockfile schema (ocx.lock)
 * Keys are qualified component refs: "alias/component"
 */
export const ocxLockSchema = z.object({
	/** Lockfile format version */
	lockVersion: z.literal(1),

	/** Profile source info (only present for profiles installed from registry) */
	installedFrom: installedFromSchema.optional(),

	/** Installed components, keyed by "alias/component" */
	installed: z.record(qualifiedComponentSchema, legacyInstalledComponentSchema).default({}),
})

export type OcxLock = z.infer<typeof ocxLockSchema>

// =============================================================================
// RECEIPT FILE HELPERS (V1)
// =============================================================================

/**
 * V1: Create canonical component ID.
 * Format: "registryUrl::registryName/component@resolvedRevision"
 *
 * Registry versions are ignored - registry is treated as latest-only.
 *
 * @param registryUrl - Registry base URL (normalized)
 * @param registryName - Configured registry alias
 * @param name - Component name
 * @param revision - Resolved version/revision (not tags)
 * @returns Canonical ID string
 */
export function createCanonicalId(
	registryUrl: string,
	registryName: string,
	name: string,
	revision: string,
): string {
	// Normalize registry URL (remove trailing slash)
	const normalizedUrl = normalizeRegistryUrl(registryUrl)
	return `${normalizedUrl}::${registryName}/${name}@${revision}`
}

/**
 * V1: Parse a canonical component ID.
 * Format: "registryUrl::registryName/component@resolvedRevision"
 *
 * @param canonicalId - The canonical ID to parse
 * @returns Parsed components
 * @throws Error if format is invalid
 */
export function parseCanonicalId(canonicalId: string): {
	registryUrl: string
	registryName: string
	name: string
	revision: string
} {
	// Guard: must contain ::
	if (!canonicalId.includes("::")) {
		throw new Error(
			`Invalid canonical ID: "${canonicalId}". Expected format: registryUrl::registryName/component@revision`,
		)
	}

	const [registryUrl, rest] = canonicalId.split("::")

	// Guard: must have content after ::
	if (!rest || !registryUrl) {
		throw new Error(
			`Invalid canonical ID: "${canonicalId}". Expected format: registryUrl::registryName/component@revision`,
		)
	}

	// Guard: must contain @
	if (!rest.includes("@")) {
		throw new Error(
			`Invalid canonical ID: "${canonicalId}". Expected format: registryUrl::registryName/component@revision`,
		)
	}

	// Parse using indexOf to preserve @ in revision (e.g., user@branch)
	const atIndex = rest.indexOf("@")
	if (atIndex === -1) {
		throw new Error(`Invalid canonical ID: missing revision in ${canonicalId}`)
	}
	const qualifiedName = rest.slice(0, atIndex)
	const revision = rest.slice(atIndex + 1)

	// Guard: must have qualified name and revision
	if (!qualifiedName || !revision) {
		throw new Error(
			`Invalid canonical ID: "${canonicalId}". Expected format: registryUrl::registryName/component@revision`,
		)
	}

	// Parse qualified name
	if (!qualifiedName.includes("/")) {
		throw new Error(
			`Invalid canonical ID: "${canonicalId}". Component must be qualified (registryName/component)`,
		)
	}

	const [registryName, name] = qualifiedName.split("/")

	// Guard: registryName and name must exist
	if (!registryName || !name) {
		throw new Error(
			`Invalid canonical ID: "${canonicalId}". Both registry name and component name are required`,
		)
	}

	return {
		registryUrl: normalizeRegistryUrl(registryUrl), // Normalize
		registryName,
		name,
		revision,
	}
}

/**
 * V1: Find receipt file path for an install root.
 * Receipt is always at <root>/.ocx/receipt.jsonc
 * @param installRoot - The install root directory
 * @returns Object with path and whether it exists
 */
export function findReceipt(installRoot: string): { path: string; exists: boolean } {
	const receiptPath = path.join(installRoot, RECEIPT_DIR, RECEIPT_FILE)
	return {
		path: receiptPath,
		exists: existsSync(receiptPath),
	}
}

/**
 * V1: Read receipt file
 * @param installRoot - The install root directory
 * @returns Receipt object or null if not found
 */
export async function readReceipt(installRoot: string): Promise<Receipt | null> {
	const { path: receiptPath, exists } = findReceipt(installRoot)

	if (!exists) {
		return null
	}

	const file = Bun.file(receiptPath)
	const content = await file.text()
	const json = parseJsonc(content, [], { allowTrailingComma: true })
	return receiptSchema.parse(json)
}

/**
 * V1: Write receipt file
 * @param installRoot - The install root directory
 * @param receipt - Receipt data to write
 */
export async function writeReceipt(installRoot: string, receipt: Receipt): Promise<void> {
	const receiptPath = path.join(installRoot, RECEIPT_DIR, RECEIPT_FILE)

	// Ensure directory exists
	await mkdir(path.dirname(receiptPath), { recursive: true })

	const content = JSON.stringify(receipt, null, 2)
	await Bun.write(receiptPath, content)
}

// =============================================================================
// CONFIG FILE HELPERS (Bun-specific I/O)
// =============================================================================

const CONFIG_FILE = "ocx.jsonc"
const LOCK_FILE = "ocx.lock"
const LOCAL_CONFIG_DIR = ".opencode"

/**
 * Find ocx.jsonc config file path.
 * Checks .opencode/ first, then root. Fails if both exist.
 * @returns Object with path and whether it exists, or throws if conflict
 */
export function findOcxConfig(cwd: string): { path: string; exists: boolean } {
	const dotOpencodePath = path.join(cwd, LOCAL_CONFIG_DIR, CONFIG_FILE)
	const rootPath = path.join(cwd, CONFIG_FILE)

	const dotOpencodeExists = existsSync(dotOpencodePath)
	const rootExists = existsSync(rootPath)

	// Fail if both exist - user needs to consolidate
	if (dotOpencodeExists && rootExists) {
		throw new Error(
			`Found ${CONFIG_FILE} in both .opencode/ and project root. ` +
				`Please consolidate to one location (recommended: .opencode/${CONFIG_FILE})`,
		)
	}

	if (dotOpencodeExists) {
		return { path: dotOpencodePath, exists: true }
	}

	if (rootExists) {
		return { path: rootPath, exists: true }
	}

	// Neither exists - default to .opencode/ for new files
	return { path: dotOpencodePath, exists: false }
}

/**
 * Find ocx.lock lockfile path.
 * Checks .opencode/ first, then root.
 * @param cwd - Working directory
 * @param options - Optional settings for path resolution
 * @returns Object with path and whether it exists
 */
export function findOcxLock(
	cwd: string,
	options?: { isFlattened?: boolean },
): { path: string; exists: boolean } {
	const dotOpencodePath = path.join(cwd, LOCAL_CONFIG_DIR, LOCK_FILE)
	const rootPath = path.join(cwd, LOCK_FILE)

	if (options?.isFlattened) {
		// Flattened mode (global/profile): prefer root, ignore .opencode/
		if (existsSync(rootPath)) {
			return { path: rootPath, exists: true }
		}
		return { path: rootPath, exists: false }
	}

	// Local mode: prefer .opencode/, fallback to root
	if (existsSync(dotOpencodePath)) {
		return { path: dotOpencodePath, exists: true }
	}

	if (existsSync(rootPath)) {
		return { path: rootPath, exists: true }
	}

	return { path: dotOpencodePath, exists: false }
}

/**
 * Read ocx.jsonc config file
 */
export async function readOcxConfig(
	cwd: string,
	options: ReadOcxConfigOptions = {},
): Promise<OcxConfig | null> {
	const { path: configPath, exists } = findOcxConfig(cwd)

	if (!exists) {
		return null
	}

	const file = Bun.file(configPath)
	const content = await file.text()
	try {
		const json = parseJsonc(content, [], { allowTrailingComma: true })
		return ocxConfigSchema.parse(json)
	} catch (error) {
		if (options.emitParseDiagnostics ?? true) {
			console.error(`Error parsing ${configPath}:`, error)
		}
		throw error
	}
}

/**
 * Write ocx.jsonc config file.
 * @param cwd - Working directory
 * @param config - Config to write
 * @param existingPath - If provided, write to this path (for updates). Otherwise use .opencode/
 */
export async function writeOcxConfig(
	cwd: string,
	config: OcxConfig,
	existingPath?: string,
): Promise<void> {
	const configPath = existingPath ?? path.join(cwd, LOCAL_CONFIG_DIR, CONFIG_FILE)

	// Ensure directory exists
	await mkdir(path.dirname(configPath), { recursive: true })

	const content = JSON.stringify(config, null, 2)
	await Bun.write(configPath, content)
}

/**
 * Read ocx.lock lockfile
 */
export async function readOcxLock(
	cwd: string,
	options?: { isFlattened?: boolean },
): Promise<OcxLock | null> {
	const { path: lockPath, exists } = findOcxLock(cwd, options)

	if (!exists) {
		return null
	}

	const file = Bun.file(lockPath)
	const content = await file.text()
	const json = parseJsonc(content, [], { allowTrailingComma: true })
	return ocxLockSchema.parse(json)
}

/**
 * Write ocx.lock lockfile.
 * @param cwd - Working directory
 * @param lock - Lock data to write
 * @param existingPath - If provided, write to this path (for updates). Otherwise use .opencode/
 */
export async function writeOcxLock(
	cwd: string,
	lock: OcxLock,
	existingPath?: string,
): Promise<void> {
	const lockPath = existingPath ?? path.join(cwd, LOCAL_CONFIG_DIR, LOCK_FILE)

	// Ensure directory exists
	await mkdir(path.dirname(lockPath), { recursive: true })

	const content = JSON.stringify(lock, null, 2)
	await Bun.write(lockPath, content)
}

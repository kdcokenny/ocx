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

	/** Optional version pin */
	version: z.string().optional(),

	/** Optional auth headers (supports ${ENV_VAR} expansion) */
	headers: z.record(z.string()).optional(),
})

export type RegistryConfig = z.infer<typeof registryConfigSchema>

/**
 * Main OCX config schema (ocx.jsonc)
 */
export const ocxConfigSchema = z.object({
	/** Schema URL for IDE support */
	$schema: z.string().optional(),

	/** Configured registries */
	registries: z.record(registryConfigSchema).default({}),

	/** Lock registries - prevent adding/removing (enterprise feature) */
	lockRegistries: z.boolean().default(false),

	/** Skip version compatibility checks */
	skipCompatCheck: z.boolean().default(false),
})

export type OcxConfig = z.infer<typeof ocxConfigSchema>

// =============================================================================
// OCX LOCKFILE SCHEMA (ocx.lock)
// =============================================================================

/**
 * Installed component entry in lockfile
 * Key format: "namespace/component" (e.g., "kdco/researcher")
 */
export const installedComponentSchema = z.object({
	/** Registry namespace this was installed from */
	registry: z.string(),

	/** Version at time of install */
	version: z.string(),

	/** SHA-256 hash of installed files for integrity */
	hash: z.string(),

	/** Target files where installed (clean paths, no namespace prefix) */
	files: z.array(z.string()),

	/** ISO timestamp of installation */
	installedAt: z.string(),

	/** ISO timestamp of last update (optional, only set after update) */
	updatedAt: z.string().optional(),
})

export type InstalledComponent = z.infer<typeof installedComponentSchema>

/**
 * OCX lockfile schema (ocx.lock)
 * Keys are qualified component refs: "namespace/component"
 */
export const ocxLockSchema = z.object({
	/** Lockfile format version */
	lockVersion: z.literal(1),

	/** Installed components, keyed by "namespace/component" */
	installed: z.record(qualifiedComponentSchema, installedComponentSchema).default({}),
})

export type OcxLock = z.infer<typeof ocxLockSchema>

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
export async function readOcxConfig(cwd: string): Promise<OcxConfig | null> {
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
		console.error(`Error parsing ${configPath}:`, error)
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

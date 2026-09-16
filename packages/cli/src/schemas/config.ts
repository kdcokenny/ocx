/**
 * OCX metadata and ownership receipts
 *
 * Schemas for OCX metadata and owned files; native configuration belongs to OpenCode.
 * Includes Bun-specific I/O helpers.
 */

import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { type ParseError, parse as parseJsonc } from "jsonc-parser"
import type { infer as ZodInfer } from "zod"
import { array, boolean, literal, object, record, string, enum as zEnum } from "zod"
import { atomicWrite } from "../profile/atomic"
import { readManagedFile } from "../utils/file-transaction"
import { normalizeRegistryUrl } from "../utils/url"
import { qualifiedComponentSchema, validateFileTarget } from "./registry"

// =============================================================================
// OCX CONFIG SCHEMA (ocx.jsonc)
// =============================================================================

/**
 * Registry configuration in ocx.jsonc
 */
export const registryConfigSchema = object({
	/** Registry URL */
	url: string().url("Registry URL must be a valid URL"),

	/** Optional auth headers (supports ${ENV_VAR} expansion) */
	headers: record(string(), string()).optional(),
})

export type RegistryConfig = ZodInfer<typeof registryConfigSchema>

/**
 * Global and project OCX metadata (ocx.jsonc)
 */
export const ocxConfigSchema = object({
	/** Schema URL for IDE support */
	$schema: string().optional(),

	/** Explicit user default for launches; project metadata never selects a profile */
	defaultProfile: string().optional(),

	/** Configured registries */
	registries: record(string(), registryConfigSchema).default({}),

	/** Lock registries - prevent adding/removing (enterprise feature) */
	lockRegistries: boolean().default(false),
}).strict()

export type OcxConfig = ZodInfer<typeof ocxConfigSchema>

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
export const installedComponentSchema = object({
	/** Registry URL where this was installed from */
	registryUrl: string(),

	/** Registry name (configured alias from ocx.jsonc) */
	registryName: string(),

	/** Component name */
	name: string(),

	/** Resolved version/revision (not tags) */
	revision: string(),

	/** SHA-256 hash of installed files for integrity (baseline) */
	hash: string(),

	/** Target files where installed (root-relative paths) with individual hashes */
	files: array(
		object({
			/** File path relative to install root */
			path: string().superRefine((value, context) => {
				try {
					validateFileTarget(value, "profile")
				} catch (error) {
					context.addIssue({ code: "custom", message: String(error) })
				}
			}),
			/** SHA-256 hash of this specific file */
			hash: string(),
		}),
	),

	/** ISO timestamp of installation */
	installedAt: string(),

	/** ISO timestamp of last update (optional, only set after update) */
	updatedAt: string().optional(),

	/** Ownership metadata - who/what installed this component */
	owner: object({
		/** Owner type: user, profile, or system */
		type: zEnum(["user", "profile", "system"]),
		/** Owner identifier (username, profile name, etc.) */
		id: string().optional(),
	}).optional(),

	dependencies: array(qualifiedComponentSchema).default([]),
})

export type InstalledComponent = ZodInfer<typeof installedComponentSchema>

/**
 * V1: Receipt file schema (.ocx/receipt.jsonc)
 * Tracks installed components with ownership and baselines per install root.
 * Replaces the old ocx.lock format.
 *
 * Keys use canonical ID format: "registryUrl::registryName/component@resolvedRevision"
 */
export const receiptSchema = object({
	/** Receipt format version */
	version: literal(1),

	/** Install root (for validation) */
	root: string().optional(),

	/** Installed components, keyed by canonical ID */
	installed: record(string(), installedComponentSchema).default({}),
})

export type Receipt = ZodInfer<typeof receiptSchema>

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
	const content = await readManagedFile(installRoot, `${RECEIPT_DIR}/${RECEIPT_FILE}`)
	if (content === null) return null
	const errors: ParseError[] = []
	const json = parseJsonc(content.toString("utf8"), errors, { allowTrailingComma: true })
	if (errors.length > 0) throw new Error("Invalid JSONC in OCX receipt")
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

	await atomicWrite(receiptPath, receipt)
}

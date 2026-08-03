/**
 * Migration module: Legacy ocx.lock → V2 .ocx/receipt.jsonc
 *
 * Isolated transform logic for converting v1.4.6 lock entries into
 * canonical receipt entries, plus registry config normalization.
 * No side effects — pure data transform.
 */

import type { InstalledComponent, OcxConfig, OcxLock, Receipt } from "../../schemas/config"
import { createCanonicalId } from "../../schemas/config"
import { ConfigError } from "../../utils/errors"

// =============================================================================
// TYPES
// =============================================================================

export type MigrateScope = "local" | "global"

export type MigrateStatus =
	| "nothing_to_migrate"
	| "already_v2"
	| "preview"
	| "preview_with_errors"
	| "migrated"
	| "partial_failure"

export type MigrateLifecycleStatus = "preview_ok" | "preview_blocked" | "apply_ok" | "apply_failed"

export interface MigrateBlocker {
	code: string
	message: string
	path: string
}

/** Describes a single registry config normalization action */
export interface ConfigNormalizationAction {
	registry: string
	field: string
	action: "remove_deprecated"
}

export interface MigrateResult {
	success: boolean
	status: MigrateStatus
	/** Additive status field for the migrate contract */
	lifecycle_status?: MigrateLifecycleStatus
	/** Additive schema version field for the migrate contract */
	schema_version?: 1
	/** Additive aggregate blockers for the migrate contract */
	blockers?: MigrateBlocker[]
	scope: MigrateScope
	count: number
	components: Array<{
		legacyKey: string
		canonicalId: string
		name: string
		registryName: string
	}>
	configActions: ConfigNormalizationAction[]
	/** Per-target results when --global processes root + profiles */
	targets?: TargetResult[]
}

/** Result for a single migration target (global root or profile) */
export interface TargetResult {
	target: string
	/** Additive target identity field for the migrate contract */
	scope?: string
	status: MigrateStatus | "error"
	/** Additive target result field for the migrate contract */
	result?: MigrateStatus | "error"
	/** Additive target blockers field for the migrate contract */
	blockers?: MigrateBlocker[]
	count: number
	components: MigrateResult["components"]
	configActions: ConfigNormalizationAction[]
	error?: string
}

// =============================================================================
// TRANSFORM (Pure, deterministic)
// =============================================================================

/**
 * Transform a single legacy lock entry into a V2 installed component.
 *
 * Legacy format:
 *   key = "alias/component"
 *   entry = { registry, version, hash, files: string[], installedAt, updatedAt? }
 *
 * V2 format:
 *   key = canonical ID ("registryUrl::registryName/component@revision")
 *   entry = { registryUrl, registryName, name, revision, hash, files: {path,hash}[], ... }
 *
 * @param legacyKey - Legacy qualified key (e.g., "kdco/researcher")
 * @param entry - Legacy installed component entry
 * @param registryUrl - Resolved registry URL from ocx.jsonc config
 * @returns Tuple of [canonicalId, InstalledComponent]
 */
export function transformLegacyEntry(
	legacyKey: string,
	entry: OcxLock["installed"][string],
	registryUrl: string,
): [string, InstalledComponent] {
	// Guard: key must contain slash
	const slashIndex = legacyKey.indexOf("/")
	if (slashIndex === -1) {
		throw new Error(`Invalid legacy key: "${legacyKey}". Expected format: alias/component`)
	}

	const registryName = legacyKey.slice(0, slashIndex)
	const name = legacyKey.slice(slashIndex + 1)

	// Guard: both parts must be non-empty
	if (!registryName || !name) {
		throw new Error(`Invalid legacy key: "${legacyKey}". Both alias and component are required.`)
	}

	const canonicalId = createCanonicalId(registryUrl, registryName, name, entry.version)

	const component: InstalledComponent = {
		registryUrl,
		registryName,
		name,
		revision: entry.version,
		hash: entry.hash,
		files: entry.files.map((filePath) => ({
			path: filePath,
			// Legacy lock doesn't store per-file hashes — use empty string as sentinel
			hash: "",
		})),
		installedAt: entry.installedAt,
		...(entry.updatedAt && { updatedAt: entry.updatedAt }),
		owner: { type: "user" },
	}

	return [canonicalId, component]
}

/**
 * Build a complete V2 receipt from a legacy lock and config.
 *
 * Deterministic: same inputs always produce same output.
 * Entries are sorted by canonical ID for stable JSON output.
 *
 * @param lock - Parsed legacy ocx.lock
 * @param config - Parsed ocx.jsonc with registry URLs
 * @param root - Install root path to record in receipt (optional)
 * @returns Receipt and migration metadata
 */
export function buildReceiptFromLock(
	lock: OcxLock,
	config: OcxConfig,
	root?: string,
): { receipt: Receipt; components: MigrateResult["components"] } {
	const installed: Record<string, InstalledComponent> = {}
	const components: MigrateResult["components"] = []

	// Sort legacy keys for deterministic output
	const sortedKeys = Object.keys(lock.installed).sort()

	for (const legacyKey of sortedKeys) {
		const entry = lock.installed[legacyKey]
		if (!entry) continue

		// Resolve registry URL from config
		const registryConfig = config.registries[entry.registry]
		if (!registryConfig) {
			throw new ConfigError(
				`Registry "${entry.registry}" referenced in lock key "${legacyKey}" ` +
					`is not configured in ocx.jsonc. Add it before migrating.`,
			)
		}

		const [canonicalId, component] = transformLegacyEntry(legacyKey, entry, registryConfig.url)

		installed[canonicalId] = component
		components.push({
			legacyKey,
			canonicalId,
			name: component.name,
			registryName: component.registryName,
		})
	}

	const receipt: Receipt = {
		version: 1,
		...(root && { root }),
		installed,
	}

	return { receipt, components }
}

// =============================================================================
// REGISTRY CONFIG NORMALIZATION (Pure, deterministic)
// =============================================================================

/** Known deprecated fields from legacy v1.4.6 registry config */
const DEPRECATED_REGISTRY_FIELDS = ["version"] as const

/**
 * Detect deprecated `version` fields in registry config entries.
 *
 * Legacy v1.4.6 allowed `registries.<alias>.version` for pinning.
 * Current schema allows `url`, `headers`, `auth`, and `insecure`. This function
 * inspects raw config data (pre-Zod-parse) to find deprecated keys.
 *
 * Pure function: returns planned actions, never mutates.
 *
 * @param rawConfig - Raw config object (may contain extra keys stripped by Zod)
 * @returns Array of normalization actions to apply
 */
export function detectConfigNormalization(
	rawConfig: Record<string, unknown>,
): ConfigNormalizationAction[] {
	const registries = rawConfig.registries
	if (!registries || typeof registries !== "object" || Array.isArray(registries)) {
		return []
	}

	const actions: ConfigNormalizationAction[] = []
	const registryMap = registries as Record<string, unknown>

	for (const alias of Object.keys(registryMap).sort()) {
		const entry = registryMap[alias]
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue

		const entryRecord = entry as Record<string, unknown>
		for (const field of DEPRECATED_REGISTRY_FIELDS) {
			if (field in entryRecord) {
				actions.push({
					registry: alias,
					field,
					action: "remove_deprecated",
				})
			}
		}
	}

	return actions
}

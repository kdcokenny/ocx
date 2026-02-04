/**
 * Receipt utilities for V2 component tracking
 *
 * Handles file integrity checking, manual edit detection, and receipt operations.
 */

import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { InstalledComponent, Receipt } from "../schemas/config"
import { createCanonicalId, parseCanonicalId } from "../schemas/config"
import { normalizeRegistryUrl } from "./url"

/**
 * Hash file content using SHA-256.
 * Reuses existing hash infrastructure from add.ts and update.ts.
 *
 * @param content - Buffer or string to hash
 * @returns Lowercase hex-encoded SHA256 hash
 */
export function hashContent(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex")
}

/**
 * Hash a bundle of files deterministically.
 * Files are sorted by path for consistent hashing.
 *
 * @param files - Array of file objects with path and content
 * @returns SHA-256 hash of the entire bundle
 */
export async function hashBundle(files: { path: string; content: Buffer }[]): Promise<string> {
	// Sort files for deterministic hashing
	const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))

	// Create a manifest of file hashes
	const manifestParts: string[] = []
	for (const file of sorted) {
		const hash = hashContent(file.content)
		manifestParts.push(`${file.path}:${hash}`)
	}

	// Hash the manifest itself
	return hashContent(manifestParts.join("\n"))
}

/**
 * Check if files in a component have been manually edited.
 * Compares current file hashes against receipt baselines.
 *
 * @param installRoot - Install root directory
 * @param entry - Installed component entry from receipt
 * @returns Object with overall status and per-file details
 */
export async function checkFileIntegrity(
	installRoot: string,
	entry: InstalledComponent,
): Promise<{
	intact: boolean
	modified: string[]
	missing: string[]
	details: Array<{ path: string; status: "intact" | "modified" | "missing" }>
}> {
	const modified: string[] = []
	const missing: string[] = []
	const details: Array<{ path: string; status: "intact" | "modified" | "missing" }> = []

	for (const fileEntry of entry.files) {
		const filePath = join(installRoot, fileEntry.path)

		if (!existsSync(filePath)) {
			missing.push(fileEntry.path)
			details.push({ path: fileEntry.path, status: "missing" })
			continue
		}

		const currentContent = await Bun.file(filePath).text()
		const currentHash = hashContent(currentContent)

		if (currentHash !== fileEntry.hash) {
			modified.push(fileEntry.path)
			details.push({ path: fileEntry.path, status: "modified" })
		} else {
			details.push({ path: fileEntry.path, status: "intact" })
		}
	}

	return {
		intact: modified.length === 0 && missing.length === 0,
		modified,
		missing,
		details,
	}
}

/**
 * Find component entry by canonical ID in receipt.
 *
 * @param receipt - Receipt object
 * @param canonicalId - Canonical component ID
 * @returns Installed component entry or null if not found
 */
export function findComponentById(
	receipt: Receipt,
	canonicalId: string,
): InstalledComponent | null {
	return receipt.installed[canonicalId] ?? null
}

/**
 * Find component entry by file path.
 * Searches all installed components to find which one owns a given file.
 *
 * @param receipt - Receipt object
 * @param filePath - File path to search for
 * @returns Object with canonical ID and entry, or null if not found
 */
export function findComponentByFile(
	receipt: Receipt,
	filePath: string,
): { canonicalId: string; entry: InstalledComponent } | null {
	for (const [canonicalId, entry] of Object.entries(receipt.installed)) {
		if (entry.files.some((f) => f.path === filePath)) {
			return { canonicalId, entry }
		}
	}
	return null
}

/**
 * Find all components from a specific registry.
 *
 * @param receipt - Receipt object
 * @param registryUrl - Registry URL to filter by
 * @returns Array of canonical IDs and entries
 */
export function findComponentsByRegistry(
	receipt: Receipt,
	registryUrl: string,
): Array<{ canonicalId: string; entry: InstalledComponent }> {
	const normalized = normalizeRegistryUrl(registryUrl)
	const results: Array<{ canonicalId: string; entry: InstalledComponent }> = []

	for (const [canonicalId, entry] of Object.entries(receipt.installed)) {
		if (normalizeRegistryUrl(entry.registryUrl) === normalized) {
			results.push({ canonicalId, entry })
		}
	}

	return results
}

export { createCanonicalId, parseCanonicalId }

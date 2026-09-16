/**
 * Receipt utilities for V2 component tracking
 *
 * Handles file integrity checking, manual edit detection, and receipt operations.
 */

import { createHash } from "node:crypto"
import type { InstalledComponent } from "../schemas/config"
import { createCanonicalId, parseCanonicalId } from "../schemas/config"
import { readManagedFile } from "./file-transaction"

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
		const currentContent = await readManagedFile(installRoot, fileEntry.path)

		if (currentContent === null) {
			missing.push(fileEntry.path)
			details.push({ path: fileEntry.path, status: "missing" })
			continue
		}

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

export { createCanonicalId, parseCanonicalId }

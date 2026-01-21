/**
 * SHA256 verification for self-update downloads.
 *
 * Follows the 5 Laws of Elegant Defense:
 * - Early Exit: Guard clauses in parseSha256Sums for empty/invalid lines
 * - Parse Don't Validate: Checksums parsed into Map at boundary
 * - Atomic Predictability: Pure hash functions with no side effects
 * - Fail Fast: IntegrityError thrown immediately on mismatch
 * - Intentional Naming: parseSha256Sums, hashContent, verifyChecksum
 */

import { createHash } from "node:crypto"
import { IntegrityError, SelfUpdateError } from "../utils/errors"

const GITHUB_REPO = "kdcokenny/ocx"

// =============================================================================
// CHECKSUM PARSING
// =============================================================================

/**
 * Parse SHA256SUMS.txt content into a Map.
 * Supports GNU format: "<hash>  <filename>" (two spaces)
 * Supports BSD format: "<hash> *<filename>" (asterisk prefix)
 *
 * @param content - Raw content of SHA256SUMS.txt
 * @returns Map of filename to lowercase hash
 */
export function parseSha256Sums(content: string): Map<string, string> {
	const checksums = new Map<string, string>()
	for (const line of content.split("\n")) {
		const match = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/)
		if (match?.[1] && match[2]) {
			checksums.set(match[2].trim(), match[1].toLowerCase())
		}
	}
	return checksums
}

// =============================================================================
// HASHING
// =============================================================================

/**
 * Hash content using SHA256.
 *
 * @param content - Buffer or string to hash
 * @returns Lowercase hex-encoded SHA256 hash
 */
export function hashContent(content: Buffer | string): string {
	return createHash("sha256").update(content).digest("hex")
}

// =============================================================================
// CHECKSUM FETCHING
// =============================================================================

/**
 * Download and parse SHA256SUMS.txt for a version.
 *
 * @param version - Version string (without 'v' prefix)
 * @returns Map of filename to expected hash
 * @throws SelfUpdateError if checksums cannot be fetched
 */
export async function fetchChecksums(version: string): Promise<Map<string, string>> {
	const url = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/SHA256SUMS.txt`
	const response = await fetch(url)
	if (!response.ok) {
		throw new SelfUpdateError(`Failed to fetch checksums: ${response.status}`)
	}
	const content = await response.text()
	return parseSha256Sums(content)
}

// =============================================================================
// VERIFICATION
// =============================================================================

/**
 * Verify a downloaded file against expected checksum.
 *
 * @param filePath - Path to file to verify
 * @param expectedHash - Expected SHA256 hash (lowercase hex)
 * @param filename - Display name for error messages
 * @throws IntegrityError if checksum does not match
 */
export async function verifyChecksum(
	filePath: string,
	expectedHash: string,
	filename: string,
): Promise<void> {
	const file = Bun.file(filePath)
	const content = await file.arrayBuffer()
	const actualHash = hashContent(Buffer.from(content))

	if (actualHash !== expectedHash) {
		throw new IntegrityError(filename, expectedHash, actualHash)
	}
}

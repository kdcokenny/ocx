/**
 * Self-Update Binary Download
 *
 * Downloads and replaces the OCX binary with atomic swap and rollback.
 * Follows the 5 Laws of Elegant Defense:
 * - Early Exit: Guard clauses for unsupported platforms
 * - Parse Don't Validate: Platform resolved to typed download URL
 * - Atomic Predictability: Temp file -> backup -> swap pattern
 * - Fail Fast: Throw SelfUpdateError on any failure
 * - Intentional Naming: downloadWithProgress, downloadAndReplace
 */

import { chmodSync, existsSync, renameSync, unlinkSync } from "node:fs"
import { SelfUpdateError } from "../utils/errors"
import { createSpinner } from "../utils/spinner"
import { getExecutablePath } from "./detect-method"

// =============================================================================
// CONSTANTS
// =============================================================================

/** GitHub repository for OCX releases */
const GITHUB_REPO = "kdcokenny/ocx"

/** Default base URL for downloading OCX releases from GitHub */
const DEFAULT_DOWNLOAD_BASE_URL = `https://github.com/${GITHUB_REPO}/releases/download`

/**
 * Platform map matching build-binary.ts targets.
 * Maps `${process.arch}-${process.platform}` to binary filename.
 *
 * Note: Baseline and musl variants are not auto-detected.
 * Users on those platforms should use the curl installer with explicit target.
 */
const PLATFORM_MAP: Record<string, string> = {
	// macOS
	"arm64-darwin": "ocx-darwin-arm64",
	"x64-darwin": "ocx-darwin-x64",
	// Linux (glibc - standard)
	"arm64-linux": "ocx-linux-arm64",
	"x64-linux": "ocx-linux-x64",
	// Windows
	"x64-win32": "ocx-windows-x64.exe",
} as const

// =============================================================================
// URL GENERATION
// =============================================================================

/**
 * Get the base URL for downloading OCX releases.
 * Supports OCX_DOWNLOAD_URL for enterprise/air-gapped environments.
 *
 * @returns Base URL for release downloads (without trailing slash)
 */
export function getDownloadBaseUrl(): string {
	const envUrl = process.env.OCX_DOWNLOAD_URL

	if (envUrl) {
		// Normalize: remove trailing slash(es)
		return envUrl.replace(/\/+$/, "")
	}

	return DEFAULT_DOWNLOAD_BASE_URL
}

/**
 * Get download URL for a specific version.
 *
 * @param version - Version to download (without 'v' prefix)
 * @returns Release download URL (from GitHub or OCX_DOWNLOAD_URL override)
 * @throws SelfUpdateError if platform is unsupported
 */
export function getDownloadUrl(version: string): string {
	const platform = `${process.arch}-${process.platform}`
	const target = PLATFORM_MAP[platform]

	// Early exit: unsupported platform
	if (!target) {
		const supported = Object.keys(PLATFORM_MAP).join(", ")
		throw new SelfUpdateError(
			`Unsupported platform: ${platform}\n` + `Supported platforms: ${supported}`,
		)
	}

	const baseUrl = getDownloadBaseUrl()
	return `${baseUrl}/v${version}/${target}`
}

// =============================================================================
// DOWNLOAD
// =============================================================================

/**
 * Download binary with progress indicator.
 *
 * @param url - URL to download from
 * @param dest - Destination path for the downloaded file
 * @throws SelfUpdateError if download fails
 */
async function downloadWithProgress(url: string, dest: string): Promise<void> {
	const spin = createSpinner({ text: "Downloading update..." })
	spin.start()

	let response: Response
	try {
		response = await fetch(url, { redirect: "follow" })
	} catch (error) {
		spin.fail("Download failed")
		throw new SelfUpdateError(
			`Network error: ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	// Early exit: HTTP error
	if (!response.ok) {
		spin.fail("Download failed")
		throw new SelfUpdateError(`Failed to download: HTTP ${response.status} ${response.statusText}`)
	}

	// Early exit: no response body
	if (!response.body) {
		spin.fail("Download failed")
		throw new SelfUpdateError("Download failed: Empty response body")
	}

	const reader = response.body.getReader()
	const writer = Bun.file(dest).writer()
	const total = Number(response.headers.get("content-length") || 0)
	let received = 0

	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			await writer.write(value)
			received += value.length

			// Update progress if we know total size
			if (total > 0) {
				const pct = Math.round((received / total) * 100)
				spin.text = `Downloading... ${pct}%`
			}
		}
		await writer.end()
		spin.succeed("Download complete")
	} catch (error) {
		spin.fail("Download failed")
		await writer.end()
		throw new SelfUpdateError(
			`Download interrupted: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}

// =============================================================================
// ATOMIC REPLACEMENT
// =============================================================================

/**
 * Result of downloading binary to temp location.
 * Contains paths needed for verification and atomic swap.
 */
export interface DownloadResult {
	/** Path to the downloaded temp file */
	tempPath: string
	/** Path to current executable (swap target) */
	execPath: string
}

/**
 * Download binary to a temp file for verification before replacement.
 *
 * Strategy:
 * 1. Download to temp file (execPath.new.{timestamp})
 * 2. Set executable permissions
 * 3. Return paths for caller to verify before swap
 *
 * @param version - Version to download (without 'v' prefix)
 * @returns Paths for temp file and executable
 * @throws SelfUpdateError if download fails
 */
export async function downloadToTemp(version: string): Promise<DownloadResult> {
	const execPath = getExecutablePath()
	const tempPath = `${execPath}.new.${Date.now()}`

	const url = getDownloadUrl(version)

	// 1. Download to temp file
	await downloadWithProgress(url, tempPath)

	// 2. Set executable permissions (rwxr-xr-x)
	try {
		chmodSync(tempPath, 0o755)
	} catch (error) {
		// Clean up temp file
		if (existsSync(tempPath)) {
			unlinkSync(tempPath)
		}
		throw new SelfUpdateError(
			`Failed to set permissions: ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	return { tempPath, execPath }
}

/**
 * Atomically replace the current binary with a verified temp file.
 *
 * Strategy:
 * 1. Backup current binary (execPath.backup)
 * 2. Atomic rename temp -> execPath
 * 3. Remove backup on success
 * 4. Rollback from backup on failure
 *
 * SECURITY: Only call this AFTER verifying the temp file's checksum.
 *
 * @param tempPath - Path to the verified temp binary
 * @param execPath - Path to the current executable
 * @throws SelfUpdateError if replacement fails
 */
export function atomicReplace(tempPath: string, execPath: string): void {
	const backupPath = `${execPath}.backup`

	try {
		// Backup existing binary
		if (existsSync(execPath)) {
			renameSync(execPath, backupPath)
		}

		// Move new binary into place
		renameSync(tempPath, execPath)

		// Success - remove backup
		if (existsSync(backupPath)) {
			unlinkSync(backupPath)
		}
	} catch (error) {
		// Rollback: restore backup if it exists and execPath is missing
		if (existsSync(backupPath) && !existsSync(execPath)) {
			try {
				renameSync(backupPath, execPath)
			} catch {
				// Rollback failed - leave backup in place for manual recovery
			}
		}

		// Clean up temp file if it still exists
		if (existsSync(tempPath)) {
			try {
				unlinkSync(tempPath)
			} catch {
				// Ignore cleanup errors
			}
		}

		throw new SelfUpdateError(
			`Update failed: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}

/**
 * Clean up a temp file after verification failure.
 *
 * @param tempPath - Path to the temp file to remove
 */
export function cleanupTempFile(tempPath: string): void {
	if (existsSync(tempPath)) {
		try {
			unlinkSync(tempPath)
		} catch {
			// Ignore cleanup errors
		}
	}
}

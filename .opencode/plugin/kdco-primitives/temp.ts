/**
 * Temp directory utilities.
 *
 * Provides a reliable temp directory path that resolves symlinks,
 * which is critical on macOS where os.tmpdir() returns a symlink.
 *
 * @module kdco-primitives/temp
 */

import * as fsSync from "node:fs"
import * as os from "node:os"

/**
 * Get the real temp directory path, resolving symlinks.
 *
 * This is critical for macOS where `os.tmpdir()` returns `/var/folders/...`
 * which is actually a symlink to `/private/var/folders/...`. Many tools
 * (including Bun's test harness, VS Code, and Eclipse Theia) need the
 * resolved real path for proper file watching and path comparisons.
 *
 * @returns The real (resolved) temp directory path
 *
 * @example
 * ```ts
 * const tempDir = getTempDir()
 * // macOS: "/private/var/folders/xx/xxxxx/T" (resolved)
 * // Linux: "/tmp" (usually not a symlink)
 * // Windows: "C:\\Users\\name\\AppData\\Local\\Temp"
 *
 * // Use for creating temp files
 * const tempFile = path.join(getTempDir(), `script-${Date.now()}.sh`)
 * ```
 */
export function getTempDir(): string {
	return fsSync.realpathSync.native(os.tmpdir())
}

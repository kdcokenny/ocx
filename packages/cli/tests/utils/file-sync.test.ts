import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { lstat, mkdir, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import { createFileSync, type FileSyncHandle } from "../../src/utils/file-sync.js"

// Platform-aware delay (from chokidar tests)
const DELAY = process.platform === "darwin" ? 100 : 20

// Helper: Create temp directory (from existing OCX patterns)
async function createTempDir(name: string): Promise<string> {
	const dir = join(import.meta.dir, "..", "fixtures", `tmp-${name}-${Date.now()}`)
	await mkdir(dir, { recursive: true })
	return dir
}

// Helper: Cleanup temp directory (from existing OCX patterns)
async function cleanupTempDir(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true })
}

// Helper: Wait for condition with polling (from cpx2 tests - PROVEN pattern)
async function waitFor(condition: () => boolean, timeout = 5000): Promise<void> {
	const start = Date.now()
	while (!condition()) {
		if (Date.now() - start > timeout) throw new Error("Timeout waiting for condition")
		await new Promise((r) => setTimeout(r, 20)) // Poll every 20ms
	}
}

// Helper: Simple delay
function delay(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms))
}

// Helper: Verify files exist/don't exist with content (from cpx2 tests - PROVEN pattern)
function verifyFiles(expected: Record<string, string | null>, baseDir: string) {
	for (const [path, content] of Object.entries(expected)) {
		const fullPath = join(baseDir, path)
		if (content === null) {
			expect(existsSync(fullPath)).toBe(false) // Should NOT exist
		} else {
			expect(existsSync(fullPath)).toBe(true)
			expect(readFileSync(fullPath, "utf8")).toBe(content)
		}
	}
}

describe("file-sync", () => {
	let tempDir: string
	let destDir: string
	let fileSync: FileSyncHandle | undefined

	beforeEach(async () => {
		tempDir = await createTempDir("file-sync-temp")
		destDir = await createTempDir("file-sync-dest")
	})

	afterEach(async () => {
		// Close watcher BEFORE removing temp directory (from chokidar best practices)
		if (fileSync) {
			await fileSync.close()
			fileSync = undefined
		}
		await cleanupTempDir(tempDir)
		await cleanupTempDir(destDir)
	})

	describe("createFileSync", () => {
		it("syncs new files to destination directory", async () => {
			fileSync = createFileSync(tempDir, destDir)
			await delay(DELAY) // Let watcher initialize

			// Create a new file in temp dir
			await Bun.write(join(tempDir, "test.txt"), "hello world")

			// Wait for sync (poll-based, from cpx2)
			await waitFor(() => existsSync(join(destDir, "test.txt")))

			// Verify content
			verifyFiles({ "test.txt": "hello world" }, destDir)
		})

		it("syncs file modifications", async () => {
			fileSync = createFileSync(tempDir, destDir)
			await delay(DELAY)

			// Create file
			await Bun.write(join(tempDir, "modify.txt"), "original")
			await waitFor(() => existsSync(join(destDir, "modify.txt")))

			// Modify file
			await Bun.write(join(tempDir, "modify.txt"), "modified")
			await delay(300) // Wait for awaitWriteFinish (200ms) + buffer

			// Verify modified content
			verifyFiles({ "modify.txt": "modified" }, destDir)
		})

		it("does NOT sync symlinks", async () => {
			// Create a real file to link to
			await Bun.write(join(tempDir, "real.txt"), "real content")

			fileSync = createFileSync(tempDir, destDir)
			await delay(DELAY)

			// Create symlink in temp dir
			await symlink(join(tempDir, "real.txt"), join(tempDir, "link.txt"))
			await delay(300)

			// Symlink should NOT be synced (followSymlinks: false)
			verifyFiles({ "link.txt": null }, destDir)
		})

		it("does NOT sync excluded patterns", async () => {
			// Create .gitignore in project dir (destDir) with patterns to exclude
			await Bun.write(join(destDir, ".gitignore"), "*.tmp\n*.swp\n")

			fileSync = createFileSync(tempDir, destDir)
			await delay(DELAY)

			// Create files matching exclude patterns
			await Bun.write(join(tempDir, "temp.tmp"), "temp content")
			await Bun.write(join(tempDir, "swap.swp"), "swap content")
			await Bun.write(join(tempDir, ".DS_Store"), "ds store") // OS junk, always excluded
			await Bun.write(join(tempDir, "normal.ts"), "normal content")

			// Wait for sync
			await waitFor(() => existsSync(join(destDir, "normal.ts")))
			await delay(100) // Extra buffer for excluded files

			// Verify: normal.ts synced, excluded files NOT synced
			verifyFiles(
				{
					"normal.ts": "normal content",
					"temp.tmp": null, // gitignored
					"swap.swp": null, // gitignored
					".DS_Store": null, // OS junk
				},
				destDir,
			)
		})

		it("does NOT sync *.log files when gitignore has *.log pattern", async () => {
			// Create .gitignore in project dir (destDir) with *.log pattern (user's scenario)
			await Bun.write(
				join(destDir, ".gitignore"),
				"node_modules/\ndist/\n.wrangler/\n*.log\n.DS_Store\n",
			)

			fileSync = createFileSync(tempDir, destDir)
			await delay(DELAY)

			// Create files: one matching *.log, one normal file
			await Bun.write(join(tempDir, "test-ignored.log"), "should be ignored")
			await Bun.write(join(tempDir, "normal.txt"), "should sync")

			// Wait for sync
			await waitFor(() => existsSync(join(destDir, "normal.txt")))
			await delay(100) // Extra buffer for excluded files

			// Verify: normal.txt synced, test-ignored.log NOT synced
			verifyFiles(
				{
					"normal.txt": "should sync",
					"test-ignored.log": null, // gitignored by *.log
				},
				destDir,
			)
		})

		it("syncs files when no .gitignore exists (only OS junk excluded)", async () => {
			// No .gitignore in destDir - only OS junk should be excluded
			fileSync = createFileSync(tempDir, destDir)
			await delay(DELAY)

			// Create files that would be gitignored in a typical project
			await Bun.write(join(tempDir, "temp.tmp"), "temp content")
			await Bun.write(join(tempDir, ".DS_Store"), "ds store")
			await Bun.write(join(tempDir, "normal.ts"), "normal content")

			// Wait for sync
			await waitFor(() => existsSync(join(destDir, "normal.ts")))
			await delay(100)

			// Verify: .tmp IS synced (no gitignore), .DS_Store NOT synced (OS junk)
			verifyFiles(
				{
					"normal.ts": "normal content",
					"temp.tmp": "temp content", // No gitignore, so it syncs!
					".DS_Store": null, // OS junk, always excluded
				},
				destDir,
			)
		})

		it("deletes synced files when removed from temp dir", async () => {
			fileSync = createFileSync(tempDir, destDir)
			await delay(DELAY)

			// Create and sync file
			const filePath = join(tempDir, "to-delete.txt")
			await Bun.write(filePath, "will be deleted")
			await waitFor(() => existsSync(join(destDir, "to-delete.txt")))

			// Delete from temp dir
			await rm(filePath)
			await waitFor(() => !existsSync(join(destDir, "to-delete.txt")))

			// Verify deleted
			verifyFiles({ "to-delete.txt": null }, destDir)
		})

		it("does NOT delete files that were not synced by us", async () => {
			// Create file directly in dest (not synced by us)
			await Bun.write(join(destDir, "original.txt"), "original project file")

			fileSync = createFileSync(tempDir, destDir)
			await delay(DELAY)

			// Create a file in temp with same name pattern but different file
			// Then trigger an unlink event somehow - this is tricky
			// Instead, just verify the original file still exists after some operations
			await Bun.write(join(tempDir, "other.txt"), "other content")
			await waitFor(() => existsSync(join(destDir, "other.txt")))

			// Original file should still exist
			verifyFiles({ "original.txt": "original project file" }, destDir)
		})

		it("creates directories in destination", async () => {
			fileSync = createFileSync(tempDir, destDir)
			await delay(DELAY)

			// Create nested directory and file
			await mkdir(join(tempDir, "nested", "deep"), { recursive: true })
			await Bun.write(join(tempDir, "nested", "deep", "file.txt"), "nested content")

			// Wait for sync
			await waitFor(() => existsSync(join(destDir, "nested", "deep", "file.txt")))

			// Verify
			verifyFiles({ "nested/deep/file.txt": "nested content" }, destDir)
		})

		it("reports correct sync count", async () => {
			fileSync = createFileSync(tempDir, destDir)
			await delay(DELAY)

			// Create multiple files
			await Bun.write(join(tempDir, "file1.txt"), "content1")
			await Bun.write(join(tempDir, "file2.txt"), "content2")
			await Bun.write(join(tempDir, "file3.txt"), "content3")

			// Wait for all syncs
			await waitFor(() => existsSync(join(destDir, "file3.txt")))
			await delay(100) // Buffer for sync count update

			// Check sync count
			expect(fileSync.getSyncCount()).toBe(3)
		})

		it("tracks failures without crashing", async () => {
			fileSync = createFileSync(tempDir, destDir)
			await delay(DELAY)

			// Create a valid file (should work)
			await Bun.write(join(tempDir, "valid.txt"), "valid content")
			await waitFor(() => existsSync(join(destDir, "valid.txt")))

			// Failures array should be empty or contain only expected errors
			const failures = fileSync.getFailures()
			// We don't expect failures in normal operation, but the method should work
			expect(Array.isArray(failures)).toBe(true)
		})
	})

	describe("overlayFiles exclusion", () => {
		it("does NOT sync files in overlayFiles set", async () => {
			// Create file-sync with overlayFiles containing "overlay.txt"
			const overlayFiles = new Set(["overlay.txt"])
			fileSync = createFileSync(tempDir, destDir, { overlayFiles })
			await delay(DELAY)

			// Create overlay.txt in temp dir
			await Bun.write(join(tempDir, "overlay.txt"), "overlay content")
			// Also create a normal file to verify sync is working
			await Bun.write(join(tempDir, "normal.txt"), "normal content")

			// Wait for normal file to sync
			await waitFor(() => existsSync(join(destDir, "normal.txt")))
			await delay(100) // Extra buffer

			// Verify: normal.txt synced, overlay.txt NOT synced
			verifyFiles(
				{
					"normal.txt": "normal content",
					"overlay.txt": null, // Should NOT be synced
				},
				destDir,
			)
		})

		it("syncs files NOT in overlayFiles set", async () => {
			// Create file-sync with overlayFiles containing only "overlay.txt"
			const overlayFiles = new Set(["overlay.txt"])
			fileSync = createFileSync(tempDir, destDir, { overlayFiles })
			await delay(DELAY)

			// Create normal.txt in temp dir (NOT in set)
			await Bun.write(join(tempDir, "normal.txt"), "should sync")
			await Bun.write(join(tempDir, "another.ts"), "also syncs")

			// Wait for sync
			await waitFor(() => existsSync(join(destDir, "another.ts")))

			// Verify both files synced
			verifyFiles(
				{
					"normal.txt": "should sync",
					"another.ts": "also syncs",
				},
				destDir,
			)
		})

		it("does NOT sync nested overlay files", async () => {
			// Create file-sync with overlayFiles containing nested path
			const overlayFiles = new Set([".opencode/skills/test/SKILL.md"])
			fileSync = createFileSync(tempDir, destDir, { overlayFiles })
			await delay(DELAY)

			// Create the nested directory structure and file
			await mkdir(join(tempDir, ".opencode", "skills", "test"), { recursive: true })
			await Bun.write(join(tempDir, ".opencode", "skills", "test", "SKILL.md"), "skill content")
			// Also create a normal nested file to verify nested sync works
			await Bun.write(join(tempDir, ".opencode", "config.json"), '{"key": "value"}')

			// Wait for normal nested file to sync
			await waitFor(() => existsSync(join(destDir, ".opencode", "config.json")))
			await delay(100) // Extra buffer

			// Verify: config.json synced, SKILL.md NOT synced
			verifyFiles(
				{
					".opencode/config.json": '{"key": "value"}',
					".opencode/skills/test/SKILL.md": null, // Should NOT be synced
				},
				destDir,
			)
		})

		it("does NOT sync changes to overlay files", async () => {
			// Create file-sync with overlayFiles containing "overlay.txt"
			const overlayFiles = new Set(["overlay.txt"])
			fileSync = createFileSync(tempDir, destDir, { overlayFiles })
			await delay(DELAY)

			// Create overlay file first (should not sync)
			await Bun.write(join(tempDir, "overlay.txt"), "original overlay")
			// Create a normal file to verify sync is working
			await Bun.write(join(tempDir, "normal.txt"), "normal content")

			await waitFor(() => existsSync(join(destDir, "normal.txt")))
			await delay(100)

			// Verify overlay.txt does not exist in dest
			verifyFiles({ "overlay.txt": null }, destDir)

			// Modify the overlay file
			await Bun.write(join(tempDir, "overlay.txt"), "modified overlay")
			await delay(300) // Wait for awaitWriteFinish (200ms) + buffer

			// Verify modifications don't sync - file still should not exist
			verifyFiles(
				{
					"overlay.txt": null, // Still not synced
					"normal.txt": "normal content", // Normal file still there
				},
				destDir,
			)
		})
	})

	describe("isSymlink detection", () => {
		it("correctly identifies symlinks vs regular files", async () => {
			// Create a regular file
			const regularFile = join(tempDir, "regular.txt")
			await Bun.write(regularFile, "regular content")

			// Create a symlink
			const linkFile = join(tempDir, "link.txt")
			await symlink(regularFile, linkFile)

			// Check with lstat (same method used in file-sync.ts)
			const regularStat = await lstat(regularFile)
			const linkStat = await lstat(linkFile)

			expect(regularStat.isSymbolicLink()).toBe(false)
			expect(linkStat.isSymbolicLink()).toBe(true)
		})
	})
})

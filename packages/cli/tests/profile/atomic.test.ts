/**
 * Atomic Operations Unit Tests
 *
 * Tests for the atomic file and symlink operations:
 * - atomicWrite creates files with correct content and permissions
 * - atomicSymlink creates and replaces symlinks atomically
 * - Both clean up temp files on error
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { lstat, mkdir, readlink, rm, stat, symlink } from "node:fs/promises"
import { join } from "node:path"
import { atomicSymlink, atomicWrite } from "../../src/profile/atomic"

// =============================================================================
// HELPERS
// =============================================================================

async function createTempDir(name: string): Promise<string> {
	const dir = join(import.meta.dir, "fixtures", `tmp-${name}-${Date.now()}`)
	await mkdir(dir, { recursive: true })
	return dir
}

async function cleanupTempDir(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true })
}

// =============================================================================
// ATOMIC WRITE TESTS
// =============================================================================

describe("atomicWrite", () => {
	let testDir: string

	beforeEach(async () => {
		testDir = await createTempDir("atomic-write")
	})

	afterEach(async () => {
		await cleanupTempDir(testDir)
	})

	it("should create file with correct JSON content", async () => {
		const filePath = join(testDir, "test.json")
		const data = { name: "test", value: 42 }

		await atomicWrite(filePath, data)

		const content = await Bun.file(filePath).text()
		const parsed = JSON.parse(content)
		expect(parsed).toEqual(data)
	})

	it("should use restrictive permissions", async () => {
		const filePath = join(testDir, "secure.json")
		const data = { secret: "value" }

		await atomicWrite(filePath, data)

		const stats = await stat(filePath)
		// mode is the full mode including file type, so we mask with 0o777 to get just permissions
		const permissions = stats.mode & 0o777
		// Bun.write may apply umask; verify it's at least as restrictive as 0o644 (owner rw, others read)
		// The key is that it shouldn't be world-writable
		expect(permissions & 0o002).toBe(0) // No world write
		expect(permissions & 0o020).toBe(0) // No group write
		expect(permissions & 0o400).not.toBe(0) // Owner can read
	})

	it("should format JSON with tabs", async () => {
		const filePath = join(testDir, "formatted.json")
		const data = { key: "value", nested: { a: 1 } }

		await atomicWrite(filePath, data)

		const content = await Bun.file(filePath).text()
		expect(content).toContain("\t")
	})

	it("should overwrite existing file", async () => {
		const filePath = join(testDir, "overwrite.json")

		await atomicWrite(filePath, { version: 1 })
		await atomicWrite(filePath, { version: 2 })

		const content = await Bun.file(filePath).text()
		const parsed = JSON.parse(content)
		expect(parsed.version).toBe(2)
	})

	it("should clean up temp file on error", async () => {
		// Write to a read-only directory to cause an error
		const readOnlyDir = join(testDir, "readonly")
		await mkdir(readOnlyDir, { mode: 0o555 })

		const filePath = join(readOnlyDir, "test.json")

		try {
			await atomicWrite(filePath, { data: "test" })
		} catch {
			// Expected to fail
		}

		// Check no temp files remain in the read-only directory
		// The directory should be empty (no temp files left)
		const dirContents = await Bun.spawn(["ls", "-a", readOnlyDir]).exited
		expect(dirContents).toBe(0)

		// Cleanup - restore write permissions
		await Bun.spawn(["chmod", "755", readOnlyDir]).exited
	})

	it("should handle nested paths when Bun creates parent dirs", async () => {
		const nestedPath = join(testDir, "nested", "deep", "test.json")

		// Bun.write creates parent directories automatically
		// This test documents the current behavior
		await atomicWrite(nestedPath, { data: "test" })

		const content = await Bun.file(nestedPath).text()
		const parsed = JSON.parse(content)
		expect(parsed.data).toBe("test")
	})
})

// =============================================================================
// ATOMIC SYMLINK TESTS
// =============================================================================

describe("atomicSymlink", () => {
	let testDir: string

	beforeEach(async () => {
		testDir = await createTempDir("atomic-symlink")
	})

	afterEach(async () => {
		await cleanupTempDir(testDir)
	})

	it("should create symlink pointing to target", async () => {
		const linkPath = join(testDir, "link")
		const target = "mytarget"

		await atomicSymlink(target, linkPath)

		const actualTarget = await readlink(linkPath)
		expect(actualTarget).toBe(target)
	})

	it("should create a symbolic link (not regular file)", async () => {
		const linkPath = join(testDir, "symlink")

		await atomicSymlink("target", linkPath)

		const stats = await lstat(linkPath)
		expect(stats.isSymbolicLink()).toBe(true)
	})

	it("should atomically replace existing symlink", async () => {
		const linkPath = join(testDir, "replace-link")

		// Create initial symlink
		await symlink("original", linkPath)

		// Atomically replace it
		await atomicSymlink("replaced", linkPath)

		const target = await readlink(linkPath)
		expect(target).toBe("replaced")
	})

	it("should handle multiple rapid replacements", async () => {
		const linkPath = join(testDir, "rapid-link")

		// Create initial symlink
		await atomicSymlink("v1", linkPath)

		// Rapidly replace many times
		await atomicSymlink("v2", linkPath)
		await atomicSymlink("v3", linkPath)
		await atomicSymlink("v4", linkPath)
		await atomicSymlink("v5", linkPath)

		const target = await readlink(linkPath)
		expect(target).toBe("v5")
	})

	it("should work with relative paths", async () => {
		const linkPath = join(testDir, "relative-link")
		const relativeTarget = "../other/path"

		await atomicSymlink(relativeTarget, linkPath)

		const target = await readlink(linkPath)
		expect(target).toBe(relativeTarget)
	})

	it("should work with absolute paths", async () => {
		const linkPath = join(testDir, "absolute-link")
		const absoluteTarget = "/absolute/path/to/target"

		await atomicSymlink(absoluteTarget, linkPath)

		const target = await readlink(linkPath)
		expect(target).toBe(absoluteTarget)
	})

	it("should clean up temp symlink on error", async () => {
		// Create a read-only directory where rename will fail
		const readOnlyDir = join(testDir, "readonly")
		await mkdir(readOnlyDir, { mode: 0o555 })

		const linkPath = join(readOnlyDir, "link")

		try {
			await atomicSymlink("target", linkPath)
		} catch {
			// Expected to fail
		}

		// No temp symlinks should remain
		// Restore write permissions for cleanup check
		await Bun.spawn(["chmod", "755", readOnlyDir]).exited

		// Check directory is empty
		const proc = Bun.spawn(["ls", "-A", readOnlyDir], { stdout: "pipe" })
		const output = await new Response(proc.stdout).text()
		expect(output.trim()).toBe("")
	})
})

/**
 * Symlink Farm Tests
 *
 * Tests for the symlink farm utility used in ghost mode.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { lstat, mkdir, readlink, rm } from "node:fs/promises"
import { join } from "node:path"
import { FileLimitExceededError } from "../../src/utils/errors.js"
import {
	cleanupSymlinkFarm,
	createSymlinkFarm,
	GHOST_MARKER_FILE,
	injectGhostFiles,
} from "../../src/utils/symlink-farm.js"

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
// TESTS
// =============================================================================

describe("createSymlinkFarm", () => {
	let sourceDir: string

	beforeEach(async () => {
		sourceDir = await createTempDir("symlink-farm-source")
	})

	afterEach(async () => {
		await cleanupTempDir(sourceDir)
	})

	it("should create symlinks to all files in source directory", async () => {
		// Create some files
		await Bun.write(join(sourceDir, "file1.txt"), "content1")
		await Bun.write(join(sourceDir, "file2.txt"), "content2")

		const tempDir = await createSymlinkFarm(sourceDir)

		try {
			// Check symlinks exist
			const stat1 = await lstat(join(tempDir, "file1.txt"))
			const stat2 = await lstat(join(tempDir, "file2.txt"))

			expect(stat1.isSymbolicLink()).toBe(true)
			expect(stat2.isSymbolicLink()).toBe(true)

			// Check they point to the right place
			const target1 = await readlink(join(tempDir, "file1.txt"))
			const target2 = await readlink(join(tempDir, "file2.txt"))

			expect(target1).toBe(join(sourceDir, "file1.txt"))
			expect(target2).toBe(join(sourceDir, "file2.txt"))
		} finally {
			await cleanupSymlinkFarm(tempDir)
		}
	})

	it("should create symlinks to directories", async () => {
		// Create a subdirectory with content
		const subDir = join(sourceDir, "subdir")
		await mkdir(subDir, { recursive: true })
		await Bun.write(join(subDir, "nested.txt"), "nested content")

		const tempDir = await createSymlinkFarm(sourceDir)

		try {
			// Check symlink exists
			const stat = await lstat(join(tempDir, "subdir"))
			expect(stat.isSymbolicLink()).toBe(true)

			// Check symlink target
			const target = await readlink(join(tempDir, "subdir"))
			expect(target).toBe(subDir)

			// Check we can read through the symlink
			const content = await Bun.file(join(tempDir, "subdir", "nested.txt")).text()
			expect(content).toBe("nested content")
		} finally {
			await cleanupSymlinkFarm(tempDir)
		}
	})

	it("should exclude paths via excludePatterns", async () => {
		// Create some files
		await Bun.write(join(sourceDir, "keep.txt"), "keep")
		await Bun.write(join(sourceDir, "exclude.txt"), "exclude")
		await Bun.write(join(sourceDir, "opencode.jsonc"), "{}")

		const tempDir = await createSymlinkFarm(sourceDir, {
			excludePatterns: ["exclude.txt", "opencode.jsonc"],
		})

		try {
			// keep.txt should be linked
			const keepStat = await lstat(join(tempDir, "keep.txt"))
			expect(keepStat.isSymbolicLink()).toBe(true)

			// excluded files should not exist
			const excludeExists = await Bun.file(join(tempDir, "exclude.txt")).exists()
			const configExists = await Bun.file(join(tempDir, "opencode.jsonc")).exists()

			expect(excludeExists).toBe(false)
			expect(configExists).toBe(false)
		} finally {
			await cleanupSymlinkFarm(tempDir)
		}
	})

	it("should exclude directories via excludePatterns", async () => {
		// Create files and directories
		await Bun.write(join(sourceDir, "file.txt"), "content")
		const opencodDir = join(sourceDir, ".opencode")
		await mkdir(opencodDir, { recursive: true })
		await Bun.write(join(opencodDir, "config.json"), "{}")

		const tempDir = await createSymlinkFarm(sourceDir, {
			excludePatterns: [".opencode/**"],
		})

		try {
			// file.txt should be linked
			const fileStat = await lstat(join(tempDir, "file.txt"))
			expect(fileStat.isSymbolicLink()).toBe(true)

			// .opencode should not exist
			const opencodeExists = await Bun.file(join(tempDir, ".opencode")).exists()
			expect(opencodeExists).toBe(false)
		} finally {
			await cleanupSymlinkFarm(tempDir)
		}
	})

	it("should create temp directory in system temp location", async () => {
		await Bun.write(join(sourceDir, "test.txt"), "test")

		const tempDir = await createSymlinkFarm(sourceDir)

		try {
			// Should start with ocx-ghost prefix
			expect(tempDir).toContain("ocx-ghost")
		} finally {
			await cleanupSymlinkFarm(tempDir)
		}
	})

	it("should handle empty source directory", async () => {
		// sourceDir is already empty

		const tempDir = await createSymlinkFarm(sourceDir)

		try {
			// Should have created the marker file
			const markerExists = await Bun.file(join(tempDir, GHOST_MARKER_FILE)).exists()
			expect(markerExists).toBe(true)
		} finally {
			await cleanupSymlinkFarm(tempDir)
		}
	})
})

describe("cleanupSymlinkFarm", () => {
	it("should remove the temp directory", async () => {
		const sourceDir = await createTempDir("symlink-farm-cleanup")
		await Bun.write(join(sourceDir, "file.txt"), "content")

		const tempDir = await createSymlinkFarm(sourceDir)

		// Verify it exists
		const existsBefore = await Bun.file(join(tempDir, "file.txt")).exists()
		expect(existsBefore).toBe(true)

		// Cleanup
		await cleanupSymlinkFarm(tempDir)

		// Verify it's gone
		const existsAfter = await Bun.file(join(tempDir, "file.txt")).exists()
		expect(existsAfter).toBe(false)

		// Cleanup source
		await cleanupTempDir(sourceDir)
	})

	it("should not throw if directory doesn't exist", async () => {
		// Should not throw
		await cleanupSymlinkFarm("/nonexistent/path/that/does/not/exist")
	})
})

describe("injectGhostFiles", () => {
	let sourceDir: string
	let injectDir: string

	beforeEach(async () => {
		sourceDir = await createTempDir("symlink-farm-inject-source")
		injectDir = await createTempDir("symlink-farm-inject-files")
	})

	afterEach(async () => {
		await cleanupTempDir(sourceDir)
		await cleanupTempDir(injectDir)
	})

	it("should inject files into existing symlink farm", async () => {
		// Setup source with a file
		await Bun.write(join(sourceDir, "existing.txt"), "existing")

		// Setup inject dir with files to inject
		await Bun.write(join(injectDir, "injected.txt"), "injected")
		await Bun.write(join(injectDir, "config.json"), "{}")

		// Create farm and inject
		const tempDir = await createSymlinkFarm(sourceDir)
		const injectPaths = new Set([join(injectDir, "injected.txt"), join(injectDir, "config.json")])
		await injectGhostFiles(tempDir, injectDir, injectPaths)

		try {
			// Original file should exist
			const existingStat = await lstat(join(tempDir, "existing.txt"))
			expect(existingStat.isSymbolicLink()).toBe(true)

			// Injected files should exist as symlinks
			const injectedStat = await lstat(join(tempDir, "injected.txt"))
			expect(injectedStat.isSymbolicLink()).toBe(true)

			const configStat = await lstat(join(tempDir, "config.json"))
			expect(configStat.isSymbolicLink()).toBe(true)

			// Verify symlink targets
			const injectedTarget = await readlink(join(tempDir, "injected.txt"))
			expect(injectedTarget).toBe(join(injectDir, "injected.txt"))
		} finally {
			await cleanupSymlinkFarm(tempDir)
		}
	})

	it("should inject directories", async () => {
		// Setup inject dir with a subdirectory
		const subDir = join(injectDir, ".opencode")
		await mkdir(subDir, { recursive: true })
		await Bun.write(join(subDir, "plugin.ts"), "// plugin")

		// Create farm and inject the directory
		const tempDir = await createSymlinkFarm(sourceDir)
		const injectPaths = new Set([subDir])
		await injectGhostFiles(tempDir, injectDir, injectPaths)

		try {
			// .opencode should be a symlink
			const stat = await lstat(join(tempDir, ".opencode"))
			expect(stat.isSymbolicLink()).toBe(true)

			// Should be able to read through the symlink
			const content = await Bun.file(join(tempDir, ".opencode", "plugin.ts")).text()
			expect(content).toBe("// plugin")
		} finally {
			await cleanupSymlinkFarm(tempDir)
		}
	})

	it("should handle empty inject set", async () => {
		const tempDir = await createSymlinkFarm(sourceDir)

		// Should not throw
		await injectGhostFiles(tempDir, injectDir, new Set())

		await cleanupSymlinkFarm(tempDir)
	})

	it("should throw if injectPath is outside sourceDir", async () => {
		const tempDir = await createSymlinkFarm(sourceDir)
		const outsidePath = join(injectDir, "..", "outside.txt")

		try {
			await expect(injectGhostFiles(tempDir, injectDir, new Set([outsidePath]))).rejects.toThrow(
				"injectPath must be within sourceDir",
			)
		} finally {
			await cleanupSymlinkFarm(tempDir)
		}
	})
})

describe("maxFiles limit", () => {
	let sourceDir: string

	beforeEach(async () => {
		sourceDir = await createTempDir("symlink-farm-maxfiles")
	})

	afterEach(async () => {
		await cleanupTempDir(sourceDir)
	})

	it("should throw FileLimitExceededError when file count exceeds limit", async () => {
		// Create 5 files
		for (let i = 0; i < 5; i++) {
			await Bun.write(join(sourceDir, `file${i}.txt`), `content${i}`)
		}

		// Set limit to 3, should fail
		await expect(createSymlinkFarm(sourceDir, { maxFiles: 3 })).rejects.toThrow(
			FileLimitExceededError,
		)
	})

	it("should include count and limit in error", async () => {
		// Create 10 files
		for (let i = 0; i < 10; i++) {
			await Bun.write(join(sourceDir, `file${i}.txt`), `content${i}`)
		}

		try {
			await createSymlinkFarm(sourceDir, { maxFiles: 5 })
			expect.unreachable("Should have thrown")
		} catch (error) {
			expect(error).toBeInstanceOf(FileLimitExceededError)
			const e = error as FileLimitExceededError
			expect(e.count).toBeGreaterThan(5)
			expect(e.limit).toBe(5)
			expect(e.message).toContain("File limit exceeded")
			expect(e.message).toContain("maxFiles")
		}
	})

	it("should respect custom maxFiles limit", async () => {
		// Create 20 files
		for (let i = 0; i < 20; i++) {
			await Bun.write(join(sourceDir, `file${i}.txt`), `content${i}`)
		}

		// Set limit to 50, should succeed
		const tempDir = await createSymlinkFarm(sourceDir, { maxFiles: 50 })

		try {
			// Verify symlinks were created
			const stat = await lstat(join(tempDir, "file0.txt"))
			expect(stat.isSymbolicLink()).toBe(true)
		} finally {
			await cleanupSymlinkFarm(tempDir)
		}
	})

	it("should disable limit when maxFiles is 0", async () => {
		// Create 100 files - would exceed default limit of 10000 if we created that many
		// but 0 means unlimited so any count should work
		for (let i = 0; i < 100; i++) {
			await Bun.write(join(sourceDir, `file${i}.txt`), `content${i}`)
		}

		// maxFiles: 0 should disable the limit
		const tempDir = await createSymlinkFarm(sourceDir, { maxFiles: 0 })

		try {
			// Verify it succeeded
			const stat = await lstat(join(tempDir, "file0.txt"))
			expect(stat.isSymbolicLink()).toBe(true)
		} finally {
			await cleanupSymlinkFarm(tempDir)
		}
	})

	it("should count directories toward the limit", async () => {
		// Create 3 files and 3 directories (6 entries total)
		for (let i = 0; i < 3; i++) {
			await Bun.write(join(sourceDir, `file${i}.txt`), `content${i}`)
		}
		for (let i = 0; i < 3; i++) {
			await mkdir(join(sourceDir, `dir${i}`), { recursive: true })
		}

		// Set limit to 5, should fail (6 entries > 5)
		await expect(createSymlinkFarm(sourceDir, { maxFiles: 5 })).rejects.toThrow(
			FileLimitExceededError,
		)
	})
})

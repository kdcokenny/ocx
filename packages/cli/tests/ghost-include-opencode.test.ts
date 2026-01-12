/**
 * Integration Test: Pattern-based filtering for symlink farm
 *
 * This test verifies that include/exclude patterns work correctly with
 * the plan-based symlink farm approach.
 *
 * The key behavior:
 * - excludePatterns: Skip matching paths
 * - includePatterns: Only include matching paths (whitelist mode)
 * - Both patterns work with glob syntax via picomatch
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { lstat, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { cleanupSymlinkFarm, createSymlinkFarm } from "../src/utils/symlink-farm.js"

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

/**
 * Check if a path exists in the symlink farm (follows symlinks).
 */
async function existsInFarm(farmPath: string, relativePath: string): Promise<boolean> {
	try {
		await lstat(join(farmPath, relativePath))
		return true
	} catch {
		return false
	}
}

// =============================================================================
// INTEGRATION TESTS: Exclude patterns
// =============================================================================

describe("exclude patterns", () => {
	let projectDir: string
	let symlinkFarm: { tempDir: string; symlinkRoots: Set<string> } | null = null

	beforeEach(async () => {
		projectDir = await createTempDir("exclude-patterns")

		// Create project structure:
		// project/
		//   .opencode/
		//     skill/
		//       qualification/SKILL.md
		//       pipeline/SKILL.md
		//     command/
		//       foo.md
		//   src/
		//     index.ts

		await mkdir(join(projectDir, ".opencode", "skill", "qualification"), { recursive: true })
		await mkdir(join(projectDir, ".opencode", "skill", "pipeline"), { recursive: true })
		await mkdir(join(projectDir, ".opencode", "command"), { recursive: true })
		await mkdir(join(projectDir, "src"), { recursive: true })

		await Bun.write(
			join(projectDir, ".opencode", "skill", "qualification", "SKILL.md"),
			"# Qualification",
		)
		await Bun.write(join(projectDir, ".opencode", "skill", "pipeline", "SKILL.md"), "# Pipeline")
		await Bun.write(join(projectDir, ".opencode", "command", "foo.md"), "# Foo Command")
		await Bun.write(join(projectDir, "src", "index.ts"), "export {}")
	})

	afterEach(async () => {
		if (symlinkFarm) {
			await cleanupSymlinkFarm(symlinkFarm.tempDir)
			symlinkFarm = null
		}
		await cleanupTempDir(projectDir)
	})

	it("should exclude .opencode directory with excludePatterns", async () => {
		symlinkFarm = await createSymlinkFarm(projectDir, {
			excludePatterns: [".opencode", ".opencode/**"],
		})

		// src/ should be visible
		expect(await existsInFarm(symlinkFarm.tempDir, "src")).toBe(true)
		expect(await existsInFarm(symlinkFarm.tempDir, "src/index.ts")).toBe(true)

		// .opencode should NOT be visible (excluded)
		expect(await existsInFarm(symlinkFarm.tempDir, ".opencode")).toBe(false)
	})

	it("should exclude specific subdirectories with proper patterns", async () => {
		symlinkFarm = await createSymlinkFarm(projectDir, {
			// Note: To exclude a directory AND its contents, need both patterns
			// ".opencode/command" matches the directory itself
			// ".opencode/command/**" matches its contents
			excludePatterns: [".opencode/command", ".opencode/command/**"],
		})

		// src/ should be visible
		expect(await existsInFarm(symlinkFarm.tempDir, "src")).toBe(true)

		// .opencode and skill/ should be visible
		expect(await existsInFarm(symlinkFarm.tempDir, ".opencode")).toBe(true)
		expect(await existsInFarm(symlinkFarm.tempDir, ".opencode/skill")).toBe(true)
		expect(await existsInFarm(symlinkFarm.tempDir, ".opencode/skill/qualification")).toBe(true)

		// command/ should NOT be visible (excluded by ".opencode/command" pattern)
		expect(await existsInFarm(symlinkFarm.tempDir, ".opencode/command")).toBe(false)
	})

	it("should include everything when no patterns specified", async () => {
		symlinkFarm = await createSymlinkFarm(projectDir)

		// Everything should be visible
		expect(await existsInFarm(symlinkFarm.tempDir, "src")).toBe(true)
		expect(await existsInFarm(symlinkFarm.tempDir, ".opencode")).toBe(true)
		expect(await existsInFarm(symlinkFarm.tempDir, ".opencode/skill")).toBe(true)
		expect(await existsInFarm(symlinkFarm.tempDir, ".opencode/command")).toBe(true)
	})
})

// =============================================================================
// INTEGRATION TESTS: Include patterns (whitelist mode)
// =============================================================================

describe("include patterns (whitelist mode)", () => {
	let projectDir: string
	let symlinkFarm: { tempDir: string; symlinkRoots: Set<string> } | null = null

	beforeEach(async () => {
		projectDir = await createTempDir("include-patterns")

		// Create project structure:
		// project/
		//   .opencode/
		//     skill/
		//       qualification/SKILL.md
		//       pipeline/SKILL.md
		//       other/SKILL.md
		//     command/
		//       foo.md
		//   src/
		//     index.ts

		await mkdir(join(projectDir, ".opencode", "skill", "qualification"), { recursive: true })
		await mkdir(join(projectDir, ".opencode", "skill", "pipeline"), { recursive: true })
		await mkdir(join(projectDir, ".opencode", "skill", "other"), { recursive: true })
		await mkdir(join(projectDir, ".opencode", "command"), { recursive: true })
		await mkdir(join(projectDir, "src"), { recursive: true })

		await Bun.write(
			join(projectDir, ".opencode", "skill", "qualification", "SKILL.md"),
			"# Qualification",
		)
		await Bun.write(join(projectDir, ".opencode", "skill", "pipeline", "SKILL.md"), "# Pipeline")
		await Bun.write(join(projectDir, ".opencode", "skill", "other", "SKILL.md"), "# Other")
		await Bun.write(join(projectDir, ".opencode", "command", "foo.md"), "# Foo Command")
		await Bun.write(join(projectDir, "src", "index.ts"), "export {}")
	})

	afterEach(async () => {
		if (symlinkFarm) {
			await cleanupSymlinkFarm(symlinkFarm.tempDir)
			symlinkFarm = null
		}
		await cleanupTempDir(projectDir)
	})

	it("should include only paths matching include patterns", async () => {
		symlinkFarm = await createSymlinkFarm(projectDir, {
			includePatterns: ["src/**"],
		})

		// src/ should be visible (matches pattern)
		expect(await existsInFarm(symlinkFarm.tempDir, "src")).toBe(true)
		expect(await existsInFarm(symlinkFarm.tempDir, "src/index.ts")).toBe(true)

		// .opencode should NOT be visible (not in include patterns)
		expect(await existsInFarm(symlinkFarm.tempDir, ".opencode")).toBe(false)
	})

	it("should include specific skills from .opencode via patterns", async () => {
		symlinkFarm = await createSymlinkFarm(projectDir, {
			includePatterns: [
				"src/**",
				".opencode/skill/qualification/**",
				".opencode/skill/pipeline/**",
			],
		})

		// src/ should be visible
		expect(await existsInFarm(symlinkFarm.tempDir, "src")).toBe(true)

		// .opencode should exist (partial expansion for nested patterns)
		expect(await existsInFarm(symlinkFarm.tempDir, ".opencode")).toBe(true)

		// qualification/ and pipeline/ should be visible
		expect(await existsInFarm(symlinkFarm.tempDir, ".opencode/skill/qualification")).toBe(true)
		expect(await existsInFarm(symlinkFarm.tempDir, ".opencode/skill/qualification/SKILL.md")).toBe(
			true,
		)
		expect(await existsInFarm(symlinkFarm.tempDir, ".opencode/skill/pipeline")).toBe(true)
		expect(await existsInFarm(symlinkFarm.tempDir, ".opencode/skill/pipeline/SKILL.md")).toBe(true)

		// other/ and command/ should NOT be visible (not in include patterns)
		expect(await existsInFarm(symlinkFarm.tempDir, ".opencode/skill/other")).toBe(false)
		expect(await existsInFarm(symlinkFarm.tempDir, ".opencode/command")).toBe(false)
	})

	it("should include entire .opencode when pattern is .opencode/**", async () => {
		symlinkFarm = await createSymlinkFarm(projectDir, {
			includePatterns: ["src/**", ".opencode/**"],
		})

		// Everything should be visible
		expect(await existsInFarm(symlinkFarm.tempDir, "src")).toBe(true)
		expect(await existsInFarm(symlinkFarm.tempDir, ".opencode")).toBe(true)
		expect(await existsInFarm(symlinkFarm.tempDir, ".opencode/skill")).toBe(true)
		expect(await existsInFarm(symlinkFarm.tempDir, ".opencode/command")).toBe(true)
	})
})

// =============================================================================
// INTEGRATION TESTS: Include + Exclude combo
// =============================================================================

describe("include + exclude patterns combo", () => {
	let projectDir: string
	let symlinkFarm: { tempDir: string; symlinkRoots: Set<string> } | null = null

	beforeEach(async () => {
		projectDir = await createTempDir("combo-patterns")

		await mkdir(join(projectDir, ".opencode", "skill", "qualification"), { recursive: true })
		await mkdir(join(projectDir, ".opencode", "skill", "pipeline"), { recursive: true })
		await mkdir(join(projectDir, ".opencode", "skill", "other"), { recursive: true })
		await mkdir(join(projectDir, "src"), { recursive: true })

		await Bun.write(
			join(projectDir, ".opencode", "skill", "qualification", "SKILL.md"),
			"# Qualification",
		)
		await Bun.write(join(projectDir, ".opencode", "skill", "pipeline", "SKILL.md"), "# Pipeline")
		await Bun.write(join(projectDir, ".opencode", "skill", "other", "SKILL.md"), "# Other")
		await Bun.write(join(projectDir, "src", "index.ts"), "export {}")
	})

	afterEach(async () => {
		if (symlinkFarm) {
			await cleanupSymlinkFarm(symlinkFarm.tempDir)
			symlinkFarm = null
		}
		await cleanupTempDir(projectDir)
	})

	it("should allow include to override exclude (re-add from excluded set)", async () => {
		// Per schema: include "re-adds files from the excluded set"
		// So even though other/ is excluded, including .opencode/skill/** brings it back
		symlinkFarm = await createSymlinkFarm(projectDir, {
			includePatterns: ["src/**", ".opencode/skill/**"],
			excludePatterns: [".opencode/skill/other", ".opencode/skill/other/**"],
		})

		// src/ should be visible
		expect(await existsInFarm(symlinkFarm.tempDir, "src")).toBe(true)

		// qualification/ and pipeline/ should be visible
		expect(await existsInFarm(symlinkFarm.tempDir, ".opencode/skill/qualification")).toBe(true)
		expect(await existsInFarm(symlinkFarm.tempDir, ".opencode/skill/pipeline")).toBe(true)

		// other/ IS visible because include overrides exclude (per schema semantics)
		// This matches the ghost mode use case where include "re-adds" excluded files
		expect(await existsInFarm(symlinkFarm.tempDir, ".opencode/skill/other")).toBe(true)
	})
})

// =============================================================================
// EDGE CASE TESTS
// =============================================================================

describe("edge cases", () => {
	let projectDir: string
	let symlinkFarm: { tempDir: string; symlinkRoots: Set<string> } | null = null

	beforeEach(async () => {
		projectDir = await createTempDir("edge-cases")
	})

	afterEach(async () => {
		if (symlinkFarm) {
			await cleanupSymlinkFarm(symlinkFarm.tempDir)
			symlinkFarm = null
		}
		await cleanupTempDir(projectDir)
	})

	it("should handle deeply nested patterns", async () => {
		await mkdir(join(projectDir, ".opencode", "skill", "category", "subcategory"), {
			recursive: true,
		})
		await mkdir(join(projectDir, ".opencode", "command"), { recursive: true })
		await mkdir(join(projectDir, "src"), { recursive: true })

		await Bun.write(
			join(projectDir, ".opencode", "skill", "category", "subcategory", "SKILL.md"),
			"# Deep Skill",
		)
		await Bun.write(join(projectDir, ".opencode", "command", "foo.md"), "# Command")
		await Bun.write(join(projectDir, "src", "index.ts"), "export {}")

		symlinkFarm = await createSymlinkFarm(projectDir, {
			includePatterns: ["src/**", ".opencode/skill/category/subcategory/**"],
		})

		// Deeply nested path should be visible
		expect(await existsInFarm(symlinkFarm.tempDir, ".opencode/skill/category/subcategory")).toBe(
			true,
		)
		expect(
			await existsInFarm(symlinkFarm.tempDir, ".opencode/skill/category/subcategory/SKILL.md"),
		).toBe(true)

		// command/ should NOT be visible (not matched by pattern)
		expect(await existsInFarm(symlinkFarm.tempDir, ".opencode/command")).toBe(false)

		// src/ should be visible
		expect(await existsInFarm(symlinkFarm.tempDir, "src")).toBe(true)
	})

	it("should handle non-existent paths gracefully", async () => {
		await mkdir(join(projectDir, ".opencode", "command"), { recursive: true })
		await mkdir(join(projectDir, "src"), { recursive: true })

		await Bun.write(join(projectDir, ".opencode", "command", "foo.md"), "# Command")
		await Bun.write(join(projectDir, "src", "index.ts"), "export {}")

		// Include pattern for path that doesn't exist - should not crash
		symlinkFarm = await createSymlinkFarm(projectDir, {
			includePatterns: ["src/**", ".opencode/skill/nonexistent/**"],
		})

		// Should complete without error
		expect(symlinkFarm).toBeTruthy()

		// src/ should be visible
		expect(await existsInFarm(symlinkFarm.tempDir, "src")).toBe(true)

		// command/ should NOT be visible (not matched by pattern)
		expect(await existsInFarm(symlinkFarm.tempDir, ".opencode/command")).toBe(false)
	})

	it("should handle empty directory gracefully", async () => {
		await mkdir(join(projectDir, ".opencode"), { recursive: true })
		await mkdir(join(projectDir, "src"), { recursive: true })

		await Bun.write(join(projectDir, "src", "index.ts"), "export {}")

		// Include pattern targeting inside empty .opencode
		symlinkFarm = await createSymlinkFarm(projectDir, {
			includePatterns: ["src/**", ".opencode/skill/**"],
		})

		// Should complete without error
		expect(symlinkFarm).toBeTruthy()

		// src/ should be visible
		expect(await existsInFarm(symlinkFarm.tempDir, "src")).toBe(true)
	})
})

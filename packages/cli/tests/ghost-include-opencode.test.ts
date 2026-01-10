/**
 * Integration Test: Include patterns for .opencode contents
 *
 * This test verifies that include patterns targeting specific
 * subdirectories of .opencode work correctly with the plan-based
 * symlink farm approach.
 *
 * The key insight: When a directory is in excludedPaths but include
 * patterns target paths inside it, createSymlinkFarm uses partial
 * directory expansion to include only matching subdirectories.
 *
 * Example: Include patterns like ".opencode/skill/qualification/**" will
 * make only those subdirectories visible while excluding others.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { lstat, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { discoverProjectFiles } from "../src/utils/opencode-discovery.js"
import { filterExcludedPaths } from "../src/utils/pattern-filter.js"
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
// INTEGRATION TESTS: Include patterns for .opencode contents
// =============================================================================

describe("ghost include patterns for .opencode contents", () => {
	let projectDir: string
	let symlinkFarm: string | null = null

	beforeEach(async () => {
		projectDir = await createTempDir("ghost-include-opencode")

		// Create project structure:
		// project/
		//   .opencode/
		//     skill/
		//       qualification/SKILL.md  ← should be included
		//       pipeline/SKILL.md       ← should be included
		//       other/SKILL.md          ← should be excluded
		//     command/
		//       foo.md                  ← should be excluded
		//   src/
		//     index.ts                  ← always visible

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
			await cleanupSymlinkFarm(symlinkFarm)
			symlinkFarm = null
		}
		await cleanupTempDir(projectDir)
	})

	it("should include only specified skills from .opencode", async () => {
		// Step 1: Discover project files (this finds .opencode directory)
		const excludedPaths = await discoverProjectFiles(projectDir, projectDir)

		// Verify .opencode was discovered
		expect(excludedPaths.has(join(projectDir, ".opencode"))).toBe(true)

		// Step 2: Define include patterns
		// We want to include only qualification and pipeline skills
		const includePatterns = [".opencode/skill/qualification/**", ".opencode/skill/pipeline/**"]

		// Step 3: Create symlink farm with include patterns
		// The plan-based approach handles partial directory expansion internally
		symlinkFarm = await createSymlinkFarm(projectDir, excludedPaths, { includePatterns })

		// Step 4: Verify expectations

		// src/ should always be visible (not an OpenCode file)
		expect(await existsInFarm(symlinkFarm, "src")).toBe(true)
		expect(await existsInFarm(symlinkFarm, "src/index.ts")).toBe(true)

		// .opencode should exist in symlink farm (partial expansion)
		const opencodeDirExists = await existsInFarm(symlinkFarm, ".opencode")
		expect(opencodeDirExists).toBe(true)

		// qualification/ and pipeline/ should be visible
		expect(await existsInFarm(symlinkFarm, ".opencode/skill/qualification")).toBe(true)
		expect(await existsInFarm(symlinkFarm, ".opencode/skill/qualification/SKILL.md")).toBe(true)
		expect(await existsInFarm(symlinkFarm, ".opencode/skill/pipeline")).toBe(true)
		expect(await existsInFarm(symlinkFarm, ".opencode/skill/pipeline/SKILL.md")).toBe(true)

		// other/ and command/ should NOT be visible (excluded)
		expect(await existsInFarm(symlinkFarm, ".opencode/skill/other")).toBe(false)
		expect(await existsInFarm(symlinkFarm, ".opencode/command")).toBe(false)
	})

	it("should fully exclude .opencode when no include patterns target it", async () => {
		// Baseline test: without include patterns, .opencode should be excluded
		const excludedPaths = await discoverProjectFiles(projectDir, projectDir)

		// Don't filter - use exclusions as-is
		symlinkFarm = await createSymlinkFarm(projectDir, excludedPaths)

		// src/ should be visible
		expect(await existsInFarm(symlinkFarm, "src")).toBe(true)

		// .opencode should NOT be visible (excluded by default)
		expect(await existsInFarm(symlinkFarm, ".opencode")).toBe(false)
	})

	it("should demonstrate the granularity mismatch in filterExcludedPaths", async () => {
		// This test documents WHY filterExcludedPaths alone can't solve partial inclusion.
		// The plan-based approach in createSymlinkFarm handles this correctly instead.
		const excludedPaths = await discoverProjectFiles(projectDir, projectDir)

		// The exclusion set contains only the directory path, not individual files
		const exclusionContents = Array.from(excludedPaths)
		expect(exclusionContents).toContain(join(projectDir, ".opencode"))

		// Include patterns that target individual files
		const includePatterns = [".opencode/skill/qualification/**"]

		// Convert to relative paths
		const excludedRelative = new Set<string>()
		for (const absPath of excludedPaths) {
			excludedRelative.add(absPath.replace(`${projectDir}/`, ""))
		}

		// filterExcludedPaths matches patterns against existing exclusion set entries.
		// The pattern ".opencode/skill/qualification/**" does NOT match ".opencode"
		// because ".opencode" is a directory name, not a file path matching the glob.
		const filteredRelative = filterExcludedPaths(excludedRelative, includePatterns, undefined)

		// ".opencode" stays in exclusions because glob doesn't match the directory name.
		// This is expected behavior for filterExcludedPaths - the plan-based approach
		// in createSymlinkFarm handles partial directory expansion correctly.
		expect(filteredRelative.has(".opencode")).toBe(true)
	})
})

// =============================================================================
// BACKWARD COMPATIBILITY TESTS
// =============================================================================

describe("backward compatibility", () => {
	let projectDir: string
	let symlinkFarm: string | null = null

	beforeEach(async () => {
		projectDir = await createTempDir("backward-compat")

		// Create project structure:
		// project/
		//   .opencode/
		//     config.json
		//   src/
		//     index.ts
		await mkdir(join(projectDir, ".opencode"), { recursive: true })
		await mkdir(join(projectDir, "src"), { recursive: true })

		await Bun.write(join(projectDir, ".opencode", "config.json"), '{"foo": "bar"}')
		await Bun.write(join(projectDir, "src", "index.ts"), "export {}")
	})

	afterEach(async () => {
		if (symlinkFarm) {
			await cleanupSymlinkFarm(symlinkFarm)
			symlinkFarm = null
		}
		await cleanupTempDir(projectDir)
	})

	it("should fully exclude .opencode when no include patterns specified", async () => {
		// No include patterns = .opencode fully excluded (current default behavior)
		const excludedPaths = await discoverProjectFiles(projectDir, projectDir)

		// Create symlink farm without any include patterns
		symlinkFarm = await createSymlinkFarm(projectDir, excludedPaths)

		// .opencode should be fully excluded
		expect(await existsInFarm(symlinkFarm, ".opencode")).toBe(false)

		// src/ should be visible (not an OpenCode file)
		expect(await existsInFarm(symlinkFarm, "src")).toBe(true)
		expect(await existsInFarm(symlinkFarm, "src/index.ts")).toBe(true)
	})

	it("should work without any patterns (original behavior)", async () => {
		// Call createSymlinkFarm without options - should behave like before
		const excludedPaths = await discoverProjectFiles(projectDir, projectDir)

		// No options object at all - original API
		symlinkFarm = await createSymlinkFarm(projectDir, excludedPaths)

		// .opencode should be excluded (original behavior)
		expect(await existsInFarm(symlinkFarm, ".opencode")).toBe(false)

		// Regular files should be visible
		expect(await existsInFarm(symlinkFarm, "src")).toBe(true)
	})

	it("should include entire .opencode when pattern is .opencode/**", async () => {
		// Pattern ".opencode/**" should include everything in .opencode
		const excludedPaths = await discoverProjectFiles(projectDir, projectDir)

		symlinkFarm = await createSymlinkFarm(projectDir, excludedPaths, {
			includePatterns: [".opencode/**"],
		})

		// .opencode should exist and contain config.json
		expect(await existsInFarm(symlinkFarm, ".opencode")).toBe(true)
		expect(await existsInFarm(symlinkFarm, ".opencode/config.json")).toBe(true)

		// src/ should also be visible
		expect(await existsInFarm(symlinkFarm, "src")).toBe(true)
	})
})

// =============================================================================
// EDGE CASE TESTS
// =============================================================================

describe("edge cases", () => {
	let projectDir: string
	let symlinkFarm: string | null = null

	beforeEach(async () => {
		projectDir = await createTempDir("edge-cases")
	})

	afterEach(async () => {
		if (symlinkFarm) {
			await cleanupSymlinkFarm(symlinkFarm)
			symlinkFarm = null
		}
		await cleanupTempDir(projectDir)
	})

	it("should handle include + exclude combo", async () => {
		// Setup:
		// .opencode/skill/qualification/SKILL.md ← should be included
		// .opencode/skill/pipeline/SKILL.md     ← should be included
		// .opencode/skill/other/SKILL.md        ← files should be excluded via exclude pattern
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

		const excludedPaths = await discoverProjectFiles(projectDir, projectDir)

		// Include all skills, but exclude files inside "other" subdirectory
		// Note: The pattern ".opencode/skill/other/**" excludes CONTENTS of other/,
		// but the directory itself may still exist (empty). To exclude the directory
		// itself, use a pattern that matches it directly.
		symlinkFarm = await createSymlinkFarm(projectDir, excludedPaths, {
			includePatterns: [".opencode/skill/**"],
			excludePatterns: [".opencode/skill/other", ".opencode/skill/other/**"],
		})

		// qualification/ and pipeline/ should be visible
		expect(await existsInFarm(symlinkFarm, ".opencode/skill/qualification")).toBe(true)
		expect(await existsInFarm(symlinkFarm, ".opencode/skill/qualification/SKILL.md")).toBe(true)
		expect(await existsInFarm(symlinkFarm, ".opencode/skill/pipeline")).toBe(true)
		expect(await existsInFarm(symlinkFarm, ".opencode/skill/pipeline/SKILL.md")).toBe(true)

		// other/ should be excluded via excludePatterns (both the dir and its contents)
		expect(await existsInFarm(symlinkFarm, ".opencode/skill/other")).toBe(false)

		// src/ should always be visible
		expect(await existsInFarm(symlinkFarm, "src")).toBe(true)
	})

	it("should handle deeply nested patterns", async () => {
		// Setup: .opencode/skill/category/subcategory/SKILL.md
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

		const excludedPaths = await discoverProjectFiles(projectDir, projectDir)

		// Include only the deeply nested path
		symlinkFarm = await createSymlinkFarm(projectDir, excludedPaths, {
			includePatterns: [".opencode/skill/category/subcategory/**"],
		})

		// Deeply nested path should be visible
		expect(await existsInFarm(symlinkFarm, ".opencode/skill/category/subcategory")).toBe(true)
		expect(await existsInFarm(symlinkFarm, ".opencode/skill/category/subcategory/SKILL.md")).toBe(
			true,
		)

		// command/ should NOT be visible (not matched by pattern)
		expect(await existsInFarm(symlinkFarm, ".opencode/command")).toBe(false)

		// src/ should be visible
		expect(await existsInFarm(symlinkFarm, "src")).toBe(true)
	})

	it("should handle non-existent paths gracefully", async () => {
		// Setup: minimal project structure without the paths mentioned in patterns
		await mkdir(join(projectDir, ".opencode", "command"), { recursive: true })
		await mkdir(join(projectDir, "src"), { recursive: true })

		await Bun.write(join(projectDir, ".opencode", "command", "foo.md"), "# Command")
		await Bun.write(join(projectDir, "src", "index.ts"), "export {}")

		const excludedPaths = await discoverProjectFiles(projectDir, projectDir)

		// Include pattern for path that doesn't exist - should not crash
		symlinkFarm = await createSymlinkFarm(projectDir, excludedPaths, {
			includePatterns: [".opencode/skill/nonexistent/**"],
		})

		// Should complete without error
		expect(symlinkFarm).toBeTruthy()

		// .opencode should exist but only have partial expansion
		// Since the pattern targets inside .opencode, it creates partial expansion
		// but nonexistent paths just won't match anything
		expect(await existsInFarm(symlinkFarm, ".opencode")).toBe(true)

		// command/ should NOT be visible (not matched by the specific pattern)
		expect(await existsInFarm(symlinkFarm, ".opencode/command")).toBe(false)

		// src/ should be visible
		expect(await existsInFarm(symlinkFarm, "src")).toBe(true)
	})

	it("should handle patterns not targeting .opencode", async () => {
		// Include patterns that don't target .opencode should not trigger partial expansion
		await mkdir(join(projectDir, ".opencode", "skill"), { recursive: true })
		await mkdir(join(projectDir, "src", "utils"), { recursive: true })
		await mkdir(join(projectDir, "docs"), { recursive: true })

		await Bun.write(join(projectDir, ".opencode", "skill", "SKILL.md"), "# Skill")
		await Bun.write(join(projectDir, "src", "utils", "helper.ts"), "export {}")
		await Bun.write(join(projectDir, "docs", "README.md"), "# Docs")

		const excludedPaths = await discoverProjectFiles(projectDir, projectDir)

		// Pattern targets src/, not .opencode - shouldn't affect .opencode exclusion
		symlinkFarm = await createSymlinkFarm(projectDir, excludedPaths, {
			includePatterns: ["src/**"],
		})

		// .opencode should remain fully excluded (pattern doesn't target it)
		expect(await existsInFarm(symlinkFarm, ".opencode")).toBe(false)

		// src/ should be visible (matches pattern, but wasn't excluded anyway)
		expect(await existsInFarm(symlinkFarm, "src")).toBe(true)
		expect(await existsInFarm(symlinkFarm, "src/utils")).toBe(true)

		// docs/ should also be visible (wasn't excluded)
		expect(await existsInFarm(symlinkFarm, "docs")).toBe(true)
	})
})

// =============================================================================
// ERROR HANDLING TESTS
// =============================================================================

describe("error handling", () => {
	let projectDir: string
	let symlinkFarm: string | null = null

	beforeEach(async () => {
		projectDir = await createTempDir("error-handling")
	})

	afterEach(async () => {
		if (symlinkFarm) {
			await cleanupSymlinkFarm(symlinkFarm)
			symlinkFarm = null
		}
		await cleanupTempDir(projectDir)
	})

	it("should handle empty .opencode directory gracefully", async () => {
		// .opencode exists but is empty
		await mkdir(join(projectDir, ".opencode"), { recursive: true })
		await mkdir(join(projectDir, "src"), { recursive: true })

		await Bun.write(join(projectDir, "src", "index.ts"), "export {}")

		const excludedPaths = await discoverProjectFiles(projectDir, projectDir)

		// Include pattern targeting inside empty .opencode
		symlinkFarm = await createSymlinkFarm(projectDir, excludedPaths, {
			includePatterns: [".opencode/skill/**"],
		})

		// Should complete without error
		expect(symlinkFarm).toBeTruthy()

		// .opencode should exist but be empty (partial expansion creates the dir)
		expect(await existsInFarm(symlinkFarm, ".opencode")).toBe(true)

		// src/ should be visible
		expect(await existsInFarm(symlinkFarm, "src")).toBe(true)
	})
})

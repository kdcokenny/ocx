import { describe, expect, it } from "bun:test"
import { createPathMatcher, filterExcludedPaths } from "../src/utils/pattern-filter.js"

describe("filterExcludedPaths", () => {
	// Test: No patterns returns original set unchanged
	it("returns original set when no include patterns provided", () => {
		const excluded = new Set(["AGENTS.md", ".opencode/skills/test.md"])
		const result = filterExcludedPaths(excluded, undefined, undefined)
		expect(result).toEqual(excluded)
	})

	it("returns original set when include patterns is empty array", () => {
		const excluded = new Set(["AGENTS.md"])
		const result = filterExcludedPaths(excluded, [], undefined)
		expect(result).toEqual(excluded)
	})

	// Test: Include pattern removes from exclusions
	it("removes matching files from exclusions when include pattern matches", () => {
		const excluded = new Set(["AGENTS.md", "opencode.jsonc"])
		const result = filterExcludedPaths(excluded, ["AGENTS.md"], undefined)
		expect(result).toEqual(new Set(["opencode.jsonc"]))
	})

	// Test: Glob patterns work
	it("supports ** glob pattern for recursive matching", () => {
		const excluded = new Set([
			"AGENTS.md",
			"docs/AGENTS.md",
			"src/nested/AGENTS.md",
			"opencode.jsonc",
		])
		const result = filterExcludedPaths(excluded, ["**/AGENTS.md"], undefined)
		expect(result).toEqual(new Set(["opencode.jsonc"]))
	})

	// Test: .opencode directory patterns
	it("supports directory glob patterns", () => {
		const excluded = new Set([
			".opencode/skills/foo.md",
			".opencode/plugins/bar.ts",
			".opencode/config.json",
			"AGENTS.md",
		])
		const result = filterExcludedPaths(excluded, [".opencode/skills/**"], undefined)
		expect(result).toEqual(
			new Set([".opencode/plugins/bar.ts", ".opencode/config.json", "AGENTS.md"]),
		)
	})

	// Test: Exclude filters include results
	it("exclude patterns filter out from include results", () => {
		const excluded = new Set(["AGENTS.md", "vendor/AGENTS.md", "opencode.jsonc"])
		const result = filterExcludedPaths(excluded, ["**/AGENTS.md"], ["**/vendor/**"])
		// AGENTS.md is included, vendor/AGENTS.md stays excluded
		expect(result).toEqual(new Set(["vendor/AGENTS.md", "opencode.jsonc"]))
	})

	// Test: Multiple patterns
	it("supports multiple include patterns", () => {
		const excluded = new Set([
			"AGENTS.md",
			"CLAUDE.md",
			".opencode/skills/test.md",
			"opencode.jsonc",
		])
		const result = filterExcludedPaths(excluded, ["**/AGENTS.md", ".opencode/skills/**"], undefined)
		expect(result).toEqual(new Set(["CLAUDE.md", "opencode.jsonc"]))
	})

	// Test: Returns new Set (immutability)
	it("returns a new Set and does not mutate input", () => {
		const excluded = new Set(["AGENTS.md", "opencode.jsonc"])
		const original = new Set(excluded)
		const result = filterExcludedPaths(excluded, ["AGENTS.md"], undefined)
		expect(excluded).toEqual(original) // Original unchanged
		expect(result).not.toBe(excluded) // Different reference
	})
})

describe("PathMatcher", () => {
	describe("getDisposition", () => {
		it("should return 'included' when path matches include pattern", () => {
			const matcher = createPathMatcher([".opencode/skill/**"], [])
			const result = matcher.getDisposition(".opencode/skill/foo.md")
			expect(result.type).toBe("included")
		})

		it("should return 'excluded' when path matches exclude pattern", () => {
			const matcher = createPathMatcher([], [".opencode/skill/**"])
			const result = matcher.getDisposition(".opencode/skill/foo.md")
			expect(result.type).toBe("excluded")
		})

		it("should allow include to re-include excluded paths", () => {
			// Per schema: include "re-adds files from the excluded set"
			const matcher = createPathMatcher([".opencode/**"], [".opencode/skill/**"])
			const result = matcher.getDisposition(".opencode/skill/foo.md")
			// Include pattern overrides exclude (re-includes from excluded set)
			expect(result.type).toBe("included")
		})

		it("should return 'partial' when patterns target inside directory", () => {
			const matcher = createPathMatcher([".opencode/skill/foo/**"], [])
			const result = matcher.getDisposition(".opencode/skill")
			expect(result.type).toBe("partial")
		})

		it("should return 'included' when no include patterns configured", () => {
			const matcher = createPathMatcher([], [])
			const result = matcher.getDisposition("any/path.ts")
			expect(result.type).toBe("included")
		})

		it("should return 'excluded' when include patterns exist but none match", () => {
			const matcher = createPathMatcher(["src/**"], [])
			const result = matcher.getDisposition("lib/file.ts")
			expect(result.type).toBe("excluded")
		})
	})

	describe("targetsInside", () => {
		it("should return true when pattern targets inside directory", () => {
			const matcher = createPathMatcher([".opencode/skill/**"], [])
			expect(matcher.targetsInside(".opencode")).toBe(true)
		})

		it("should return false when no pattern targets inside", () => {
			const matcher = createPathMatcher(["src/**"], [])
			expect(matcher.targetsInside(".opencode")).toBe(false)
		})

		it("should handle directory with trailing slash", () => {
			const matcher = createPathMatcher([".opencode/skill/**"], [])
			expect(matcher.targetsInside(".opencode/")).toBe(true)
		})
	})

	describe("getInnerPatterns", () => {
		it("should return patterns targeting inside directory", () => {
			const matcher = createPathMatcher(
				[".opencode/skill/**", ".opencode/command/**", "src/**"],
				[],
			)
			const inner = matcher.getInnerPatterns(".opencode")
			expect(inner).toEqual([".opencode/skill/**", ".opencode/command/**"])
		})

		it("should return empty array when no patterns target inside", () => {
			const matcher = createPathMatcher(["src/**", "lib/**"], [])
			const inner = matcher.getInnerPatterns(".opencode")
			expect(inner).toEqual([])
		})

		it("should handle directory with trailing slash", () => {
			const matcher = createPathMatcher([".opencode/skill/**"], [])
			const inner = matcher.getInnerPatterns(".opencode/")
			expect(inner).toEqual([".opencode/skill/**"])
		})
	})

	describe("hasIncludePatterns", () => {
		it("should return true when include patterns exist", () => {
			const matcher = createPathMatcher(["**"], [])
			expect(matcher.hasIncludePatterns()).toBe(true)
		})

		it("should return false when no include patterns", () => {
			const matcher = createPathMatcher([], ["**"])
			expect(matcher.hasIncludePatterns()).toBe(false)
		})

		it("should return false for empty matcher", () => {
			const matcher = createPathMatcher([], [])
			expect(matcher.hasIncludePatterns()).toBe(false)
		})
	})
})

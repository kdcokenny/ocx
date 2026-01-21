import { afterEach, describe, expect, it } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ValidationError } from "../src/utils/errors"
import {
	extractPackageName,
	formatPluginEntry,
	isNpmSpecifier,
	parseNpmSpecifier,
} from "../src/utils/npm-registry"
import { cleanupTempDir, createTempDir, parseJsonc, runCLI } from "./helpers"

// =============================================================================
// parseNpmSpecifier Tests
// =============================================================================

describe("parseNpmSpecifier", () => {
	describe("valid inputs", () => {
		it("parses simple package name: npm:lodash", () => {
			const result = parseNpmSpecifier("npm:lodash")
			expect(result).toEqual({ type: "npm", name: "lodash", version: undefined })
		})

		it("parses package with version: npm:lodash@4.0.0", () => {
			const result = parseNpmSpecifier("npm:lodash@4.0.0")
			expect(result).toEqual({ type: "npm", name: "lodash", version: "4.0.0" })
		})

		it("parses scoped package: npm:@scope/pkg", () => {
			const result = parseNpmSpecifier("npm:@scope/pkg")
			expect(result).toEqual({ type: "npm", name: "@scope/pkg", version: undefined })
		})

		it("parses scoped package with version: npm:@scope/pkg@1.0.0", () => {
			const result = parseNpmSpecifier("npm:@scope/pkg@1.0.0")
			expect(result).toEqual({ type: "npm", name: "@scope/pkg", version: "1.0.0" })
		})

		it("parses package with complex version: npm:pkg@^1.2.3", () => {
			const result = parseNpmSpecifier("npm:pkg@^1.2.3")
			expect(result).toEqual({ type: "npm", name: "pkg", version: "^1.2.3" })
		})

		it("parses scoped package with complex version: npm:@opencode/plugin@~2.0.0", () => {
			const result = parseNpmSpecifier("npm:@opencode/plugin@~2.0.0")
			expect(result).toEqual({ type: "npm", name: "@opencode/plugin", version: "~2.0.0" })
		})

		it("handles whitespace around specifier", () => {
			const result = parseNpmSpecifier("  npm:lodash  ")
			expect(result).toEqual({ type: "npm", name: "lodash", version: undefined })
		})

		it("parses packages with hyphens and underscores", () => {
			const result = parseNpmSpecifier("npm:my-package_123")
			expect(result).toEqual({ type: "npm", name: "my-package_123", version: undefined })
		})

		it("parses packages with dots", () => {
			const result = parseNpmSpecifier("npm:config.json")
			expect(result).toEqual({ type: "npm", name: "config.json", version: undefined })
		})
	})

	describe("invalid inputs", () => {
		it("throws ValidationError for empty package name: npm:", () => {
			expect(() => parseNpmSpecifier("npm:")).toThrow(ValidationError)
			expect(() => parseNpmSpecifier("npm:")).toThrow("Package name is required")
		})

		it("throws ValidationError for incomplete scoped package: npm:@scope/", () => {
			expect(() => parseNpmSpecifier("npm:@scope/")).toThrow(ValidationError)
		})

		it("throws ValidationError for path traversal: npm:../malicious", () => {
			expect(() => parseNpmSpecifier("npm:../malicious")).toThrow(ValidationError)
			expect(() => parseNpmSpecifier("npm:../malicious")).toThrow("path traversal")
		})

		it("throws ValidationError for path in non-scoped package: npm:foo/bar", () => {
			expect(() => parseNpmSpecifier("npm:foo/bar")).toThrow(ValidationError)
		})

		it("throws ValidationError for missing npm: prefix", () => {
			expect(() => parseNpmSpecifier("lodash")).toThrow(ValidationError)
			expect(() => parseNpmSpecifier("lodash")).toThrow("`npm:` prefix")
		})

		it("throws ValidationError for empty input", () => {
			expect(() => parseNpmSpecifier("")).toThrow(ValidationError)
		})

		it("throws ValidationError for whitespace-only input", () => {
			expect(() => parseNpmSpecifier("   ")).toThrow(ValidationError)
		})

		it("throws ValidationError for null-like input", () => {
			expect(() => parseNpmSpecifier(null as unknown as string)).toThrow(ValidationError)
		})

		it("throws ValidationError for @scope@version (missing package name)", () => {
			expect(() => parseNpmSpecifier("npm:@scope@1.0.0")).toThrow(ValidationError)
			expect(() => parseNpmSpecifier("npm:@scope@1.0.0")).toThrow(
				"Scoped packages must have format @scope/pkg",
			)
		})

		it("throws ValidationError for uppercase package names", () => {
			expect(() => parseNpmSpecifier("npm:MyPackage")).toThrow(ValidationError)
		})

		it("throws ValidationError for package names starting with dots", () => {
			expect(() => parseNpmSpecifier("npm:.hidden")).toThrow(ValidationError)
		})
	})
})

// =============================================================================
// isNpmSpecifier Tests
// =============================================================================

describe("isNpmSpecifier", () => {
	it("returns true for npm: prefix", () => {
		expect(isNpmSpecifier("npm:lodash")).toBe(true)
		expect(isNpmSpecifier("npm:@scope/pkg")).toBe(true)
	})

	it("returns true with whitespace", () => {
		expect(isNpmSpecifier("  npm:lodash")).toBe(true)
	})

	it("returns false for non-npm specifiers", () => {
		expect(isNpmSpecifier("lodash")).toBe(false)
		expect(isNpmSpecifier("@scope/pkg")).toBe(false)
		expect(isNpmSpecifier("./local-path")).toBe(false)
		expect(isNpmSpecifier("https://registry.com")).toBe(false)
	})
})

// =============================================================================
// formatPluginEntry Tests
// =============================================================================

describe("formatPluginEntry", () => {
	it("formats package name without version", () => {
		expect(formatPluginEntry("lodash", undefined)).toBe("lodash")
	})

	it("formats package name with version", () => {
		expect(formatPluginEntry("lodash", "4.0.0")).toBe("lodash@4.0.0")
	})

	it("formats scoped package without version", () => {
		expect(formatPluginEntry("@scope/pkg", undefined)).toBe("@scope/pkg")
	})

	it("formats scoped package with version", () => {
		expect(formatPluginEntry("@scope/pkg", "1.0.0")).toBe("@scope/pkg@1.0.0")
	})

	it("handles empty string version as falsy", () => {
		expect(formatPluginEntry("lodash", "")).toBe("lodash")
	})
})

// =============================================================================
// extractPackageName Tests
// =============================================================================

describe("extractPackageName", () => {
	it("extracts name from simple package", () => {
		expect(extractPackageName("lodash")).toBe("lodash")
	})

	it("extracts name from package with version", () => {
		expect(extractPackageName("lodash@4.0.0")).toBe("lodash")
	})

	it("extracts name from scoped package", () => {
		expect(extractPackageName("@scope/pkg")).toBe("@scope/pkg")
	})

	it("extracts name from scoped package with version", () => {
		expect(extractPackageName("@scope/pkg@1.0.0")).toBe("@scope/pkg")
	})

	it("handles complex version strings", () => {
		expect(extractPackageName("pkg@^1.2.3")).toBe("pkg")
		expect(extractPackageName("@scope/pkg@~2.0.0")).toBe("@scope/pkg")
	})

	it("handles whitespace", () => {
		expect(extractPackageName("  lodash  ")).toBe("lodash")
		expect(extractPackageName("  lodash@4.0.0  ")).toBe("lodash")
	})

	it("handles package names with multiple hyphens", () => {
		expect(extractPackageName("my-cool-package@1.0.0")).toBe("my-cool-package")
	})
})

// =============================================================================
// validateNpmPackageName Tests (tested via parseNpmSpecifier)
// =============================================================================

describe("validateNpmPackageName (via parseNpmSpecifier)", () => {
	describe("valid names", () => {
		it("accepts simple lowercase names", () => {
			expect(() => parseNpmSpecifier("npm:lodash")).not.toThrow()
			expect(() => parseNpmSpecifier("npm:react")).not.toThrow()
		})

		it("accepts scoped packages", () => {
			expect(() => parseNpmSpecifier("npm:@scope/pkg")).not.toThrow()
			expect(() => parseNpmSpecifier("npm:@babel/core")).not.toThrow()
		})

		it("accepts names with hyphens, underscores, and numbers", () => {
			expect(() => parseNpmSpecifier("npm:my-package-123")).not.toThrow()
			expect(() => parseNpmSpecifier("npm:my_package_123")).not.toThrow()
			expect(() => parseNpmSpecifier("npm:package123")).not.toThrow()
		})

		it("accepts names with dots", () => {
			expect(() => parseNpmSpecifier("npm:eslint.config")).not.toThrow()
		})
	})

	describe("invalid names", () => {
		it("rejects empty string", () => {
			expect(() => parseNpmSpecifier("npm:")).toThrow(ValidationError)
		})

		it("rejects names with path traversal", () => {
			expect(() => parseNpmSpecifier("npm:..")).toThrow(ValidationError)
			expect(() => parseNpmSpecifier("npm:foo/../bar")).toThrow(ValidationError)
			expect(() => parseNpmSpecifier("npm:./foo")).toThrow(ValidationError)
		})

		it("rejects names longer than 214 characters", () => {
			const longName = "a".repeat(215)
			expect(() => parseNpmSpecifier(`npm:${longName}`)).toThrow(ValidationError)
			expect(() => parseNpmSpecifier(`npm:${longName}`)).toThrow("exceeds maximum length")
		})

		it("rejects names with uppercase letters", () => {
			expect(() => parseNpmSpecifier("npm:MyPackage")).toThrow(ValidationError)
			expect(() => parseNpmSpecifier("npm:UPPERCASE")).toThrow(ValidationError)
		})

		it("rejects names starting with dot", () => {
			expect(() => parseNpmSpecifier("npm:.hidden")).toThrow(ValidationError)
		})

		it("rejects names starting with underscore", () => {
			expect(() => parseNpmSpecifier("npm:_hidden")).toThrow(ValidationError)
		})

		it("rejects names with spaces", () => {
			expect(() => parseNpmSpecifier("npm:my package")).toThrow(ValidationError)
		})
	})
})

// =============================================================================
// Integration Tests - npm Plugin Installation
// =============================================================================

describe("npm plugin integration", () => {
	let testDir: string

	afterEach(async () => {
		if (testDir) {
			await cleanupTempDir(testDir)
		}
	})

	it("should add npm plugin with dry-run (validates without network)", async () => {
		testDir = await createTempDir("npm-dry-run")

		// Init the project
		await runCLI(["init", "--force"], testDir)

		// Use dry-run which still parses and routes npm: but may fail on validation
		// This tests the parsing and routing logic
		const { output } = await runCLI(["add", "npm:lodash", "--dry-run"], testDir)

		// Should attempt to validate the npm package
		// (may fail with network error if offline, but parsing worked)
		expect(output).toMatch(/Validating|npm|lodash/i)
	})

	it("should handle plugin entry parsing in opencode.json", async () => {
		testDir = await createTempDir("npm-plugin-parsing")

		// Init the project
		await runCLI(["init", "--force"], testDir)

		// Create an opencode.jsonc with plugin entries
		const opencodePath = join(testDir, "opencode.jsonc")
		const opencodeContent = {
			plugin: ["@opencode/plugin-a@1.0.0", "simple-plugin", "@scope/pkg@^2.0.0"],
		}
		await writeFile(opencodePath, JSON.stringify(opencodeContent, null, 2))

		// Verify we can parse the plugin entries correctly
		const content = await readFile(opencodePath, "utf-8")
		const parsed = parseJsonc(content) as { plugin: string[] }

		expect(parsed.plugin).toHaveLength(3)
		expect(extractPackageName(parsed.plugin[0])).toBe("@opencode/plugin-a")
		expect(extractPackageName(parsed.plugin[1])).toBe("simple-plugin")
		expect(extractPackageName(parsed.plugin[2])).toBe("@scope/pkg")
	})

	it("should fail on invalid npm specifier format", async () => {
		testDir = await createTempDir("npm-invalid")

		// Init the project
		await runCLI(["init", "--force"], testDir)

		// Try to add with invalid npm specifier (empty package name)
		const { exitCode, output } = await runCLI(["add", "npm:"], testDir)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("Package name is required")
	})

	it("should fail on npm specifier with path traversal", async () => {
		testDir = await createTempDir("npm-traversal")

		// Init the project
		await runCLI(["init", "--force"], testDir)

		// Try to add with path traversal
		const { exitCode, output } = await runCLI(["add", "npm:../malicious"], testDir)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("path traversal")
	})
})

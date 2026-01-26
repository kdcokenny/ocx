import { describe, expect, it } from "bun:test"
import { buildOpenCodeEnv, resolveOpenCodeBinary } from "../src/commands/opencode"
import { runCLI } from "./helpers"

describe("resolveOpenCodeBinary", () => {
	// Table-driven with DIFFERENT values to prove precedence
	const cases = [
		{
			name: "uses configBin when set (highest priority)",
			configBin: "/custom/opencode",
			envBin: "/env/opencode",
			expected: "/custom/opencode",
		},
		{
			name: "uses envBin when configBin not set",
			configBin: undefined,
			envBin: "/env/opencode",
			expected: "/env/opencode",
		},
		{
			name: "falls back to 'opencode' when neither set",
			configBin: undefined,
			envBin: undefined,
			expected: "opencode",
		},
		{
			name: "does NOT trim whitespace (preserves as-is)",
			configBin: undefined,
			envBin: "   ",
			expected: "   ", // Whitespace preserved - will cause spawn error
		},
	]

	for (const { name, configBin, envBin, expected } of cases) {
		it(name, () => {
			const result = resolveOpenCodeBinary({ configBin, envBin })
			expect(result).toBe(expected)
		})
	}

	it("empty string envBin is PRESERVED (nullish coalescing behavior)", () => {
		// Empty string is NOT nullish, so it's preserved (will cause spawn error, but that's intentional)
		// This matches the original ?? semantics: only undefined/null fall through
		const result = resolveOpenCodeBinary({ configBin: undefined, envBin: "" })
		expect(result).toBe("")
	})

	it("empty string configBin is PRESERVED over envBin", () => {
		// Empty string configBin takes precedence (nullish coalescing)
		const result = resolveOpenCodeBinary({ configBin: "", envBin: "/env/opencode" })
		expect(result).toBe("")
	})
})

describe("buildOpenCodeEnv", () => {
	it("sets OPENCODE_DISABLE_PROJECT_CONFIG when disableProjectConfig is true", () => {
		const result = buildOpenCodeEnv({
			baseEnv: {},
			disableProjectConfig: true,
		})
		expect(result.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("true")
	})

	it("does NOT set OPENCODE_DISABLE_PROJECT_CONFIG when false", () => {
		const result = buildOpenCodeEnv({
			baseEnv: {},
			disableProjectConfig: false,
		})
		expect(result.OPENCODE_DISABLE_PROJECT_CONFIG).toBeUndefined()
	})

	it("sets OPENCODE_CONFIG_DIR to profileDir when provided", () => {
		const result = buildOpenCodeEnv({
			baseEnv: {},
			profileDir: "/home/user/.config/opencode/profiles/work",
			disableProjectConfig: true,
		})
		expect(result.OPENCODE_CONFIG_DIR).toBe("/home/user/.config/opencode/profiles/work")
	})

	it("sets OPENCODE_CONFIG_CONTENT as JSON when mergedConfig provided", () => {
		const config = { theme: "dark", nested: { key: "value" } }
		const result = buildOpenCodeEnv({
			baseEnv: {},
			mergedConfig: config,
			disableProjectConfig: true,
		})
		// Parse and compare objects - NOT string comparison
		expect(result.OPENCODE_CONFIG_CONTENT).toBeDefined()
		expect(JSON.parse(result.OPENCODE_CONFIG_CONTENT as string)).toEqual(config)
	})

	it("sets OCX_PROFILE when profileName provided", () => {
		const result = buildOpenCodeEnv({
			baseEnv: {},
			profileName: "work",
			disableProjectConfig: true,
		})
		expect(result.OCX_PROFILE).toBe("work")
	})

	it("preserves existing env vars that are not overwritten", () => {
		const baseEnv = {
			PATH: "/usr/bin",
			HOME: "/home/user",
			CUSTOM_VAR: "custom-value",
		}
		const result = buildOpenCodeEnv({
			baseEnv,
			profileName: "work",
			disableProjectConfig: true,
		})
		// Preserved keys
		expect(result.PATH).toBe("/usr/bin")
		expect(result.HOME).toBe("/home/user")
		expect(result.CUSTOM_VAR).toBe("custom-value")
	})

	it("overwrites conflicting keys with new values (proves merge order)", () => {
		const baseEnv = {
			OCX_PROFILE: "old-profile", // Will be overwritten
			OPENCODE_CONFIG_DIR: "/old/path", // Will be overwritten
			PATH: "/usr/bin", // Will be preserved
		}
		const result = buildOpenCodeEnv({
			baseEnv,
			profileName: "new-profile",
			profileDir: "/new/path",
			disableProjectConfig: true,
		})
		// Overwritten keys
		expect(result.OCX_PROFILE).toBe("new-profile")
		expect(result.OPENCODE_CONFIG_DIR).toBe("/new/path")
		// Preserved keys
		expect(result.PATH).toBe("/usr/bin")
	})

	it("does NOT mutate the original baseEnv object", () => {
		const baseEnv = { OCX_PROFILE: "original" }
		const originalCopy = { ...baseEnv }

		buildOpenCodeEnv({
			baseEnv,
			profileName: "new",
			disableProjectConfig: true,
		})

		// baseEnv should be unchanged
		expect(baseEnv).toEqual(originalCopy)
		expect(baseEnv.OCX_PROFILE).toBe("original")
	})

	it("returns a new object (not the same reference)", () => {
		const baseEnv = { PATH: "/usr/bin" }
		const result = buildOpenCodeEnv({
			baseEnv,
			disableProjectConfig: false,
		})
		expect(result).not.toBe(baseEnv)
	})
})

describe("oc command CLI contract", () => {
	it("help shows supported flags and not [path]", async () => {
		const result = await runCLI(["oc", "--help"], process.cwd())
		expect(result.stdout).toContain("--profile")
		expect(result.stdout).toContain("--no-rename")
		expect(result.stdout).not.toContain("[path]")
	})

	it("does not interpret positional args as path (regression #112)", async () => {
		// The bug: "ocx oc run" treated "run" as [path] argument, causing ENOENT
		// Now: "run" should pass through to opencode, not be interpreted as a directory
		// Set OPENCODE_BIN to a command that fails quickly to avoid timeout
		const result = await runCLI(["oc", "--no-rename", "run", "test"], process.cwd(), {
			env: { OPENCODE_BIN: "nonexistent-opencode-binary" },
		})
		// Should NOT fail with "no such file or directory" for a 'run' directory
		// It should fail with opencode binary not found, which is expected
		expect(result.output).not.toMatch(/no such file or directory.*run/i)
		// Should fail with command not found or similar
		expect(result.exitCode).not.toBe(0)
	})

	it("errors when -p flag missing value", async () => {
		const result = await runCLI(["oc", "-p"], process.cwd())
		expect(result.exitCode).toBe(1)
	})
})

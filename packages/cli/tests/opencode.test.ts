import { describe, expect, it } from "bun:test"
import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import {
	buildOpenCodeEnv,
	dedupeLastWins,
	resolveOpenCodeBinary,
	resolveStableOcxExecutablePath,
	resolveStableOpenCodeLauncherPath,
} from "../src/commands/opencode"
import { EXIT_CODES } from "../src/utils/errors"
import { cleanupTempDir, createTempDir, runCLI, runCLIIsolated } from "./helpers"

async function createProfile(testDir: string, name: string): Promise<void> {
	const profileDir = join(testDir, "opencode", "profiles", name)
	await mkdir(profileDir, { recursive: true })
	await Bun.write(join(profileDir, "ocx.jsonc"), "{}")
}

async function createConfigContentCaptureScript(testDir: string): Promise<{
	scriptPath: string
	outputPath: string
}> {
	const scriptPath = join(testDir, "capture-config-content.ts")
	const outputPath = join(testDir, "captured-config-content.json")

	await Bun.write(
		scriptPath,
		[
			"const outputPath = process.argv[2]",
			"if (!outputPath) {",
			'  throw new Error("missing output path")',
			"}",
			"const payload = {",
			"  configContent: process.env.OPENCODE_CONFIG_CONTENT ?? null,",
			"  configDir: process.env.OPENCODE_CONFIG_DIR ?? null,",
			"}",
			"await Bun.write(outputPath, JSON.stringify(payload, null, 2))",
		].join("\n"),
	)

	return { scriptPath, outputPath }
}

describe("dedupeLastWins", () => {
	it("preserves last occurrence when duplicates exist", () => {
		const result = dedupeLastWins(["a", "b", "a", "c"])
		expect(result).toEqual(["b", "a", "c"])
	})

	it("handles no duplicates", () => {
		const result = dedupeLastWins(["a", "b", "c"])
		expect(result).toEqual(["a", "b", "c"])
	})

	it("handles all duplicates", () => {
		const result = dedupeLastWins(["a", "a", "a"])
		expect(result).toEqual(["a"])
	})

	it("handles empty array", () => {
		const result = dedupeLastWins([])
		expect(result).toEqual([])
	})

	it("preserves order of last occurrences", () => {
		const result = dedupeLastWins(["x", "y", "z", "x", "y"])
		// Last "x" is at index 3, last "y" is at index 4, "z" is unique at index 2
		// Order should be: z, x, y (based on last occurrence positions)
		expect(result).toEqual(["z", "x", "y"])
	})

	it("handles instruction path deduplication (real-world case)", () => {
		const discovered = ["/global/AGENTS.md", "/profile/AGENTS.md", "/project/AGENTS.md"]
		const userConfig = ["/project/AGENTS.md", "/custom/AGENTS.md"]
		const combined = [...discovered, ...userConfig]
		const result = dedupeLastWins(combined)

		// Last occurrence of /project/AGENTS.md should win
		expect(result).toEqual([
			"/global/AGENTS.md",
			"/profile/AGENTS.md",
			"/project/AGENTS.md",
			"/custom/AGENTS.md",
		])
	})
})

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

describe("resolveStableOpenCodeLauncherPath", () => {
	it("resolves relative launchers against cwd", () => {
		const resolved = resolveStableOpenCodeLauncherPath({
			configuredBin: "./scripts/ocx",
			cwd: "/tmp/project",
		})

		expect(resolved).toBe("/tmp/project/scripts/ocx")
	})

	it("preserves absolute launcher paths", () => {
		const resolved = resolveStableOpenCodeLauncherPath({
			configuredBin: "/usr/local/bin/ocx",
			cwd: "/tmp/project",
		})

		expect(resolved).toBe("/usr/local/bin/ocx")
	})

	it("resolves PATH launchers to absolute paths", () => {
		const resolved = resolveStableOpenCodeLauncherPath({
			configuredBin: "ocx",
			cwd: "/tmp/project",
			resolveExecutable: (command) => (command === "ocx" ? "/opt/bin/ocx" : undefined),
		})

		expect(resolved).toBe("/opt/bin/ocx")
	})

	it("fails loud when PATH launcher cannot be resolved", () => {
		expect(() =>
			resolveStableOpenCodeLauncherPath({
				configuredBin: "ocx",
				cwd: "/tmp/project",
				resolveExecutable: () => undefined,
			}),
		).toThrow(/cannot be used as OPENCODE_BIN/i)
	})
})

describe("resolveStableOcxExecutablePath", () => {
	it("resolves current OCX script path from argv[1]", () => {
		const resolved = resolveStableOcxExecutablePath({
			cwd: "/tmp/project",
			argv: ["/usr/local/bin/bun", "./scripts/ocx.ts"],
			execPath: "/usr/local/bin/bun",
			isCompiledBinary: false,
		})

		expect(resolved).toBe("/tmp/project/scripts/ocx.ts")
	})

	it("prefers inherited OCX_BIN from active launch context", () => {
		const resolved = resolveStableOcxExecutablePath({
			cwd: "/tmp/project",
			inheritedOcxBin: "/usr/local/bin/ocx",
			argv: ["/usr/local/bin/bun", "./scripts/ocx.ts"],
			execPath: "/usr/local/bin/bun",
			isCompiledBinary: false,
		})

		expect(resolved).toBe("/usr/local/bin/ocx")
	})

	it("uses execPath for compiled binaries", () => {
		const resolved = resolveStableOcxExecutablePath({
			cwd: "/tmp/project",
			argv: ["/opt/bin/ocx", "oc", "--help"],
			execPath: "/opt/bin/ocx",
			isCompiledBinary: true,
		})

		expect(resolved).toBe("/opt/bin/ocx")
	})
})

describe("buildOpenCodeEnv", () => {
	it("sets OPENCODE_DISABLE_PROJECT_CONFIG when profile is active", () => {
		const result = buildOpenCodeEnv({
			baseEnv: {},
			profileName: "work",
		})
		expect(result.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("true")
	})

	it("does NOT set OPENCODE_DISABLE_PROJECT_CONFIG when no profile active", () => {
		const result = buildOpenCodeEnv({
			baseEnv: {},
		})
		expect(result.OPENCODE_DISABLE_PROJECT_CONFIG).toBeUndefined()
	})

	it("removes inherited OPENCODE_DISABLE_PROJECT_CONFIG when no profile active", () => {
		const result = buildOpenCodeEnv({
			baseEnv: {
				OPENCODE_DISABLE_PROJECT_CONFIG: "true",
				PATH: "/usr/bin",
			},
		})

		expect(result.OPENCODE_DISABLE_PROJECT_CONFIG).toBeUndefined()
		expect("OPENCODE_DISABLE_PROJECT_CONFIG" in result).toBe(false)
		expect(result.PATH).toBe("/usr/bin")
	})

	it("overwrites inherited OPENCODE_BIN with resolved launcher when provided", () => {
		const result = buildOpenCodeEnv({
			baseEnv: {
				OPENCODE_BIN: "false",
				PATH: "/usr/bin",
			},
			opencodeBin: "/usr/local/bin/bun",
		})

		expect(result.OPENCODE_BIN).toBe("/usr/local/bin/bun")
		expect(result.PATH).toBe("/usr/bin")
	})

	it("sets OPENCODE_CONFIG_DIR to global config path when no profile active", () => {
		const result = buildOpenCodeEnv({
			baseEnv: {},
		})
		// When no profile is active, should use getGlobalConfigPath()
		expect(result.OPENCODE_CONFIG_DIR).toBeDefined()
		// Can't test exact value since it's XDG-aware, but should be set
		expect(typeof result.OPENCODE_CONFIG_DIR).toBe("string")
	})

	it("sets OPENCODE_CONFIG_CONTENT as JSON when configContent provided", () => {
		const config = { theme: "dark", nested: { key: "value" } }
		const result = buildOpenCodeEnv({
			baseEnv: {},
			configDir: "/tmp/ocx-merged-config",
			configContent: JSON.stringify(config),
		})
		// Parse and compare objects - NOT string comparison
		expect(result.OPENCODE_CONFIG_CONTENT).toBeDefined()
		expect(JSON.parse(result.OPENCODE_CONFIG_CONTENT as string)).toEqual(config)
	})

	it("uses explicit configDir override when provided", () => {
		const result = buildOpenCodeEnv({
			baseEnv: {},
			profileName: "work",
			configDir: "/tmp/ocx-merged-config",
		})

		expect(result.OPENCODE_CONFIG_DIR).toBe("/tmp/ocx-merged-config")
	})

	it("sets OCX_PROFILE when profileName provided", () => {
		const result = buildOpenCodeEnv({
			baseEnv: {},
			profileName: "work",
		})
		expect(result.OCX_PROFILE).toBe("work")
	})

	it("exports OCX_CONTEXT and OCX_BIN for profile launches", () => {
		const result = buildOpenCodeEnv({
			baseEnv: {},
			profileName: "work",
			ocxBin: "/usr/local/bin/ocx",
		})

		expect(result.OCX_CONTEXT).toBe("1")
		expect(result.OCX_BIN).toBe("/usr/local/bin/ocx")
		expect(result.OCX_PROFILE).toBe("work")
	})

	it("removes inherited OCX launch markers when no profile is active", () => {
		const result = buildOpenCodeEnv({
			baseEnv: {
				OCX_CONTEXT: "1",
				OCX_BIN: "/stale/ocx",
				OCX_PROFILE: "stale",
			},
		})

		expect(result.OCX_CONTEXT).toBeUndefined()
		expect(result.OCX_BIN).toBeUndefined()
		expect(result.OCX_PROFILE).toBeUndefined()
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
		})
		// Overwritten keys
		expect(result.OCX_PROFILE).toBe("new-profile")
		// OPENCODE_CONFIG_DIR always uses getGlobalConfigPath(), overwriting baseEnv value
		expect(result.OPENCODE_CONFIG_DIR).toBeDefined()
		expect(result.OPENCODE_CONFIG_DIR).not.toBe("/old/path")
		// Preserved keys
		expect(result.PATH).toBe("/usr/bin")
	})

	it("does NOT mutate the original baseEnv object", () => {
		const baseEnv = { OCX_PROFILE: "original" }
		const originalCopy = { ...baseEnv }

		buildOpenCodeEnv({
			baseEnv,
			profileName: "new",
		})

		// baseEnv should be unchanged
		expect(baseEnv).toEqual(originalCopy)
		expect(baseEnv.OCX_PROFILE).toBe("original")
	})

	it("returns a new object (not the same reference)", () => {
		const baseEnv = { PATH: "/usr/bin" }
		const result = buildOpenCodeEnv({
			baseEnv,
		})
		expect(result).not.toBe(baseEnv)
	})
})

describe("oc command CLI contract", () => {
	it("registers signal handlers before merged overlay preparation (regression #142)", async () => {
		const commandPath = join(import.meta.dir, "..", "src", "commands", "opencode.ts")
		const source = await readFile(commandPath, "utf8")

		const runOpencodeStart = source.indexOf("async function runOpencode")
		expect(runOpencodeStart).toBeGreaterThan(-1)

		const runOpencodeSource = source.slice(runOpencodeStart)
		const sigintRegistrationIndex = runOpencodeSource.indexOf('process.on("SIGINT", sigintHandler)')
		const prepareMergedIndex = runOpencodeSource.indexOf(
			"mergedConfig = await prepareMergedConfigDirForProfile",
		)
		const lifecycleTryIndex = runOpencodeSource.indexOf("try {")
		const lifecycleFinallyIndex = runOpencodeSource.indexOf("} finally {")

		expect(sigintRegistrationIndex).toBeGreaterThan(-1)
		expect(prepareMergedIndex).toBeGreaterThan(-1)
		expect(lifecycleTryIndex).toBeGreaterThan(-1)
		expect(lifecycleFinallyIndex).toBeGreaterThan(lifecycleTryIndex)

		const beforeSignalRegistration = runOpencodeSource.slice(0, sigintRegistrationIndex)
		expect(beforeSignalRegistration).not.toContain("prepareMergedConfigDirForProfile")

		expect(prepareMergedIndex).toBeGreaterThan(sigintRegistrationIndex)
		expect(prepareMergedIndex).toBeGreaterThan(lifecycleTryIndex)
		expect(prepareMergedIndex).toBeLessThan(lifecycleFinallyIndex)
	})

	it("help shows supported flags and not [path]", async () => {
		const result = await runCLI(["oc", "--help"], process.cwd())
		expect(result.stdout).toContain("--profile")
		expect(result.stdout).toContain("--no-rename")
		expect(result.stdout).not.toContain("[path]")
	})

	it("does not interpret positional args as path (regression #112)", async () => {
		const testDir = await createTempDir("oc-regression-112")
		try {
			// Use isolated mode to prevent inheriting OCX_PROFILE from developer's env
			// which would load a profile with bin that overrides OPENCODE_BIN
			const result = await runCLIIsolated(
				["oc", "--no-rename", "run", "test"],
				testDir,
				{ OPENCODE_BIN: "false" }, // "false" is a shell builtin that exits with code 1
			)
			// Should NOT fail with "no such file or directory" for a 'run' directory
			// It should fail with opencode binary not found, which is expected
			expect(result.output).not.toMatch(/no such file or directory.*run/i)
			// Should fail with command not found or similar
			expect(result.exitCode).not.toBe(0)
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("errors when -p flag missing value", async () => {
		const result = await runCLI(["oc", "-p"], process.cwd())
		expect(result.exitCode).toBe(1)
	})

	it("fails fast for invalid --profile without launching opencode", async () => {
		const testDir = await createTempDir("oc-invalid-cli-profile")
		try {
			await createProfile(testDir, "default")

			const result = await runCLIIsolated(["oc", "--no-rename", "--profile", "missing"], testDir, {
				OPENCODE_BIN: "true",
			})

			expect(result.exitCode).toBe(EXIT_CODES.NOT_FOUND)
			expect(result.output).toContain('Profile "missing" not found')
			expect(result.output).not.toContain("Using profile: default")
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("fails fast for empty --profile value without launching opencode", async () => {
		const testDir = await createTempDir("oc-empty-cli-profile")
		try {
			await createProfile(testDir, "default")

			const result = await runCLIIsolated(["oc", "--no-rename", "--profile="], testDir, {
				OPENCODE_BIN: "true",
			})

			expect(result.exitCode).toBe(EXIT_CODES.CONFIG)
			expect(result.output).toContain("cannot be empty")
			expect(result.output).not.toContain("Using profile:")
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("fails fast for invalid OCX_PROFILE env without launching opencode", async () => {
		const testDir = await createTempDir("oc-invalid-env-profile")
		try {
			await createProfile(testDir, "default")

			const result = await runCLIIsolated(["oc", "--no-rename"], testDir, {
				OCX_PROFILE: "missing",
				OPENCODE_BIN: "true",
			})

			expect(result.exitCode).toBe(EXIT_CODES.NOT_FOUND)
			expect(result.output).toContain('Profile "missing" not found')
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("fails fast for whitespace OCX_PROFILE env without launching opencode", async () => {
		const testDir = await createTempDir("oc-whitespace-env-profile")
		try {
			await createProfile(testDir, "default")

			const result = await runCLIIsolated(["oc", "--no-rename"], testDir, {
				OCX_PROFILE: "   ",
				OPENCODE_BIN: "true",
			})

			expect(result.exitCode).toBe(EXIT_CODES.CONFIG)
			expect(result.output).toContain("cannot be empty")
			expect(result.output).not.toContain("Using profile:")
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("fails fast for invalid local .opencode profile without fallback", async () => {
		const testDir = await createTempDir("oc-invalid-local-profile")
		try {
			await createProfile(testDir, "default")

			const localConfigDir = join(testDir, ".opencode")
			await mkdir(localConfigDir, { recursive: true })
			await Bun.write(join(localConfigDir, "ocx.jsonc"), JSON.stringify({ profile: "missing" }))

			const result = await runCLIIsolated(["oc", "--no-rename"], testDir, {
				OCX_PROFILE: "default",
				OPENCODE_BIN: "true",
			})

			expect(result.exitCode).toBe(EXIT_CODES.NOT_FOUND)
			expect(result.output).toContain('Profile "missing" not found')
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("fails fast for empty local .opencode profile without fallback", async () => {
		const testDir = await createTempDir("oc-empty-local-profile")
		try {
			await createProfile(testDir, "default")

			const localConfigDir = join(testDir, ".opencode")
			await mkdir(localConfigDir, { recursive: true })
			await Bun.write(join(localConfigDir, "ocx.jsonc"), JSON.stringify({ profile: "" }))

			const result = await runCLIIsolated(["oc", "--no-rename"], testDir, {
				OCX_PROFILE: "default",
				OPENCODE_BIN: "true",
			})

			expect(result.exitCode).toBe(EXIT_CODES.CONFIG)
			expect(result.output).toContain("cannot be empty")
			expect(result.output).not.toContain("Using profile:")
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("fails fast for malformed local .opencode/ocx.jsonc and does not launch", async () => {
		const testDir = await createTempDir("oc-malformed-local-config")
		try {
			await createProfile(testDir, "default")

			const localConfigDir = join(testDir, ".opencode")
			await mkdir(localConfigDir, { recursive: true })
			await Bun.write(join(localConfigDir, "ocx.jsonc"), '{ "profile": "default"')

			const result = await runCLIIsolated(["oc", "--no-rename"], testDir, {
				OCX_PROFILE: "default",
				OPENCODE_BIN: "true",
			})

			expect(result.exitCode).toBe(EXIT_CODES.CONFIG)
			expect(result.output).toContain("Invalid JSONC")
			expect(result.output).toContain(".opencode/ocx.jsonc")
			expect(result.output).not.toContain("Using profile:")
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("fails fast for malformed local .opencode/opencode.jsonc and does not launch", async () => {
		const testDir = await createTempDir("oc-malformed-local-opencode-config")
		try {
			const localConfigDir = join(testDir, ".opencode")
			await mkdir(localConfigDir, { recursive: true })
			await Bun.write(join(localConfigDir, "opencode.jsonc"), '{ "model": "gpt-5"')

			const result = await runCLIIsolated(["oc", "--no-rename"], testDir, {
				OPENCODE_BIN: "true",
			})

			expect(result.exitCode).toBe(EXIT_CODES.CONFIG)
			expect(result.output).toContain("Invalid JSONC")
			expect(result.output).toContain(".opencode/opencode.jsonc")
			expect(result.output).not.toContain("Using profile:")
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("fails fast for corrupted implicit default profile and does not launch", async () => {
		const testDir = await createTempDir("oc-corrupted-default-profile")
		try {
			await createProfile(testDir, "default")
			await Bun.write(join(testDir, "opencode", "profiles", "default", "ocx.jsonc"), "{")

			const result = await runCLIIsolated(["oc", "--no-rename"], testDir, {
				OPENCODE_BIN: "true",
			})

			expect(result.exitCode).toBe(EXIT_CODES.CONFIG)
			expect(result.output).toContain("profiles/default/ocx.jsonc")
			expect(result.output).toContain("Invalid JSONC")
			expect(result.output).not.toContain("Using profile: default")
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("uses valid --profile and ignores invalid lower-priority OCX_PROFILE", async () => {
		const testDir = await createTempDir("oc-precedence-short-circuit")
		try {
			await createProfile(testDir, "work")

			const result = await runCLIIsolated(["oc", "--no-rename", "--profile", "work"], testDir, {
				OCX_PROFILE: "missing",
				OPENCODE_BIN: "false",
			})

			// /usr/bin/false exits 1, proving launch proceeded with the valid CLI profile.
			expect(result.exitCode).toBe(1)
			expect(result.output).toContain("Using profile: work")
			expect(result.output).not.toContain('Profile "missing" not found')
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	// =============================================================================
	// PHASE 1 RED: Global-only profiles, hard-error local profiles
	// =============================================================================

	it("fails fast when .opencode/profiles/<name> exists (local profiles unsupported)", async () => {
		const testDir = await createTempDir("oc-local-profile-hard-error")
		try {
			await createProfile(testDir, "work")

			// Create a LOCAL profile directory — this is unsupported
			const localProfileDir = join(testDir, ".opencode", "profiles", "work")
			await mkdir(localProfileDir, { recursive: true })
			await Bun.write(join(localProfileDir, "ocx.jsonc"), "{}")

			const result = await runCLIIsolated(["oc", "--no-rename", "--profile", "work"], testDir, {
				OPENCODE_BIN: "true",
			})

			// Must hard error, not silently proceed
			expect(result.exitCode).not.toBe(0)
			expect(result.output).toMatch(/local.*profile.*unsupported|local.*profile.*not.*allowed/i)
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("exports resolved inherited launcher via OPENCODE_BIN and keeps OCX_BIN as OCX executable", async () => {
		const testDir = await createTempDir("oc-contract-ocx-bin")
		try {
			await createProfile(testDir, "work")
			const expectedOpencodeBin = resolveStableOpenCodeLauncherPath({
				configuredBin: "bun",
				cwd: testDir,
			})

			const capturePath = join(testDir, "capture-env.ts")
			const outputPath = join(testDir, "captured-env.json")
			await Bun.write(
				capturePath,
				`const outputPath = process.argv[2];\nif (!outputPath) throw new Error("missing output path");\nconst payload = {\n  ocxBin: process.env.OCX_BIN,\n  opencodeBin: process.env.OPENCODE_BIN,\n  argv0: process.argv[0],\n  argv1: process.argv[1],\n};\nawait Bun.write(outputPath, JSON.stringify(payload));\n`,
			)

			const result = await runCLIIsolated(
				["oc", "--no-rename", "--profile", "work", "run", capturePath, outputPath],
				testDir,
				{ OPENCODE_BIN: "bun" },
			)

			expect(result.exitCode).toBe(0)

			const captured = JSON.parse(await Bun.file(outputPath).text()) as {
				ocxBin?: string
				opencodeBin?: string
				argv0?: string
			}

			expect(captured.opencodeBin).toBe(expectedOpencodeBin)
			expect(captured.ocxBin).toBe(join(import.meta.dir, "..", "src", "index.ts"))
			expect(captured.ocxBin).not.toBe(captured.argv0)
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("exports resolved config launcher via OPENCODE_BIN when config bin overrides inherited env", async () => {
		const testDir = await createTempDir("oc-contract-opencode-bin-config")
		try {
			await createProfile(testDir, "work")
			const expectedOpencodeBin = resolveStableOpenCodeLauncherPath({
				configuredBin: "bun",
				cwd: testDir,
			})
			await Bun.write(
				join(testDir, "opencode", "profiles", "work", "ocx.jsonc"),
				JSON.stringify({ bin: "bun" }),
			)

			const capturePath = join(testDir, "capture-env.ts")
			const outputPath = join(testDir, "captured-env.json")
			await Bun.write(
				capturePath,
				`const outputPath = process.argv[2];\nif (!outputPath) throw new Error("missing output path");\nconst payload = {\n  ocxBin: process.env.OCX_BIN,\n  opencodeBin: process.env.OPENCODE_BIN,\n  argv0: process.argv[0],\n  argv1: process.argv[1],\n};\nawait Bun.write(outputPath, JSON.stringify(payload));\n`,
			)

			const result = await runCLIIsolated(
				["oc", "--no-rename", "--profile", "work", "run", capturePath, outputPath],
				testDir,
				{ OPENCODE_BIN: "false" },
			)

			expect(result.exitCode).toBe(0)

			const captured = JSON.parse(await Bun.file(outputPath).text()) as {
				ocxBin?: string
				opencodeBin?: string
				argv0?: string
			}

			expect(captured.opencodeBin).toBe(expectedOpencodeBin)
			expect(captured.opencodeBin).not.toBe("false")
			expect(captured.ocxBin).toBe(join(import.meta.dir, "..", "src", "index.ts"))
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("rewrites profile-owned relative {file:...} tokens to absolute profile paths in OPENCODE_CONFIG_CONTENT (regression #175)", async () => {
		const testDir = await createTempDir("oc-profile-relative-file-token-rewrite")
		try {
			await createProfile(testDir, "work")

			const profileDir = join(testDir, "opencode", "profiles", "work")
			await mkdir(join(profileDir, "prompts"), { recursive: true })
			await Bun.write(join(profileDir, "prompts", "planner.md"), "profile planner")
			await Bun.write(
				join(profileDir, "opencode.jsonc"),
				JSON.stringify({
					agent: {
						planner: {
							prompt: "{file:./prompts/planner.md}",
						},
					},
				}),
			)

			await mkdir(join(testDir, "prompts"), { recursive: true })
			await Bun.write(join(testDir, "prompts", "planner.md"), "project planner")

			const { scriptPath, outputPath } = await createConfigContentCaptureScript(testDir)
			const result = await runCLIIsolated(
				["oc", "--no-rename", "--profile", "work", "run", scriptPath, outputPath],
				testDir,
				{ OPENCODE_BIN: "bun" },
			)

			expect(result.exitCode).toBe(0)

			const payloadText = await Bun.file(outputPath).text()
			const payload = JSON.parse(payloadText) as {
				configContent: string | null
			}
			expect(payload.configContent).not.toBeNull()

			const parsedConfig = JSON.parse(payload.configContent as string) as {
				agent?: { planner?: { prompt?: string } }
			}
			const plannerPrompt = parsedConfig.agent?.planner?.prompt
			expect(plannerPrompt).toBe(`{file:${join(profileDir, "prompts", "planner.md")}}`)
			expect(plannerPrompt).not.toBe("{file:./prompts/planner.md}")
			expect(plannerPrompt).not.toContain(join(testDir, "prompts", "planner.md"))
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("rewrites only profile-owned relative file tokens per nested leaf path", async () => {
		const testDir = await createTempDir("oc-profile-relative-file-token-nested-origins")
		try {
			await createProfile(testDir, "work")

			const profileDir = join(testDir, "opencode", "profiles", "work")
			await Bun.write(
				join(profileDir, "opencode.jsonc"),
				JSON.stringify({
					agent: {
						planner: {
							prompt: "{file:./prompts/profile-planner.md}",
						},
						researcher: {
							prompt: "{file:./prompts/profile-researcher.md}",
						},
						reviewer: {
							absolutePrompt: "{file:/tmp/absolute-prompt.md}",
							tildePrompt: "{file:~/prompt.md}",
							nonFileToken: "prefix {file:./prompts/not-a-token.md}",
							numericValue: 7,
						},
					},
					settings: {
						enabled: true,
					},
				}),
			)

			const localConfigDir = join(testDir, ".opencode")
			await mkdir(localConfigDir, { recursive: true })
			await Bun.write(
				join(localConfigDir, "opencode.jsonc"),
				JSON.stringify({
					agent: {
						researcher: {
							prompt: "{file:./prompts/project-researcher.md}",
						},
						reviewer: {
							localPrompt: "{file:./prompts/project-reviewer.md}",
						},
					},
				}),
			)

			const { scriptPath, outputPath } = await createConfigContentCaptureScript(testDir)
			const result = await runCLIIsolated(
				["oc", "--no-rename", "--profile", "work", "run", scriptPath, outputPath],
				testDir,
				{ OPENCODE_BIN: "bun" },
			)

			expect(result.exitCode).toBe(0)

			const payload = JSON.parse(await Bun.file(outputPath).text()) as {
				configContent: string | null
			}
			const parsedConfig = JSON.parse(payload.configContent as string) as {
				agent?: {
					planner?: { prompt?: string }
					researcher?: { prompt?: string }
					reviewer?: {
						absolutePrompt?: string
						tildePrompt?: string
						nonFileToken?: string
						localPrompt?: string
						numericValue?: unknown
					}
				}
				settings?: { enabled?: unknown }
			}

			expect(parsedConfig.agent?.planner?.prompt).toBe(
				`{file:${join(profileDir, "prompts", "profile-planner.md")}}`,
			)
			expect(parsedConfig.agent?.researcher?.prompt).toBe("{file:./prompts/project-researcher.md}")
			expect(parsedConfig.agent?.reviewer?.localPrompt).toBe("{file:./prompts/project-reviewer.md}")
			expect(parsedConfig.agent?.reviewer?.absolutePrompt).toBe("{file:/tmp/absolute-prompt.md}")
			expect(parsedConfig.agent?.reviewer?.tildePrompt).toBe("{file:~/prompt.md}")
			expect(parsedConfig.agent?.reviewer?.nonFileToken).toBe(
				"prefix {file:./prompts/not-a-token.md}",
			)
			expect(parsedConfig.agent?.reviewer?.numericValue).toBe(7)
			expect(parsedConfig.settings?.enabled).toBe(true)
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("tracks top-level instructions array ownership with merge+dedupe semantics", async () => {
		const testDir = await createTempDir("oc-profile-relative-file-token-top-level-instructions")
		try {
			await createProfile(testDir, "work")

			const profileDir = join(testDir, "opencode", "profiles", "work")
			await Bun.write(
				join(profileDir, "opencode.jsonc"),
				JSON.stringify({
					instructions: ["{file:./prompts/profile-only.md}", "{file:./prompts/shared.md}"],
				}),
			)

			const localConfigDir = join(testDir, ".opencode")
			await mkdir(localConfigDir, { recursive: true })
			await Bun.write(
				join(localConfigDir, "opencode.jsonc"),
				JSON.stringify({
					instructions: ["{file:./prompts/shared.md}", "{file:./prompts/local-only.md}"],
				}),
			)

			const { scriptPath, outputPath } = await createConfigContentCaptureScript(testDir)
			const result = await runCLIIsolated(
				["oc", "--no-rename", "--profile", "work", "run", scriptPath, outputPath],
				testDir,
				{ OPENCODE_BIN: "bun" },
			)

			expect(result.exitCode).toBe(0)

			const payload = JSON.parse(await Bun.file(outputPath).text()) as {
				configContent: string | null
			}
			const parsedConfig = JSON.parse(payload.configContent as string) as {
				instructions?: string[]
			}
			const promptInstructions = (parsedConfig.instructions ?? []).filter((instruction) =>
				instruction.replaceAll("\\", "/").includes("prompts/"),
			)
			expect(promptInstructions).toEqual([
				`{file:${join(profileDir, "prompts", "profile-only.md")}}`,
				`{file:${join(profileDir, "prompts", "shared.md")}}`,
				"{file:./prompts/local-only.md}",
			])
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("tracks top-level plugin canonical dedupe ownership without rewriting local winners", async () => {
		const testDir = await createTempDir("oc-profile-relative-file-token-top-level-plugin")
		try {
			await createProfile(testDir, "work")

			const profileDir = join(testDir, "opencode", "profiles", "work")
			await Bun.write(
				join(profileDir, "opencode.jsonc"),
				JSON.stringify({
					plugin: [
						"npm:@scope/tool@1.0.0",
						"{file:./prompts/profile-plugin-token.md}",
						"npm:keep-profile",
					],
				}),
			)

			const localConfigDir = join(testDir, ".opencode")
			await mkdir(localConfigDir, { recursive: true })
			await Bun.write(
				join(localConfigDir, "opencode.jsonc"),
				JSON.stringify({
					plugin: ["npm:@scope/tool@2.0.0", "{file:./prompts/local-plugin-token.md}"],
				}),
			)

			const { scriptPath, outputPath } = await createConfigContentCaptureScript(testDir)
			const result = await runCLIIsolated(
				["oc", "--no-rename", "--profile", "work", "run", scriptPath, outputPath],
				testDir,
				{ OPENCODE_BIN: "bun" },
			)

			expect(result.exitCode).toBe(0)

			const payload = JSON.parse(await Bun.file(outputPath).text()) as {
				configContent: string | null
			}
			const parsedConfig = JSON.parse(payload.configContent as string) as {
				plugin?: string[]
			}
			expect(parsedConfig.plugin).toEqual([
				`{file:${join(profileDir, "prompts", "profile-plugin-token.md")}}`,
				"npm:keep-profile",
				"npm:@scope/tool@2.0.0",
				"{file:./prompts/local-plugin-token.md}",
			])
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("does not apply top-level instructions ownership rules to nested non-special arrays", async () => {
		const testDir = await createTempDir("oc-profile-relative-file-token-nested-array-replace")
		try {
			await createProfile(testDir, "work")

			const profileDir = join(testDir, "opencode", "profiles", "work")
			await Bun.write(
				join(profileDir, "opencode.jsonc"),
				JSON.stringify({
					agent: {
						planner: {
							options: {
								instructions: ["{file:./prompts/profile-nested.md}"],
							},
						},
					},
				}),
			)

			const localConfigDir = join(testDir, ".opencode")
			await mkdir(localConfigDir, { recursive: true })
			await Bun.write(
				join(localConfigDir, "opencode.jsonc"),
				JSON.stringify({
					agent: {
						planner: {
							options: {
								instructions: ["{file:./prompts/local-nested.md}"],
							},
						},
					},
				}),
			)

			const { scriptPath, outputPath } = await createConfigContentCaptureScript(testDir)
			const result = await runCLIIsolated(
				["oc", "--no-rename", "--profile", "work", "run", scriptPath, outputPath],
				testDir,
				{ OPENCODE_BIN: "bun" },
			)

			expect(result.exitCode).toBe(0)

			const payload = JSON.parse(await Bun.file(outputPath).text()) as {
				configContent: string | null
			}
			const parsedConfig = JSON.parse(payload.configContent as string) as {
				agent?: { planner?: { options?: { instructions?: string[] } } }
			}

			expect(parsedConfig.agent?.planner?.options?.instructions).toEqual([
				"{file:./prompts/local-nested.md}",
			])
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("keeps rewritten missing profile targets unresolved for upstream error handling", async () => {
		const testDir = await createTempDir("oc-profile-relative-file-token-missing-target")
		try {
			await createProfile(testDir, "work")

			const profileDir = join(testDir, "opencode", "profiles", "work")
			await Bun.write(
				join(profileDir, "opencode.jsonc"),
				JSON.stringify({
					agent: {
						planner: {
							prompt: "{file:./prompts/missing-planner.md}",
						},
					},
				}),
			)

			const { scriptPath, outputPath } = await createConfigContentCaptureScript(testDir)
			const result = await runCLIIsolated(
				["oc", "--no-rename", "--profile", "work", "run", scriptPath, outputPath],
				testDir,
				{ OPENCODE_BIN: "bun" },
			)

			expect(result.exitCode).toBe(0)

			const payload = JSON.parse(await Bun.file(outputPath).text()) as {
				configContent: string | null
			}
			const parsedConfig = JSON.parse(payload.configContent as string) as {
				agent?: { planner?: { prompt?: string } }
			}
			expect(parsedConfig.agent?.planner?.prompt).toBe(
				`{file:${join(profileDir, "prompts", "missing-planner.md")}}`,
			)
		} finally {
			await cleanupTempDir(testDir)
		}
	})
})

// =============================================================================
// PHASE 1 RED: buildOpenCodeEnv profile-aware behavior
// =============================================================================

describe("buildOpenCodeEnv (global-only profiles)", () => {
	it("sets OPENCODE_CONFIG_DIR to profile-specific dir when profile active", () => {
		// When a profile is active, OPENCODE_CONFIG_DIR must point to the
		// profile-specific directory, not the global root config path.
		const result = buildOpenCodeEnv({
			baseEnv: {},
			profileName: "work",
		})

		// Must contain the profile-specific path segment
		expect(result.OPENCODE_CONFIG_DIR).toContain("profiles/work")
	})

	it("OPENCODE_DISABLE_PROJECT_CONFIG is true only when profile is active", () => {
		// Active profile: MUST set OPENCODE_DISABLE_PROJECT_CONFIG
		const withProfile = buildOpenCodeEnv({
			baseEnv: {},
			profileName: "work",
		})
		expect(withProfile.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("true")

		// No profile: MUST NOT set OPENCODE_DISABLE_PROJECT_CONFIG
		const noProfile = buildOpenCodeEnv({
			baseEnv: {},
		})
		expect(noProfile.OPENCODE_DISABLE_PROJECT_CONFIG).toBeUndefined()
	})

	it("omits OPENCODE_DISABLE_PROJECT_CONFIG when no profile active", () => {
		// disableProjectConfig is no longer a parameter — it's derived from
		// profile presence. When no profileName is provided, the flag is omitted.
		const result = buildOpenCodeEnv({
			baseEnv: {},
			// No profileName — no profile active
		})

		// OPENCODE_DISABLE_PROJECT_CONFIG should be omitted when no profile is active
		expect(result.OPENCODE_DISABLE_PROJECT_CONFIG).toBeUndefined()
	})
})

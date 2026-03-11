import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanupTempDir, createTempDir, parseJsonc, runCLI } from "./helpers"
import { startLegacyFixtureRegistry } from "./legacy-fixture-registry"
import { type MockRegistry, startMockRegistry } from "./mock-registry"

/** Type for parsed ocx config in tests */
interface TestOcxConfig {
	registries: Record<string, { url: string; source?: string }>
	lockRegistries?: boolean
}

describe("ocx registry", () => {
	let testDir: string
	let registry: MockRegistry

	beforeEach(async () => {
		testDir = await createTempDir("registry-test")
		registry = startMockRegistry()
		await runCLI(["init"], testDir)
	})

	afterEach(async () => {
		registry.stop()
		await cleanupTempDir(testDir)
	})

	it("should add a registry", async () => {
		// Alias is user-chosen; does not need to match registry namespace
		const { exitCode, output } = await runCLI(
			["registry", "add", registry.url, "--name", "kdco"],
			testDir,
		)

		if (exitCode !== 0) {
			console.log(output)
		}
		expect(exitCode).toBe(0)
		expect(output).toContain("Added registry to local config: kdco")

		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const configContent = await Bun.file(configPath).text()
		const config = parseJsonc(configContent) as TestOcxConfig
		expect(config.registries.kdco).toBeDefined()
		expect(config.registries.kdco.url).toBe(registry.url)
	})

	it("should allow arbitrary alias that differs from registry namespace", async () => {
		// Registry declares namespace "kdco", but alias "my-custom-alias" should be accepted
		const { exitCode, output } = await runCLI(
			["registry", "add", registry.url, "--name", "my-custom-alias"],
			testDir,
		)

		if (exitCode !== 0) {
			console.log(output)
		}
		expect(exitCode).toBe(0)
		expect(output).toContain("Added registry to local config: my-custom-alias")

		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const configContent = await Bun.file(configPath).text()
		const config = parseJsonc(configContent) as TestOcxConfig
		expect(config.registries["my-custom-alias"]).toBeDefined()
		expect(config.registries["my-custom-alias"].url).toBe(registry.url)
	})

	it("should list configured registries", async () => {
		await runCLI(["registry", "add", registry.url, "--name", "kdco"], testDir)

		const { exitCode, output } = await runCLI(["registry", "list"], testDir)

		expect(exitCode).toBe(0)
		expect(output).toContain("kdco")
		expect(output).toContain(registry.url)
	})

	it("should remove a registry", async () => {
		await runCLI(["registry", "add", registry.url, "--name", "kdco"], testDir)

		const { exitCode, output } = await runCLI(["registry", "remove", "kdco"], testDir)

		expect(exitCode).toBe(0)
		expect(output).toContain("Removed registry from local config: kdco")

		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const configContent = await Bun.file(configPath).text()
		const config = parseJsonc(configContent) as TestOcxConfig
		expect(config.registries.kdco).toBeUndefined()
	})

	it("should fail if adding to locked registries", async () => {
		// Manually lock registries
		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const configContent = await Bun.file(configPath).text()
		const config = parseJsonc(configContent) as TestOcxConfig
		config.lockRegistries = true
		await Bun.write(configPath, JSON.stringify(config, null, 2))

		const { exitCode, output } = await runCLI(
			["registry", "add", "http://example.com", "--name", "test"],
			testDir,
		)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("Registries are locked")
	})

	it("should error when --name is not provided", async () => {
		const { exitCode, output } = await runCLI(["registry", "add", registry.url], testDir)

		expect(exitCode).not.toBe(0)
		// Commander requiredOption outputs: "error: required option '--name <name>' not specified"
		expect(output).toContain("--name")
	})
})

describe("registry add conflict matrix", () => {
	let testDir: string
	let registry: MockRegistry

	beforeEach(async () => {
		testDir = await createTempDir("registry-conflict-test")
		registry = startMockRegistry()
		await runCLI(["init"], testDir)
	})

	afterEach(async () => {
		registry.stop()
		await cleanupTempDir(testDir)
	})

	// Rule 1: New name + new URL => add (covered by "should add a registry" above)

	// Rule 2: Same name + same normalized URL => idempotent no-op
	it("should succeed idempotently when adding same name + same URL", async () => {
		// Add initial registry
		await runCLI(["registry", "add", registry.url, "--name", "kdco"], testDir)

		// Re-add with exact same name + URL
		const result = await runCLI(["registry", "add", registry.url, "--name", "kdco"], testDir)

		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain("Registry already configured (no changes): kdco")

		// Config unchanged
		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const configContent = await Bun.file(configPath).text()
		const config = parseJsonc(configContent) as TestOcxConfig
		expect(config.registries.kdco.url).toBe(registry.url)
	})

	// Rule 3: Same name + different URL => conflict error
	it("should fail when same name points to a different URL", async () => {
		// Add initial registry
		await runCLI(["registry", "add", registry.url, "--name", "kdco"], testDir)

		// Start a second mock registry to get a different valid URL
		const registry2 = startMockRegistry()
		try {
			const result = await runCLI(["registry", "add", registry2.url, "--name", "kdco"], testDir)

			expect(result.exitCode).toBe(6)
			expect(result.stderr).toContain("already exists")
			expect(result.stderr).toContain("ocx registry remove kdco")
			expect(result.stderr).not.toContain("--force")
		} finally {
			registry2.stop()
		}
	})

	// Rule 4: Different name + same URL => conflict error
	it("should fail when different name points to same URL", async () => {
		// Add initial registry
		await runCLI(["registry", "add", registry.url, "--name", "kdco"], testDir)

		// Try to add same URL under different name
		const result = await runCLI(["registry", "add", registry.url, "--name", "other-alias"], testDir)

		expect(result.exitCode).toBe(6)
		expect(result.stderr).toContain("already registered under name")
		expect(result.stderr).toContain("kdco")
		expect(result.stderr).toContain("ocx registry remove kdco")
		expect(result.stderr).not.toContain("--force")
	})

	it("should show current and new URL in name-conflict error message", async () => {
		// First add registry with original URL
		await runCLI(["registry", "add", registry.url, "--name", "kdco"], testDir)

		// Start a second mock registry to get a different valid URL
		const registry2 = startMockRegistry()
		try {
			// Try to update with a DIFFERENT URL (same name)
			const result = await runCLI(["registry", "add", registry2.url, "--name", "kdco"], testDir)

			// Error message should contain BOTH the existing and new URLs
			expect(result.stderr).toContain(registry.url) // existing URL
			expect(result.stderr).toContain(registry2.url) // new URL
		} finally {
			registry2.stop()
		}
	})

	it("should output structured JSON for name conflict with --json flag", async () => {
		// First add registry with original URL
		await runCLI(["registry", "add", registry.url, "--name", "kdco"], testDir)

		// Start a second mock registry to get a different valid URL
		const registry2 = startMockRegistry()
		try {
			// Try to add with DIFFERENT URL to trigger name conflict
			const result = await runCLI(
				["registry", "add", registry2.url, "--name", "kdco", "--json"],
				testDir,
			)

			expect(result.exitCode).toBe(6)
			const output = JSON.parse(result.stdout || result.stderr)
			expect(output.success).toBe(false)
			expect(output.error.code).toBe("CONFLICT")
			expect(output.error.details.conflictType).toBe("name")
			expect(output.error.details.registryName).toBe("kdco")
			// Assert BOTH URLs are different and both present
			expect(output.error.details.existingUrl).toBe(registry.url)
			expect(output.error.details.newUrl).toBe(registry2.url)
			expect(output.error.details.existingUrl).not.toBe(output.error.details.newUrl)
			expect(output.meta.timestamp).toBeDefined()
		} finally {
			registry2.stop()
		}
	})

	it("should output structured JSON for URL conflict with --json flag", async () => {
		// First add registry
		await runCLI(["registry", "add", registry.url, "--name", "kdco"], testDir)

		// Try to add same URL under different name with --json
		const result = await runCLI(
			["registry", "add", registry.url, "--name", "another-alias", "--json"],
			testDir,
		)

		expect(result.exitCode).toBe(6)
		const output = JSON.parse(result.stdout || result.stderr)
		expect(output.success).toBe(false)
		expect(output.error.code).toBe("CONFLICT")
		expect(output.error.details.conflictType).toBe("url")
		expect(output.error.details.registryName).toBe("another-alias")
		expect(output.error.details.existingName).toBe("kdco")
		expect(output.meta.timestamp).toBeDefined()
	})

	it("should error for empty URL", async () => {
		const result = await runCLI(["registry", "add", "", "--name", "test"], testDir)
		expect(result.exitCode).not.toBe(0)
		expect(result.stderr).toContain("Registry URL is required")
	})

	it("should error for whitespace-only URL", async () => {
		const result = await runCLI(["registry", "add", "   ", "--name", "test"], testDir)
		expect(result.exitCode).not.toBe(0)
		expect(result.stderr).toContain("Registry URL is required")
	})

	it("should error for invalid protocol", async () => {
		const result = await runCLI(["registry", "add", "ftp://example.com", "--name", "test"], testDir)
		expect(result.exitCode).not.toBe(0)
		expect(result.stderr).toContain("must use http or https")
	})
})

describe("registry add idempotent with --global", () => {
	let testDir: string
	let globalTestDir: string
	let registry: MockRegistry
	let env: Record<string, string>

	beforeEach(async () => {
		testDir = await createTempDir("registry-idempotent-global")
		globalTestDir = await createTempDir("registry-idempotent-global-config")
		registry = startMockRegistry()
		env = { XDG_CONFIG_HOME: globalTestDir }
		await runCLI(["init", "--global"], testDir, { env })
	})

	afterEach(async () => {
		registry.stop()
		await rm(globalTestDir, { recursive: true, force: true })
		await cleanupTempDir(testDir)
	})

	it("should succeed idempotently on --global registries with same name + same URL", async () => {
		await runCLI(["registry", "add", registry.url, "--name", "kdco", "--global"], testDir, {
			env,
		})

		const result = await runCLI(
			["registry", "add", registry.url, "--name", "kdco", "--global"],
			testDir,
			{ env },
		)

		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain("Registry already configured (no changes): kdco")
	})
})

describe("registry add idempotent with --profile", () => {
	let testDir: string
	let globalTestDir: string
	let registry: MockRegistry

	beforeEach(async () => {
		testDir = await createTempDir("registry-idempotent-profile")
		globalTestDir = await createTempDir("registry-idempotent-profile-global")
		registry = startMockRegistry()
		const env = { XDG_CONFIG_HOME: globalTestDir }

		// Use CLI to create global config and profile (belt-and-suspenders approach)
		await runCLI(["init", "--global"], testDir, { env })
		await runCLI(["profile", "add", "test-profile"], testDir, { env })

		// V2: Create profile ocx.jsonc
		const profileDir = join(globalTestDir, "opencode", "profiles", "test-profile")
		await Bun.write(
			join(profileDir, "ocx.jsonc"),
			JSON.stringify({ $schema: "https://ocx.kdco.dev/schemas/ocx.json", registries: {} }, null, 2),
		)
	})

	afterEach(async () => {
		registry.stop()
		await cleanupTempDir(testDir)
		await cleanupTempDir(globalTestDir)
	})

	it("should succeed idempotently on --profile registries with same name + same URL", async () => {
		const env = { XDG_CONFIG_HOME: globalTestDir }

		await runCLI(
			["registry", "add", registry.url, "--name", "kdco", "--profile", "test-profile"],
			testDir,
			{ env },
		)

		const result = await runCLI(
			["registry", "add", registry.url, "--name", "kdco", "--profile", "test-profile"],
			testDir,
			{ env },
		)

		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain("Registry already configured (no changes): kdco")
	})
})

describe("ocx registry --global", () => {
	let globalTestDir: string
	let globalConfigDir: string
	let testDir: string
	let registry: MockRegistry
	let env: Record<string, string>

	// Helper to read and parse config file
	async function readConfig(configPath: string): Promise<TestOcxConfig | null> {
		const file = Bun.file(configPath)
		if (!(await file.exists())) return null
		return parseJsonc(await file.text()) as TestOcxConfig
	}

	// Helper to check file doesn't exist
	async function assertFileNotExists(filePath: string): Promise<void> {
		const exists = await Bun.file(filePath).exists()
		expect(exists).toBe(false)
	}

	beforeEach(async () => {
		globalTestDir = await mkdtemp(join(tmpdir(), "registry-global-"))
		testDir = await createTempDir("registry-global-local")
		env = { XDG_CONFIG_HOME: globalTestDir }

		// Use CLI to create global config (belt-and-suspenders approach)
		await runCLI(["init", "--global"], testDir, { env })
		globalConfigDir = join(globalTestDir, "opencode")

		registry = startMockRegistry()
	})

	afterEach(async () => {
		registry.stop()
		await rm(globalTestDir, { recursive: true, force: true })
		await cleanupTempDir(testDir)
	})

	// Core functionality tests
	it("should add a registry to global config", async () => {
		const result = await runCLI(
			["registry", "add", "--global", registry.url, "--name", "kdco"],
			testDir,
			{ env },
		)
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain("Added registry to global config")

		// Verify correct data written to global config
		const globalConfig = await readConfig(join(globalConfigDir, "ocx.jsonc"))
		expect(globalConfig).not.toBeNull()
		expect(globalConfig?.registries.kdco).toEqual({ url: registry.url })

		// Verify local config was NOT created/modified
		await assertFileNotExists(join(testDir, ".opencode", "ocx.jsonc"))
	})

	it("should list registries from global config", async () => {
		// Set up global registry via CLI
		await runCLI(["registry", "add", registry.url, "--name", "kdco", "--global"], testDir, {
			env,
		})

		// Set up local registry via CLI in a separate project directory
		const localDir = await createTempDir("registry-list-local")
		await runCLI(["init"], localDir)
		await runCLI(["registry", "add", registry.url, "--name", "kdco"], localDir)

		// List global registries - should only show global, not local
		const result = await runCLI(["registry", "list", "--global", "--json"], localDir, { env })
		expect(result.exitCode).toBe(0)

		const output = JSON.parse(result.stdout)
		const registries = output.data?.registries || []

		// Global registry should be present
		expect(registries.find((r: { name: string }) => r.name === "kdco")).toBeDefined()
		// Since the local dir also has kdco (same alias), check count is exactly 1
		expect(registries.filter((r: { name: string }) => r.name === "kdco")).toHaveLength(1)

		// Cleanup
		await rm(localDir, { recursive: true, force: true })
	})

	it("should remove a registry from global config", async () => {
		// First add a registry
		await runCLI(["registry", "add", "--global", registry.url, "--name", "kdco"], testDir, {
			env,
		})

		// Verify it was added
		let globalConfig = await readConfig(join(globalConfigDir, "ocx.jsonc"))
		expect(globalConfig).not.toBeNull()
		expect(globalConfig?.registries.kdco).toBeDefined()

		// Now remove it
		const result = await runCLI(["registry", "remove", "--global", "kdco"], testDir, { env })
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain("Removed registry from global config")

		// Verify it was ACTUALLY removed from file
		globalConfig = await readConfig(join(globalConfigDir, "ocx.jsonc"))
		expect(globalConfig).not.toBeNull()
		expect(globalConfig?.registries.kdco).toBeUndefined()

		// Verify local config was NOT created as side effect
		await assertFileNotExists(join(testDir, ".opencode", "ocx.jsonc"))
		await assertFileNotExists(join(testDir, "ocx.jsonc"))
	})

	// Error handling tests
	it("should error when --global and --cwd are both provided", async () => {
		// Create a temp directory to use as --cwd target
		const cwdTarget = join(testDir, "cwd-target")
		await mkdir(cwdTarget, { recursive: true })

		// Capture original global config state
		const originalGlobalConfig = await Bun.file(join(globalConfigDir, "ocx.jsonc")).text()

		const result = await runCLI(
			["registry", "add", "--global", "--cwd", cwdTarget, registry.url, "--name", "test"],
			testDir,
			{ env },
		)
		expect(result.exitCode).toBe(1)
		expect(result.stderr).toContain("Cannot use both --global and --cwd")

		// Verify NO side effects - global config unchanged
		expect(await Bun.file(join(globalConfigDir, "ocx.jsonc")).text()).toBe(originalGlobalConfig)

		// Verify --cwd target was not modified (no .opencode or ocx.jsonc created)
		await assertFileNotExists(join(cwdTarget, ".opencode", "ocx.jsonc"))
		await assertFileNotExists(join(cwdTarget, "ocx.jsonc"))

		// Verify testDir local config was not created either
		await assertFileNotExists(join(testDir, ".opencode", "ocx.jsonc"))
	})

	it("should error when global config is missing (add)", async () => {
		// Remove global config
		await rm(join(globalConfigDir, "ocx.jsonc"))

		const result = await runCLI(
			["registry", "add", "--global", registry.url, "--name", "test"],
			testDir,
			{ env },
		)
		expect(result.exitCode).toBe(1)
		expect(result.stderr).toContain("global config not found")

		// Verify global config was NOT created as side effect
		await assertFileNotExists(join(globalConfigDir, "ocx.jsonc"))

		// Verify local config was NOT created as fallback
		await assertFileNotExists(join(testDir, ".opencode", "ocx.jsonc"))
	})

	it("should warn when global config is missing (list)", async () => {
		// Remove global config
		await rm(join(globalConfigDir, "ocx.jsonc"))

		const result = await runCLI(["registry", "list", "--global"], testDir, { env })
		expect(result.exitCode).toBe(0) // Should NOT error, just warn
		expect(result.stderr).toContain("global config not found")

		// Verify global config was NOT created
		await assertFileNotExists(join(globalConfigDir, "ocx.jsonc"))

		// Verify local config was NOT created as side effect
		await assertFileNotExists(join(testDir, ".opencode", "ocx.jsonc"))
		await assertFileNotExists(join(testDir, "ocx.jsonc"))
	})

	// CLI ordering tests - verify --global flag works in any position
	const globalFlagPositions = [
		{ name: "--global before URL", args: ["--global", "URL", "--name", "kdco"] },
		{ name: "--global after URL", args: ["URL", "--global", "--name", "kdco"] },
		{ name: "--global at end", args: ["URL", "--name", "kdco", "--global"] },
	]

	for (const { name, args } of globalFlagPositions) {
		it(`should work with ${name}`, async () => {
			// Replace URL placeholder with actual registry URL
			const actualArgs = ["registry", "add", ...args.map((a) => (a === "URL" ? registry.url : a))]
			const result = await runCLI(actualArgs, testDir, { env })
			expect(result.exitCode).toBe(0)

			// Verify data was actually written
			const globalConfig = await readConfig(join(globalConfigDir, "ocx.jsonc"))
			expect(globalConfig).not.toBeNull()
			expect(globalConfig?.registries.kdco).toEqual({ url: registry.url })

			// Verify local config was NOT created as side effect
			await assertFileNotExists(join(testDir, ".opencode", "ocx.jsonc"))
			await assertFileNotExists(join(testDir, "ocx.jsonc"))

			// Cleanup for next iteration: remove the registry
			await runCLI(["registry", "remove", "--global", "kdco"], testDir, { env })
		})
	}

	// Edge cases
	it("should handle locked registries in global config", async () => {
		// Write locked config
		const lockedConfig = { registries: {}, lockRegistries: true }
		await Bun.write(join(globalConfigDir, "ocx.jsonc"), JSON.stringify(lockedConfig, null, 2))

		// Capture original file content
		const originalGlobalConfig = await Bun.file(join(globalConfigDir, "ocx.jsonc")).text()

		const result = await runCLI(
			["registry", "add", "--global", registry.url, "--name", "blocked"],
			testDir,
			{ env },
		)
		expect(result.exitCode).toBe(1)
		expect(result.stderr).toContain("locked")

		// Verify global config was COMPLETELY unchanged (not just registries empty)
		const afterGlobalConfig = await Bun.file(join(globalConfigDir, "ocx.jsonc")).text()
		expect(afterGlobalConfig).toBe(originalGlobalConfig)

		// Verify local config was NOT created as fallback
		await assertFileNotExists(join(testDir, ".opencode", "ocx.jsonc"))
		await assertFileNotExists(join(testDir, "ocx.jsonc"))
	})

	it("should require --name for global registry (no default alias)", async () => {
		// Without --name, should fail (Commander requiredOption)
		const failResult = await runCLI(["registry", "add", "--global", registry.url], testDir, { env })
		expect(failResult.exitCode).not.toBe(0)
		expect(failResult.output).toContain("--name")

		// With --name, should succeed
		const result = await runCLI(
			["registry", "add", "--global", registry.url, "--name", "kdco"],
			testDir,
			{ env },
		)
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain("Added registry to global config")

		// Verify registry was written
		const globalConfig = await readConfig(join(globalConfigDir, "ocx.jsonc"))
		expect(globalConfig).not.toBeNull()
		expect(globalConfig?.registries.kdco).toBeDefined()

		// Verify local config was NOT created as side effect
		await assertFileNotExists(join(testDir, ".opencode", "ocx.jsonc"))
	})
})

describe("registry commands with --profile", () => {
	let testDir: string
	let globalTestDir: string
	let registry: MockRegistry

	/** Type for parsed ocx config in tests */
	interface ProfileTestOcxConfig {
		registries: Record<string, { url: string }>
	}

	beforeEach(async () => {
		testDir = await createTempDir("registry-profile")
		globalTestDir = await createTempDir("registry-profile-global")
		registry = startMockRegistry()
		const env = { XDG_CONFIG_HOME: globalTestDir }

		// Use CLI to create global config and profile (belt-and-suspenders approach)
		await runCLI(["init", "--global"], testDir, { env })
		await runCLI(["profile", "add", "test-profile"], testDir, { env })

		// V2: Create profile ocx.jsonc (profile add doesn't create it)
		const profileDir = join(globalTestDir, "opencode", "profiles", "test-profile")
		await Bun.write(
			join(profileDir, "ocx.jsonc"),
			JSON.stringify({ $schema: "https://ocx.kdco.dev/schemas/ocx.json", registries: {} }, null, 2),
		)
	})

	afterEach(async () => {
		registry.stop()
		await cleanupTempDir(testDir)
		await cleanupTempDir(globalTestDir)
	})

	it("should add registry to specific profile", async () => {
		// V2: Use mock registry
		const result = await runCLI(
			["registry", "add", registry.url, "--name", "kdco", "--profile", "test-profile"],
			testDir,
			{ env: { XDG_CONFIG_HOME: globalTestDir } },
		)
		expect(result.exitCode).toBe(0)

		// Verify registry was added to profile config
		const profileConfig = await Bun.file(
			join(globalTestDir, "opencode", "profiles", "test-profile", "ocx.jsonc"),
		).text()
		const config = JSON.parse(profileConfig) as ProfileTestOcxConfig
		expect(config.registries.kdco).toBeDefined()
		expect(config.registries.kdco.url).toBe(registry.url)
	})

	it("should list registries from specific profile", async () => {
		// First add a registry to profile (V2: use mock registry)
		await runCLI(
			["registry", "add", registry.url, "--name", "kdco", "--profile", "test-profile"],
			testDir,
			{ env: { XDG_CONFIG_HOME: globalTestDir } },
		)

		// Then list
		const result = await runCLI(
			["registry", "list", "--profile", "test-profile", "--json"],
			testDir,
			{ env: { XDG_CONFIG_HOME: globalTestDir } },
		)
		expect(result.exitCode).toBe(0)
		const output = JSON.parse(result.stdout)
		// JSON output: { success: true, data: { registries: [{ name, url, version }], locked } }
		const profileReg = output.data.registries.find((r: { name: string }) => r.name === "kdco")
		expect(profileReg).toBeDefined()
		expect(profileReg.url).toBe(registry.url)
	})

	it("should remove registry from specific profile", async () => {
		// First add a registry (V2: use mock registry)
		await runCLI(
			["registry", "add", registry.url, "--name", "kdco", "--profile", "test-profile"],
			testDir,
			{ env: { XDG_CONFIG_HOME: globalTestDir } },
		)

		// Then remove it
		const result = await runCLI(
			["registry", "remove", "kdco", "--profile", "test-profile"],
			testDir,
			{ env: { XDG_CONFIG_HOME: globalTestDir } },
		)
		expect(result.exitCode).toBe(0)

		// Verify it's gone
		const profileConfig = await Bun.file(
			join(globalTestDir, "opencode", "profiles", "test-profile", "ocx.jsonc"),
		).text()
		const config = JSON.parse(profileConfig) as ProfileTestOcxConfig
		expect(config.registries.kdco).toBeUndefined()
	})

	it("should error when using both --global and --profile", async () => {
		const result = await runCLI(
			[
				"registry",
				"add",
				"https://test.registry",
				"--name",
				"test",
				"--global",
				"--profile",
				"test-profile",
			],
			testDir,
			{ env: { XDG_CONFIG_HOME: globalTestDir } },
		)
		expect(result.exitCode).not.toBe(0)
		expect(result.stderr).toContain("Cannot use both --global and --profile")
	})

	it("should error when using both --cwd and --profile", async () => {
		const result = await runCLI(
			[
				"registry",
				"add",
				"https://test.registry",
				"--name",
				"test",
				"--cwd",
				testDir,
				"--profile",
				"test-profile",
			],
			testDir,
			{ env: { XDG_CONFIG_HOME: globalTestDir } },
		)
		expect(result.exitCode).not.toBe(0)
		expect(result.stderr).toContain("Cannot use both --cwd and --profile")
	})

	it("should error when profile does not exist", async () => {
		const result = await runCLI(
			["registry", "add", "https://test.registry", "--name", "test", "--profile", "nonexistent"],
			testDir,
			{ env: { XDG_CONFIG_HOME: globalTestDir } },
		)
		expect(result.exitCode).not.toBe(0)
		expect(result.stderr).toContain("not found")
	})

	it("should error when profiles directory not initialized", async () => {
		// Use a fresh temp dir with no profiles directory
		const emptyGlobalDir = await createTempDir("registry-profile-empty")

		const result = await runCLI(
			["registry", "add", "https://test.registry", "--name", "test", "--profile", "any-profile"],
			testDir,
			{ env: { XDG_CONFIG_HOME: emptyGlobalDir } },
		)
		expect(result.exitCode).not.toBe(0)
		expect(result.stderr).toContain("Profiles not initialized")

		await cleanupTempDir(emptyGlobalDir)
	})

	it("should error when profile exists but ocx.jsonc missing", async () => {
		// Create profile directory without ocx.jsonc
		const profileDir = join(globalTestDir, "opencode", "profiles", "no-config-profile")
		await mkdir(profileDir, { recursive: true })
		// Don't create ocx.jsonc

		const result = await runCLI(
			[
				"registry",
				"add",
				"https://test.registry",
				"--name",
				"test",
				"--profile",
				"no-config-profile",
			],
			testDir,
			{ env: { XDG_CONFIG_HOME: globalTestDir } },
		)
		expect(result.exitCode).not.toBe(0)
		expect(result.stderr).toContain("has no ocx.jsonc")
	})

	it("should error on invalid profile name", async () => {
		// Note: Empty string "" is handled by Commander and falls back to local scope,
		// so we skip it here. This tests the validateProfileName function.
		const invalidNames = [
			"../malicious",
			"foo/bar",
			".hidden",
			"-starts-dash",
			"1starts-digit", // Must start with letter, not digit
			"a".repeat(33), // 33 chars exceeds 32 char limit
			"has space",
		]

		for (const name of invalidNames) {
			const result = await runCLI(["registry", "list", "--profile", name], testDir, {
				env: { XDG_CONFIG_HOME: globalTestDir },
			})
			expect(result.exitCode).not.toBe(0)
			expect(result.stderr).toContain("Invalid profile name")
		}
	})

	it("should ignore OCX_PROFILE env var when listing without --profile flag", async () => {
		const env = { XDG_CONFIG_HOME: globalTestDir }

		// Set up profile with registry via CLI
		await runCLI(["profile", "add", "env-test-profile"], testDir, { env })
		await runCLI(
			["registry", "add", registry.url, "--name", "kdco", "--profile", "env-test-profile"],
			testDir,
			{ env },
		)

		// Set up local config with registry via CLI (V2: use mock registry)
		await runCLI(["init"], testDir)
		await runCLI(["registry", "add", registry.url, "--name", "kdco"], testDir)

		// List registries WITH OCX_PROFILE set but WITHOUT --profile flag
		// Should return LOCAL registries, ignoring the env var
		const result = await runCLI(["registry", "list", "--json"], testDir, {
			env: { ...env, OCX_PROFILE: "env-test-profile" },
		})

		expect(result.exitCode).toBe(0)
		const output = JSON.parse(result.stdout)

		// JSON output: { success: true, data: { registries: [{ name, url, version }], locked } }
		const localReg = output.data.registries.find((r: { name: string }) => r.name === "kdco")

		// Assert: local registry IS present (proves local scope used)
		expect(localReg).toBeDefined()
		// Since both use same alias (kdco), local wins (profile env var ignored)
		expect(output.data.registries).toHaveLength(1)
	})
})

describe("GitHub registry protocol", () => {
	let testDir: string
	let mockRegistry: MockRegistry

	beforeEach(async () => {
		testDir = await createTempDir("registry-github-test")
		await runCLI(["init"], testDir)
		mockRegistry = startMockRegistry()
	})

	afterEach(async () => {
		mockRegistry.stop()
		await cleanupTempDir(testDir)
	})

	it("should store and list GitHub registry with source field", async () => {
		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const configContent = await Bun.file(configPath).text()
		const config = parseJsonc(configContent) as TestOcxConfig

		config.registries["github-test"] = {
			url: mockRegistry.url,
		}
		config.registries["github-test-with-source"] = {
			url: mockRegistry.url,
			source: "github:test-org/test-repo@main",
		}

		await Bun.write(configPath, JSON.stringify(config, null, 2))

		const { exitCode, stdout } = await runCLI(["registry", "list", "--json"], testDir)

		expect(exitCode).toBe(0)
		const output = JSON.parse(stdout)
		const registries = output.data?.registries || []

		const regularReg = registries.find((r: { name: string }) => r.name === "github-test")
		expect(regularReg).toBeDefined()
		expect(regularReg.url).toBe(mockRegistry.url)
		expect(regularReg.source).toBeUndefined()

		const githubReg = registries.find((r: { name: string }) => r.name === "github-test-with-source")
		expect(githubReg).toBeDefined()
		expect(githubReg.source).toBe("github:test-org/test-repo@main")
		expect(githubReg.url).toBe(mockRegistry.url)
	})

	it("should remove GitHub registry with source field", async () => {
		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const configContent = await Bun.file(configPath).text()
		const config = parseJsonc(configContent) as TestOcxConfig

		config.registries["github-test"] = {
			url: mockRegistry.url,
			source: "github:test-org/test-repo",
		}

		await Bun.write(configPath, JSON.stringify(config, null, 2))

		const { exitCode, output } = await runCLI(["registry", "remove", "github-test"], testDir)

		expect(exitCode).toBe(0)
		expect(output).toContain("Removed registry from local config: github-test")

		const afterContent = await Bun.file(configPath).text()
		const afterConfig = parseJsonc(afterContent) as TestOcxConfig
		expect(afterConfig.registries["github-test"]).toBeUndefined()
	})

	it("should display github: source in human-readable list output", async () => {
		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const configContent = await Bun.file(configPath).text()
		const config = parseJsonc(configContent) as TestOcxConfig

		config.registries["gh-repo"] = {
			url: mockRegistry.url,
			source: "github:myorg/my-registry@v2",
		}

		await Bun.write(configPath, JSON.stringify(config, null, 2))

		const { exitCode, stdout } = await runCLI(["registry", "list"], testDir)

		expect(exitCode).toBe(0)
		expect(stdout).toContain("gh-repo")
		expect(stdout).toContain("github:myorg/my-registry@v2")
	})

	it("should preserve source field through add/remove operations", async () => {
		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const configContent = await Bun.file(configPath).text()
		const config = parseJsonc(configContent) as TestOcxConfig

		config.registries["test-1"] = {
			url: mockRegistry.url,
			source: "github:org/repo@main",
		}
		config.registries["test-2"] = {
			url: mockRegistry.url,
			source: "github:org/repo@develop",
		}

		await Bun.write(configPath, JSON.stringify(config, null, 2))

		await runCLI(["registry", "remove", "test-1"], testDir)

		const afterContent = await Bun.file(configPath).text()
		const afterConfig = parseJsonc(afterContent) as TestOcxConfig

		expect(afterConfig.registries["test-1"]).toBeUndefined()
		expect(afterConfig.registries["test-2"]).toBeDefined()
		expect(afterConfig.registries["test-2"].source).toBe("github:org/repo@develop")
	})

	it("should handle registries with and without source field together", async () => {
		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const configContent = await Bun.file(configPath).text()
		const config = parseJsonc(configContent) as TestOcxConfig

		config.registries["http-registry"] = {
			url: mockRegistry.url,
		}
		config.registries["github-registry"] = {
			url: mockRegistry.url,
			source: "github:test/repo",
		}

		await Bun.write(configPath, JSON.stringify(config, null, 2))

		const { exitCode, stdout } = await runCLI(["registry", "list", "--json"], testDir)

		expect(exitCode).toBe(0)
		const output = JSON.parse(stdout)
		const registries = output.data?.registries || []

		expect(registries).toHaveLength(2)
		const httpReg = registries.find((r: { name: string }) => r.name === "http-registry")
		const ghReg = registries.find((r: { name: string }) => r.name === "github-registry")

		expect(httpReg.source).toBeUndefined()
		expect(ghReg.source).toBe("github:test/repo")
	})

	it("should support source field with different ref formats", async () => {
		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const configContent = await Bun.file(configPath).text()
		const config = parseJsonc(configContent) as TestOcxConfig

		config.registries["branch-ref"] = {
			url: mockRegistry.url,
			source: "github:org/repo@develop",
		}
		config.registries["tag-ref"] = {
			url: mockRegistry.url,
			source: "github:org/repo@v1.2.3",
		}
		config.registries["sha-ref"] = {
			url: mockRegistry.url,
			source: "github:org/repo@abc123def456",
		}
		config.registries["slash-ref"] = {
			url: mockRegistry.url,
			source: "github:org/repo@feature/my-feature",
		}

		await Bun.write(configPath, JSON.stringify(config, null, 2))

		const { exitCode, stdout } = await runCLI(["registry", "list", "--json"], testDir)

		expect(exitCode).toBe(0)
		const output = JSON.parse(stdout)
		const registries = output.data?.registries || []

		expect(registries).toHaveLength(4)
		expect(registries.find((r: { name: string }) => r.name === "branch-ref").source).toBe(
			"github:org/repo@develop",
		)
		expect(registries.find((r: { name: string }) => r.name === "tag-ref").source).toBe(
			"github:org/repo@v1.2.3",
		)
		expect(registries.find((r: { name: string }) => r.name === "sha-ref").source).toBe(
			"github:org/repo@abc123def456",
		)
		expect(registries.find((r: { name: string }) => r.name === "slash-ref").source).toBe(
			"github:org/repo@feature/my-feature",
		)
	})
})

describe("registry add compatibility diagnostics", () => {
	let testDir: string
	const prefixedTypeCases = [
		{ prefixed: "ocx:agent", canonical: "agent" },
		{ prefixed: "ocx:skill", canonical: "skill" },
		{ prefixed: "ocx:plugin", canonical: "plugin" },
		{ prefixed: "ocx:command", canonical: "command" },
		{ prefixed: "ocx:tool", canonical: "tool" },
		{ prefixed: "ocx:profile", canonical: "profile" },
		{ prefixed: "ocx:bundle", canonical: "bundle" },
	] as const

	beforeEach(async () => {
		testDir = await createTempDir("registry-compat-test")
		await runCLI(["init"], testDir)
	})

	afterEach(async () => {
		await cleanupTempDir(testDir)
	})

	for (const typeCase of prefixedTypeCases) {
		it(`rejects v2 index using legacy prefixed type ${typeCase.prefixed}`, async () => {
			const server = Bun.serve({
				port: 0,
				fetch() {
					return Response.json({
						$schema: "https://ocx.kdco.dev/schemas/v2/registry.json",
						author: "Legacy",
						components: [
							{
								name: "prefixed-component",
								type: typeCase.prefixed,
								description: "Legacy prefixed type in a v2 payload",
							},
						],
					})
				},
			})

			try {
				const { exitCode, output } = await runCLI(
					["registry", "add", `http://localhost:${server.port}`, "--name", "legacy-v2"],
					testDir,
				)

				expect(exitCode).not.toBe(0)
				expect(output).toContain(typeCase.prefixed)
				expect(output).toContain(`Use "${typeCase.canonical}"`)
			} finally {
				server.stop()
			}
		})
	}

	it("accepts v2 indexes that already use canonical profile/bundle types", async () => {
		const server = Bun.serve({
			port: 0,
			fetch() {
				return Response.json({
					$schema: "https://ocx.kdco.dev/schemas/v2/registry.json",
					author: "Canonical",
					components: [
						{ name: "workspace", type: "bundle", description: "Workspace bundle" },
						{ name: "work-profile", type: "profile", description: "Work profile" },
					],
				})
			},
		})

		try {
			const { exitCode, output } = await runCLI(
				["registry", "add", `http://localhost:${server.port}`, "--name", "canonical-v2"],
				testDir,
			)

			expect(exitCode).toBe(0)
			expect(output).toContain("Added registry to local config: canonical-v2")
		} finally {
			server.stop()
		}
	})

	it("should accept legacy v1 object index for kdco/workspace", async () => {
		const fixtureRegistry = startLegacyFixtureRegistry("kdco")

		try {
			const { exitCode, output } = await runCLI(
				["registry", "add", fixtureRegistry.url, "--name", "kdco"],
				testDir,
			)

			expect(exitCode).toBe(0)
			expect(output).toContain("Added registry to local config: kdco")
		} finally {
			fixtureRegistry.stop()
		}
	})

	it("should accept legacy v1 object index in JSON mode for kit/ws and kit/omo", async () => {
		const fixtureRegistry = startLegacyFixtureRegistry("kit")

		try {
			const { exitCode, stdout, stderr } = await runCLI(
				["registry", "add", fixtureRegistry.url, "--name", "kit", "--json"],
				testDir,
			)

			expect(exitCode).toBe(0)
			const payload = JSON.parse(stdout || stderr)
			expect(payload.success).toBe(true)
			expect(payload.data.name).toBe("kit")
		} finally {
			fixtureRegistry.stop()
		}
	})

	it("should show actionable compatibility error for legacy array registry", async () => {
		// Start a server that returns an array (legacy format)
		const server = Bun.serve({
			port: 0,
			fetch() {
				return Response.json([{ name: "button", type: "plugin", description: "A button" }])
			},
		})

		try {
			const { exitCode, output } = await runCLI(
				["registry", "add", `http://localhost:${server.port}`, "--name", "legacy"],
				testDir,
			)

			expect(exitCode).not.toBe(0)
			expect(output).toContain("legacy schema v1")
			expect(output).toContain("object index payload")
			// Should NOT show raw Zod errors as the primary message
			expect(output).not.toMatch(/^.*Required$/m)
		} finally {
			server.stop()
		}
	})

	it("should show actionable compatibility error in JSON mode", async () => {
		const server = Bun.serve({
			port: 0,
			fetch() {
				return Response.json([{ name: "button" }])
			},
		})

		try {
			const { exitCode, stdout, stderr } = await runCLI(
				["registry", "add", `http://localhost:${server.port}`, "--name", "legacy", "--json"],
				testDir,
			)

			expect(exitCode).not.toBe(0)
			const jsonOutput = JSON.parse(stdout || stderr)
			expect(jsonOutput.success).toBe(false)
			expect(jsonOutput.error.code).toBe("REGISTRY_COMPAT_ERROR")
			expect(jsonOutput.error.details.issue).toBe("legacy-schema-v1")
			expect(jsonOutput.error.details.url).toContain("index.json")
			expect(jsonOutput.error.details.remediation).toBeDefined()
		} finally {
			server.stop()
		}
	})

	it("should show actionable error for unsupported schema major", async () => {
		const server = Bun.serve({
			port: 0,
			fetch() {
				return Response.json({
					$schema: "https://ocx.kdco.dev/schemas/v3/registry.json",
					author: "Legacy",
					components: [{ name: "button", type: "plugin", description: "A button" }],
				})
			},
		})

		try {
			const { exitCode, output } = await runCLI(
				["registry", "add", `http://localhost:${server.port}`, "--name", "incomplete"],
				testDir,
			)

			expect(exitCode).not.toBe(0)
			expect(output).toContain("unsupported-schema-version")
			expect(output).toContain("v2")
		} finally {
			server.stop()
		}
	})
})

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanupTempDir, createTempDir, parseJsonc, runCLI } from "./helpers"
import { type MockRegistry, startMockRegistry } from "./mock-registry"

/** Type for parsed ocx config in tests */
interface TestOcxConfig {
	registries: Record<string, { url: string }>
	lockRegistries?: boolean
}

describe("ocx registry", () => {
	let testDir: string
	let registry: MockRegistry

	beforeEach(async () => {
		testDir = await createTempDir("registry-test")
		registry = startMockRegistry()
		await runCLI(["init", "--force"], testDir)
	})

	afterEach(async () => {
		registry.stop()
		await cleanupTempDir(testDir)
	})

	it("should add a registry", async () => {
		const { exitCode, output } = await runCLI(
			["registry", "add", registry.url, "--name", "test-reg"],
			testDir,
		)

		if (exitCode !== 0) {
			console.log(output)
		}
		expect(exitCode).toBe(0)
		expect(output).toContain("Added registry to local config: test-reg")

		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const configContent = await Bun.file(configPath).text()
		const config = parseJsonc(configContent) as TestOcxConfig
		expect(config.registries["test-reg"]).toBeDefined()
		expect(config.registries["test-reg"].url).toBe(registry.url)
	})

	it("should list configured registries", async () => {
		await runCLI(["registry", "add", registry.url, "--name", "test-reg"], testDir)

		const { exitCode, output } = await runCLI(["registry", "list"], testDir)

		expect(exitCode).toBe(0)
		expect(output).toContain("test-reg")
		expect(output).toContain(registry.url)
	})

	it("should remove a registry", async () => {
		await runCLI(["registry", "add", registry.url, "--name", "test-reg"], testDir)

		const { exitCode, output } = await runCLI(["registry", "remove", "test-reg"], testDir)

		expect(exitCode).toBe(0)
		expect(output).toContain("Removed registry from local config: test-reg")

		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const configContent = await Bun.file(configPath).text()
		const config = parseJsonc(configContent) as TestOcxConfig
		expect(config.registries["test-reg"]).toBeUndefined()
	})

	it("should fail if adding to locked registries", async () => {
		// Manually lock registries
		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const configContent = await Bun.file(configPath).text()
		const config = parseJsonc(configContent) as TestOcxConfig
		config.lockRegistries = true
		await Bun.write(configPath, JSON.stringify(config, null, 2))

		const { exitCode, output } = await runCLI(["registry", "add", "http://example.com"], testDir)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("Registries are locked")
	})
})

describe("registry add --force", () => {
	let testDir: string
	let registry: MockRegistry

	beforeEach(async () => {
		testDir = await createTempDir("registry-force-test")
		registry = startMockRegistry()
		await runCLI(["init", "--force"], testDir)
	})

	afterEach(async () => {
		registry.stop()
		await cleanupTempDir(testDir)
	})

	it("should error when adding duplicate registry without --force", async () => {
		// Add initial registry
		await runCLI(["registry", "add", "https://example.com", "--name", "test"], testDir)

		// Try to add again without --force
		const result = await runCLI(["registry", "add", "https://new.com", "--name", "test"], testDir)

		expect(result.exitCode).toBe(6)
		expect(result.stderr).toContain("already exists")
		expect(result.stderr).toContain("--force")
	})

	it("should overwrite registry with --force flag", async () => {
		// Add initial registry
		await runCLI(["registry", "add", "https://old.com", "--name", "test"], testDir)

		// Overwrite with --force
		const result = await runCLI(
			["registry", "add", "https://new.com", "--name", "test", "--force"],
			testDir,
		)

		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain("Updated registry")

		// Verify URL was updated
		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const configContent = await Bun.file(configPath).text()
		const config = parseJsonc(configContent) as { registries: Record<string, { url: string }> }
		expect(config.registries.test.url).toBe("https://new.com")
	})

	it("should show current and new URL in error message", async () => {
		await runCLI(["registry", "add", "https://current.com", "--name", "test"], testDir)

		const result = await runCLI(["registry", "add", "https://new.com", "--name", "test"], testDir)

		expect(result.stderr).toContain("https://current.com")
		expect(result.stderr).toContain("https://new.com")
	})

	it("should output structured JSON for conflict with --json flag", async () => {
		await runCLI(["registry", "add", "https://old.com", "--name", "test"], testDir)

		const result = await runCLI(
			["registry", "add", "https://new.com", "--name", "test", "--json"],
			testDir,
		)

		expect(result.exitCode).toBe(6)
		const output = JSON.parse(result.stdout || result.stderr)
		expect(output.success).toBe(false)
		expect(output.error.code).toBe("CONFLICT")
		expect(output.error.details.registryName).toBe("test")
		expect(output.error.details.existingUrl).toBe("https://old.com")
		expect(output.error.details.newUrl).toBe("https://new.com")
		expect(output.meta.timestamp).toBeDefined()
	})

	it("should error for empty URL", async () => {
		const result = await runCLI(["registry", "add", ""], testDir)
		expect(result.exitCode).not.toBe(0)
		expect(result.stderr).toContain("Registry URL is required")
	})

	it("should error for whitespace-only URL", async () => {
		const result = await runCLI(["registry", "add", "   "], testDir)
		expect(result.exitCode).not.toBe(0)
		expect(result.stderr).toContain("Registry URL is required")
	})

	it("should error for invalid protocol", async () => {
		const result = await runCLI(["registry", "add", "ftp://example.com", "--name", "test"], testDir)
		expect(result.exitCode).not.toBe(0)
		expect(result.stderr).toContain("must use http or https")
	})
})

describe("registry add --force with --global", () => {
	let testDir: string
	let globalTestDir: string
	let registry: MockRegistry
	let env: Record<string, string>

	beforeEach(async () => {
		globalTestDir = await mkdtemp(join(tmpdir(), "registry-force-global-"))
		testDir = await createTempDir("registry-force-global-local")
		env = { XDG_CONFIG_HOME: globalTestDir }

		// Use CLI to create global config (belt-and-suspenders approach)
		await runCLI(["init", "--global"], testDir, { env })

		registry = startMockRegistry()
	})

	afterEach(async () => {
		registry.stop()
		await rm(globalTestDir, { recursive: true, force: true })
		await cleanupTempDir(testDir)
	})

	it("should work with --force on --global registries", async () => {
		await runCLI(["registry", "add", "https://old.com", "--name", "test", "--global"], testDir, {
			env,
		})

		const result = await runCLI(
			["registry", "add", "https://new.com", "--name", "test", "--global", "--force"],
			testDir,
			{ env },
		)

		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain("Updated registry")
	})
})

describe("registry add --force with --profile", () => {
	let testDir: string
	let globalTestDir: string

	beforeEach(async () => {
		testDir = await createTempDir("registry-force-profile")
		globalTestDir = await createTempDir("registry-force-profile-global")
		const env = { XDG_CONFIG_HOME: globalTestDir }

		// Use CLI to create global config and profile (belt-and-suspenders approach)
		await runCLI(["init", "--global"], testDir, { env })
		await runCLI(["profile", "add", "test-profile"], testDir, { env })
	})

	afterEach(async () => {
		await cleanupTempDir(testDir)
		await cleanupTempDir(globalTestDir)
	})

	it("should work with --force on --profile registries", async () => {
		const env = { XDG_CONFIG_HOME: globalTestDir }

		await runCLI(
			["registry", "add", "https://old.com", "--name", "test", "--profile", "test-profile"],
			testDir,
			{ env },
		)

		const result = await runCLI(
			[
				"registry",
				"add",
				"https://new.com",
				"--name",
				"test",
				"--profile",
				"test-profile",
				"--force",
			],
			testDir,
			{ env },
		)

		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain("Updated registry")
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
			["registry", "add", "--global", registry.url, "--name", "test-global"],
			testDir,
			{ env },
		)
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain("Added registry to global config")

		// Verify correct data written to global config
		const globalConfig = await readConfig(join(globalConfigDir, "ocx.jsonc"))
		expect(globalConfig).not.toBeNull()
		expect(globalConfig?.registries["test-global"]).toEqual({ url: registry.url })

		// Verify local config was NOT created/modified
		await assertFileNotExists(join(testDir, ".opencode", "ocx.jsonc"))
	})

	it("should list registries from global config", async () => {
		// Set up global registry via CLI
		await runCLI(["registry", "add", registry.url, "--name", "global-reg", "--global"], testDir, {
			env,
		})

		// Set up local registry via CLI in a separate project directory
		const localDir = await createTempDir("registry-list-local")
		await runCLI(["init"], localDir)
		await runCLI(["registry", "add", registry.url, "--name", "local-reg"], localDir)

		// List global registries - should only show global, not local
		const result = await runCLI(["registry", "list", "--global", "--json"], localDir, { env })
		expect(result.exitCode).toBe(0)

		const output = JSON.parse(result.stdout)
		const registries = output.data?.registries || []

		// Global registry should be present
		expect(registries.find((r: { name: string }) => r.name === "global-reg")).toBeDefined()
		// Local registry should NOT be present (isolation check)
		expect(registries.find((r: { name: string }) => r.name === "local-reg")).toBeUndefined()

		// Cleanup
		await rm(localDir, { recursive: true, force: true })
	})

	it("should remove a registry from global config", async () => {
		// First add a registry
		await runCLI(["registry", "add", "--global", registry.url, "--name", "test-remove"], testDir, {
			env,
		})

		// Verify it was added
		let globalConfig = await readConfig(join(globalConfigDir, "ocx.jsonc"))
		expect(globalConfig).not.toBeNull()
		expect(globalConfig?.registries["test-remove"]).toBeDefined()

		// Now remove it
		const result = await runCLI(["registry", "remove", "--global", "test-remove"], testDir, { env })
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain("Removed registry from global config")

		// Verify it was ACTUALLY removed from file
		globalConfig = await readConfig(join(globalConfigDir, "ocx.jsonc"))
		expect(globalConfig).not.toBeNull()
		expect(globalConfig?.registries["test-remove"]).toBeUndefined()

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
			["registry", "add", "--global", "--cwd", cwdTarget, registry.url],
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

		const result = await runCLI(["registry", "add", "--global", registry.url], testDir, { env })
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

	// CLI ordering tests
	it("should work with --global before URL", async () => {
		const result = await runCLI(
			["registry", "add", "--global", registry.url, "--name", "order1"],
			testDir,
			{ env },
		)
		expect(result.exitCode).toBe(0)

		// Verify data was actually written
		const globalConfig = await readConfig(join(globalConfigDir, "ocx.jsonc"))
		expect(globalConfig).not.toBeNull()
		expect(globalConfig?.registries.order1).toEqual({ url: registry.url })

		// Verify local config was NOT created as side effect
		await assertFileNotExists(join(testDir, ".opencode", "ocx.jsonc"))
		await assertFileNotExists(join(testDir, "ocx.jsonc"))
	})

	it("should work with --global after URL", async () => {
		const result = await runCLI(
			["registry", "add", registry.url, "--global", "--name", "order2"],
			testDir,
			{ env },
		)
		expect(result.exitCode).toBe(0)

		// Verify data was actually written
		const globalConfig = await readConfig(join(globalConfigDir, "ocx.jsonc"))
		expect(globalConfig).not.toBeNull()
		expect(globalConfig?.registries.order2).toEqual({ url: registry.url })

		// Verify local config was NOT created as side effect
		await assertFileNotExists(join(testDir, ".opencode", "ocx.jsonc"))
		await assertFileNotExists(join(testDir, "ocx.jsonc"))
	})

	it("should work with --global at end", async () => {
		const result = await runCLI(
			["registry", "add", registry.url, "--name", "order3", "--global"],
			testDir,
			{ env },
		)
		expect(result.exitCode).toBe(0)

		// Verify data was actually written
		const globalConfig = await readConfig(join(globalConfigDir, "ocx.jsonc"))
		expect(globalConfig).not.toBeNull()
		expect(globalConfig?.registries.order3).toEqual({ url: registry.url })

		// Verify local config was NOT created as side effect
		await assertFileNotExists(join(testDir, ".opencode", "ocx.jsonc"))
		await assertFileNotExists(join(testDir, "ocx.jsonc"))
	})

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

	it("should auto-generate name from URL for global registry", async () => {
		const result = await runCLI(["registry", "add", "--global", registry.url], testDir, { env })
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain("Added registry to global config")

		// Verify auto-generated name was written
		const globalConfig = await readConfig(join(globalConfigDir, "ocx.jsonc"))
		expect(globalConfig).not.toBeNull()
		const keys = Object.keys(globalConfig?.registries)
		expect(keys).toHaveLength(1)

		// Name should be derived from hostname (localhost or 127-0-0-1 depending on registry.url)
		const generatedName = keys[0]
		expect(generatedName).toMatch(/^(localhost|127-0-0-1)$/)
		expect(globalConfig?.registries[generatedName]).toEqual({ url: registry.url })

		// Verify local config was NOT created as side effect
		await assertFileNotExists(join(testDir, ".opencode", "ocx.jsonc"))
		await assertFileNotExists(join(testDir, "ocx.jsonc"))
	})
})

describe("registry commands with --profile", () => {
	let testDir: string
	let globalTestDir: string

	/** Type for parsed ocx config in tests */
	interface ProfileTestOcxConfig {
		registries: Record<string, { url: string }>
	}

	beforeEach(async () => {
		testDir = await createTempDir("registry-profile")
		globalTestDir = await createTempDir("registry-profile-global")
		const env = { XDG_CONFIG_HOME: globalTestDir }

		// Use CLI to create global config and profile (belt-and-suspenders approach)
		await runCLI(["init", "--global"], testDir, { env })
		await runCLI(["profile", "add", "test-profile"], testDir, { env })
	})

	afterEach(async () => {
		await cleanupTempDir(testDir)
		await cleanupTempDir(globalTestDir)
	})

	it("should add registry to specific profile", async () => {
		const result = await runCLI(
			[
				"registry",
				"add",
				"https://test.registry",
				"--name",
				"test-reg",
				"--profile",
				"test-profile",
			],
			testDir,
			{ env: { XDG_CONFIG_HOME: globalTestDir } },
		)
		expect(result.exitCode).toBe(0)

		// Verify registry was added to profile config
		const profileConfig = await Bun.file(
			join(globalTestDir, "opencode", "profiles", "test-profile", "ocx.jsonc"),
		).text()
		const config = JSON.parse(profileConfig) as ProfileTestOcxConfig
		expect(config.registries["test-reg"]).toBeDefined()
		expect(config.registries["test-reg"].url).toBe("https://test.registry")
	})

	it("should list registries from specific profile", async () => {
		// First add a registry to profile
		await runCLI(
			[
				"registry",
				"add",
				"https://test.registry",
				"--name",
				"profile-reg",
				"--profile",
				"test-profile",
			],
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
		const profileReg = output.data.registries.find(
			(r: { name: string }) => r.name === "profile-reg",
		)
		expect(profileReg).toBeDefined()
		expect(profileReg.url).toBe("https://test.registry")
	})

	it("should remove registry from specific profile", async () => {
		// First add a registry
		await runCLI(
			[
				"registry",
				"add",
				"https://test.registry",
				"--name",
				"to-remove",
				"--profile",
				"test-profile",
			],
			testDir,
			{ env: { XDG_CONFIG_HOME: globalTestDir } },
		)

		// Then remove it
		const result = await runCLI(
			["registry", "remove", "to-remove", "--profile", "test-profile"],
			testDir,
			{ env: { XDG_CONFIG_HOME: globalTestDir } },
		)
		expect(result.exitCode).toBe(0)

		// Verify it's gone
		const profileConfig = await Bun.file(
			join(globalTestDir, "opencode", "profiles", "test-profile", "ocx.jsonc"),
		).text()
		const config = JSON.parse(profileConfig) as ProfileTestOcxConfig
		expect(config.registries["to-remove"]).toBeUndefined()
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
			[
				"registry",
				"add",
				"https://profile.test",
				"--name",
				"profile-reg",
				"--profile",
				"env-test-profile",
			],
			testDir,
			{ env },
		)

		// Set up local config with registry via CLI
		await runCLI(["init"], testDir)
		await runCLI(["registry", "add", "https://local.test", "--name", "local-reg"], testDir)

		// List registries WITH OCX_PROFILE set but WITHOUT --profile flag
		// Should return LOCAL registries, ignoring the env var
		const result = await runCLI(["registry", "list", "--json"], testDir, {
			env: { ...env, OCX_PROFILE: "env-test-profile" },
		})

		expect(result.exitCode).toBe(0)
		const output = JSON.parse(result.stdout)

		// JSON output: { success: true, data: { registries: [{ name, url, version }], locked } }
		const localReg = output.data.registries.find((r: { name: string }) => r.name === "local-reg")
		const profileReg = output.data.registries.find(
			(r: { name: string }) => r.name === "profile-reg",
		)

		// Assert: local registry IS present (proves local scope used)
		expect(localReg).toBeDefined()

		// Assert: profile registry is NOT present (proves env var ignored)
		expect(profileReg).toBeUndefined()
	})
})

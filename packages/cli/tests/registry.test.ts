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

		// Create global config directory and file
		globalConfigDir = join(globalTestDir, "opencode")
		await mkdir(globalConfigDir, { recursive: true })
		await Bun.write(join(globalConfigDir, "ocx.jsonc"), JSON.stringify({ registries: {} }, null, 2))

		registry = startMockRegistry()
		env = { XDG_CONFIG_HOME: globalTestDir }
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
		expect(globalConfig!.registries["test-global"]).toEqual({ url: registry.url })

		// Verify local config was NOT created/modified
		await assertFileNotExists(join(testDir, ".opencode", "ocx.jsonc"))
	})

	it("should list registries from global config", async () => {
		// Setup: Create BOTH global and local configs with different registries
		await Bun.write(
			join(globalConfigDir, "ocx.jsonc"),
			JSON.stringify({ registries: { "global-only": { url: registry.url } } }, null, 2),
		)

		// Create a local config with a different registry
		const projectDir = join(testDir, "project")
		const localConfigDir = join(projectDir, ".opencode")
		await mkdir(localConfigDir, { recursive: true })
		await Bun.write(
			join(localConfigDir, "ocx.jsonc"),
			JSON.stringify({ registries: { "local-only": { url: "http://local.test" } } }, null, 2),
		)

		// Capture original file contents for side-effect check
		const originalGlobalConfig = await Bun.file(join(globalConfigDir, "ocx.jsonc")).text()
		const originalLocalConfig = await Bun.file(join(localConfigDir, "ocx.jsonc")).text()

		// Run from project directory but with --global
		const result = await runCLI(["registry", "list", "--global"], projectDir, { env })

		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain("(global)")
		expect(result.stdout).toContain("global-only")
		expect(result.stdout).toContain(registry.url) // Should show global URL
		expect(result.stdout).not.toContain("local-only") // Must NOT show local registry name
		expect(result.stdout).not.toContain("http://local.test") // Must NOT show local URL

		// Verify no side effects - configs unchanged
		expect(await Bun.file(join(globalConfigDir, "ocx.jsonc")).text()).toBe(originalGlobalConfig)
		expect(await Bun.file(join(localConfigDir, "ocx.jsonc")).text()).toBe(originalLocalConfig)
	})

	it("should remove a registry from global config", async () => {
		// First add a registry
		await runCLI(["registry", "add", "--global", registry.url, "--name", "test-remove"], testDir, {
			env,
		})

		// Verify it was added
		let globalConfig = await readConfig(join(globalConfigDir, "ocx.jsonc"))
		expect(globalConfig).not.toBeNull()
		expect(globalConfig!.registries["test-remove"]).toBeDefined()

		// Now remove it
		const result = await runCLI(["registry", "remove", "--global", "test-remove"], testDir, { env })
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain("Removed registry from global config")

		// Verify it was ACTUALLY removed from file
		globalConfig = await readConfig(join(globalConfigDir, "ocx.jsonc"))
		expect(globalConfig).not.toBeNull()
		expect(globalConfig!.registries["test-remove"]).toBeUndefined()

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
		expect(result.stderr).toContain("Cannot use --global with --cwd")

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
		expect(result.stderr).toContain("Global config not found")

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
		expect(result.stderr).toContain("Global config not found")

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
		expect(globalConfig!.registries.order1).toEqual({ url: registry.url })

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
		expect(globalConfig!.registries.order2).toEqual({ url: registry.url })

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
		expect(globalConfig!.registries.order3).toEqual({ url: registry.url })

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
		const keys = Object.keys(globalConfig!.registries)
		expect(keys).toHaveLength(1)

		// Name should be derived from hostname (localhost or 127-0-0-1 depending on registry.url)
		const generatedName = keys[0]
		expect(generatedName).toMatch(/^(localhost|127-0-0-1)$/)
		expect(globalConfig!.registries[generatedName]).toEqual({ url: registry.url })

		// Verify local config was NOT created as side effect
		await assertFileNotExists(join(testDir, ".opencode", "ocx.jsonc"))
		await assertFileNotExists(join(testDir, "ocx.jsonc"))
	})
})

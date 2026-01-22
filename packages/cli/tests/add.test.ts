import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir, parseJsonc, runCLI } from "./helpers"
import { type MockRegistry, startMockRegistry } from "./mock-registry"

describe("ocx add", () => {
	let testDir: string
	let registry: MockRegistry

	beforeAll(() => {
		registry = startMockRegistry()
	})

	afterAll(() => {
		registry.stop()
	})

	afterEach(async () => {
		if (testDir) {
			await cleanupTempDir(testDir)
		}
	})

	it("should fail if not initialized", async () => {
		testDir = await createTempDir("add-no-init")
		const { exitCode, output } = await runCLI(["add", "test-comp"], testDir)
		expect(exitCode).not.toBe(0)
		expect(output).toContain("Run 'ocx init' first")
	})

	it("should install a component and its dependencies", async () => {
		testDir = await createTempDir("add-basic")

		// Init and add registry
		await runCLI(["init", "--force"], testDir)

		// Manually add registry to config since 'ocx registry add' might be flaky in parallel tests
		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const config = parseJsonc(await readFile(configPath, "utf-8"))
		config.registries = {
			kdco: { url: registry.url },
		}
		await writeFile(configPath, JSON.stringify(config, null, 2))

		// Install agent which depends on skill which depends on plugin
		const { exitCode, output } = await runCLI(["add", "kdco/test-agent", "--force"], testDir)

		if (exitCode !== 0) {
			console.log(output)
		}
		expect(exitCode).toBe(0)

		// Verify files
		expect(existsSync(join(testDir, ".opencode/agent/test-agent.md"))).toBe(true)
		expect(existsSync(join(testDir, ".opencode/skill/test-skill/SKILL.md"))).toBe(true)
		expect(existsSync(join(testDir, ".opencode/plugin/test-plugin.ts"))).toBe(true)

		// Verify lock file
		const lockPath = join(testDir, ".opencode/ocx.lock")
		expect(existsSync(lockPath)).toBe(true)
		const lock = parseJsonc(await readFile(lockPath, "utf-8"))
		expect(lock.installed["kdco/test-agent"]).toBeDefined()
		expect(lock.installed["kdco/test-skill"]).toBeDefined()
		expect(lock.installed["kdco/test-plugin"]).toBeDefined()

		// Verify opencode.jsonc patching (new files default to .jsonc)
		const opencodePath = join(testDir, ".opencode", "opencode.jsonc")
		expect(existsSync(opencodePath)).toBe(true)
		const opencode = parseJsonc(await readFile(opencodePath, "utf-8"))
		expect(opencode.mcp["test-mcp"]).toBeDefined()
		expect(opencode.mcp["test-mcp"].url).toBe("https://mcp.test.com")
	})

	it("should skip files with identical content", async () => {
		testDir = await createTempDir("add-skip-identical")

		// Init and add registry
		await runCLI(["init", "--force"], testDir)

		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const config = parseJsonc(await readFile(configPath, "utf-8"))
		config.registries = {
			kdco: { url: registry.url },
		}
		await writeFile(configPath, JSON.stringify(config, null, 2))

		// Install component first time
		const { exitCode: firstExitCode } = await runCLI(
			["add", "kdco/test-plugin", "--force"],
			testDir,
		)
		expect(firstExitCode).toBe(0)

		// Install same component again (should skip, not fail)
		const { exitCode } = await runCLI(["add", "kdco/test-plugin", "--force"], testDir)
		expect(exitCode).toBe(0)
		// File should still exist
		expect(existsSync(join(testDir, ".opencode/plugin/test-plugin.ts"))).toBe(true)
	})

	it("should fail on conflict without --force flag", async () => {
		testDir = await createTempDir("add-conflict-no-yes")

		// Init and add registry
		await runCLI(["init", "--force"], testDir)

		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const config = parseJsonc(await readFile(configPath, "utf-8"))
		config.registries = {
			kdco: { url: registry.url },
		}
		await writeFile(configPath, JSON.stringify(config, null, 2))

		// Install component first time
		await runCLI(["add", "kdco/test-plugin", "--force"], testDir)

		// Modify the file to create a conflict
		const filePath = join(testDir, ".opencode/plugin/test-plugin.ts")
		await writeFile(filePath, "// Modified by user")

		// Try to install again WITHOUT --force (should fail with conflict)
		const { exitCode, output } = await runCLI(["add", "kdco/test-plugin"], testDir)
		expect(exitCode).not.toBe(0)
		expect(output).toContain("conflict")
		expect(output).toContain("--force")
	})

	it("should overwrite conflicting files with --force flag", async () => {
		testDir = await createTempDir("add-overwrite-yes")

		// Init and add registry
		await runCLI(["init", "--force"], testDir)

		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const config = parseJsonc(await readFile(configPath, "utf-8"))
		config.registries = {
			kdco: { url: registry.url },
		}
		await writeFile(configPath, JSON.stringify(config, null, 2))

		// Install component first time
		await runCLI(["add", "kdco/test-plugin", "--force"], testDir)

		// Modify the file to create a conflict
		const filePath = join(testDir, ".opencode/plugin/test-plugin.ts")
		await writeFile(filePath, "// Modified by user")

		// Install again WITH --force (should overwrite)
		const { exitCode } = await runCLI(["add", "kdco/test-plugin", "--force"], testDir)
		expect(exitCode).toBe(0)

		// File should be restored to original content
		const content = await readFile(filePath, "utf-8")
		expect(content).not.toContain("Modified by user")
	})

	it("should preserve mcp from dependencies when main component has no mcp (regression)", async () => {
		testDir = await createTempDir("add-mcp-regression")

		// Init and add registry
		await runCLI(["init", "--force"], testDir)

		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const config = parseJsonc(await readFile(configPath, "utf-8"))
		config.registries = {
			kdco: { url: registry.url },
		}
		await writeFile(configPath, JSON.stringify(config, null, 2))

		// Install test-no-mcp which depends on test-mcp-provider
		// test-mcp-provider has MCP config, test-no-mcp does not
		// This tests the regression where MCP was lost due to undefined overwriting
		const { exitCode, output } = await runCLI(["add", "kdco/test-no-mcp", "--force"], testDir)

		if (exitCode !== 0) {
			console.log(output)
		}
		expect(exitCode).toBe(0)

		// Verify opencode.jsonc has MCP from dependency
		const opencodePath = join(testDir, ".opencode", "opencode.jsonc")
		expect(existsSync(opencodePath)).toBe(true)
		const opencode = parseJsonc(await readFile(opencodePath, "utf-8"))

		// MCP from test-mcp-provider should be preserved
		expect(opencode.mcp).toBeDefined()
		expect(opencode.mcp["provider-mcp"]).toBeDefined()
		expect(opencode.mcp["provider-mcp"].url).toBe("https://mcp.provider.com")

		// Tools from test-no-mcp should also be present
		expect(opencode.tools).toBeDefined()
		expect(opencode.tools["some-tool"]).toBe(true)
	})

	it("should concatenate plugin arrays from multiple components", async () => {
		testDir = await createTempDir("add-plugin-concat")

		// Init and add registry
		await runCLI(["init", "--force"], testDir)

		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const config = parseJsonc(await readFile(configPath, "utf-8"))
		config.registries = {
			kdco: { url: registry.url },
		}
		await writeFile(configPath, JSON.stringify(config, null, 2))

		// Install test-no-mcp which depends on test-mcp-provider
		// Both have plugin arrays that should be concatenated
		const { exitCode, output } = await runCLI(["add", "kdco/test-no-mcp", "--force"], testDir)

		if (exitCode !== 0) {
			console.log(output)
		}
		expect(exitCode).toBe(0)

		// Verify opencode.jsonc has plugins from both components
		const opencodePath = join(testDir, ".opencode", "opencode.jsonc")
		const opencode = parseJsonc(await readFile(opencodePath, "utf-8"))

		expect(opencode.plugin).toBeDefined()
		expect(opencode.plugin).toContain("provider-plugin")
		expect(opencode.plugin).toContain("no-mcp-plugin")
	})

	it("should fail if integrity check fails", async () => {
		testDir = await createTempDir("add-integrity-fail")

		// Init and add registry
		await runCLI(["init", "--force"], testDir)

		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const config = parseJsonc(await readFile(configPath, "utf-8"))
		config.registries = {
			kdco: { url: registry.url },
		}
		await writeFile(configPath, JSON.stringify(config, null, 2))

		// 1. Install normally to create lock entry
		await runCLI(["add", "kdco/test-plugin", "--force"], testDir)

		// 2. Tamper with the registry content
		registry.setFileContent("test-plugin", "index.ts", "TAMPERED CONTENT")

		// 3. Try to add again (should fail integrity check)
		const { exitCode, output } = await runCLI(["add", "kdco/test-plugin", "--force"], testDir)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("Integrity verification failed")
		expect(output).toContain("The registry content has changed since this component was locked")
	})
})

describe("ocx add --profile", () => {
	let testDir: string
	let profileDir: string
	let registry: MockRegistry
	const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

	beforeAll(() => {
		registry = startMockRegistry()
	})

	afterAll(() => {
		registry.stop()
	})

	beforeEach(async () => {
		// Create temp directory for XDG_CONFIG_HOME
		testDir = await createTempDir("add-profile")
		process.env.XDG_CONFIG_HOME = testDir

		// Create profile directory with ocx.jsonc containing registry
		profileDir = join(testDir, "opencode", "profiles", "test-profile")
		await mkdir(profileDir, { recursive: true })

		const ocxConfig = {
			registries: {
				kdco: { url: registry.url },
			},
		}
		await writeFile(join(profileDir, "ocx.jsonc"), JSON.stringify(ocxConfig, null, 2))
	})

	afterEach(async () => {
		if (originalXdgConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME
		} else {
			process.env.XDG_CONFIG_HOME = originalXdgConfigHome
		}
		if (testDir) {
			await cleanupTempDir(testDir)
		}
	})

	it("should install to flattened paths in profile directory", async () => {
		// Create a working directory (separate from profile)
		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		const { exitCode, output } = await runCLI(
			["add", "kdco/test-plugin", "--profile", "test-profile", "--force"],
			workDir,
		)

		if (exitCode !== 0) {
			console.log(output)
		}
		expect(exitCode).toBe(0)

		// Verify file installed to flattened path (plugin/, not .opencode/plugin/)
		expect(existsSync(join(profileDir, "plugin", "test-plugin.ts"))).toBe(true)

		// Verify NOT installed to nested .opencode/ path
		expect(existsSync(join(profileDir, ".opencode", "plugin", "test-plugin.ts"))).toBe(false)
	})

	it("should install component with dependencies to flattened paths", async () => {
		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		// Install agent which depends on skill which depends on plugin
		const { exitCode, output } = await runCLI(
			["add", "kdco/test-agent", "--profile", "test-profile", "--force"],
			workDir,
		)

		if (exitCode !== 0) {
			console.log(output)
		}
		expect(exitCode).toBe(0)

		// Verify all installed to flattened paths
		expect(existsSync(join(profileDir, "agent", "test-agent.md"))).toBe(true)
		expect(existsSync(join(profileDir, "skill", "test-skill", "SKILL.md"))).toBe(true)
		expect(existsSync(join(profileDir, "plugin", "test-plugin.ts"))).toBe(true)

		// Verify lock file at profile root
		expect(existsSync(join(profileDir, "ocx.lock"))).toBe(true)
	})

	it("should place package.json at profile root, not in .opencode/", async () => {
		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		const { exitCode } = await runCLI(
			["add", "kdco/test-plugin", "--profile", "test-profile", "--force"],
			workDir,
		)

		expect(exitCode).toBe(0)

		// package.json should be at profile root
		expect(existsSync(join(profileDir, "package.json"))).toBe(true)

		// NOT in .opencode/
		expect(existsSync(join(profileDir, ".opencode", "package.json"))).toBe(false)
	})

	it("should work without local init when --profile is provided", async () => {
		// Create workspace with NO .opencode/ directory (not initialized)
		const workDir = join(testDir, "uninitialized-project")
		await mkdir(workDir, { recursive: true })

		// Should NOT have .opencode
		expect(existsSync(join(workDir, ".opencode"))).toBe(false)

		const { exitCode, output } = await runCLI(
			["add", "kdco/test-plugin", "--profile", "test-profile", "--force"],
			workDir,
		)

		// Should succeed without "Run 'ocx init' first" error
		expect(exitCode).toBe(0)
		expect(output).not.toContain("Run 'ocx init' first")

		// Component installed to profile, not workDir
		expect(existsSync(join(profileDir, "plugin", "test-plugin.ts"))).toBe(true)
		expect(existsSync(join(workDir, ".opencode"))).toBe(false)
	})

	it("should detect conflicts at flattened paths", async () => {
		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		// First install
		await runCLI(["add", "kdco/test-plugin", "--profile", "test-profile", "--force"], workDir)

		// Modify the file to create a conflict
		const filePath = join(profileDir, "plugin", "test-plugin.ts")
		await writeFile(filePath, "// Modified by user")

		// Try to reinstall WITHOUT --force
		const { exitCode, output } = await runCLI(
			["add", "kdco/test-plugin", "--profile", "test-profile"],
			workDir,
		)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("conflict")
	})
})

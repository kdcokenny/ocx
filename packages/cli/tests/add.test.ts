import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { handleError } from "../src/utils/handle-error"
import { cleanupTempDir, createTempDir, parseJsonc, runCLI } from "./helpers"
import { startLegacyFixtureRegistry } from "./legacy-fixture-registry"
import { type MockRegistry, startMockRegistry } from "./mock-registry"

let addImportCounter = 0

async function importAddCommandModule() {
	const cacheBuster = addImportCounter++
	return import(`../src/commands/add?test=${cacheBuster}`)
}

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
		await runCLI(["init"], testDir)

		// Manually add registry to config since 'ocx registry add' might be flaky in parallel tests
		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const config = parseJsonc(await readFile(configPath, "utf-8"))
		config.registries = {
			kdco: { url: registry.url },
		}
		await writeFile(configPath, JSON.stringify(config, null, 2))

		// Install agent which depends on skill which depends on plugin
		const { exitCode, output } = await runCLI(["add", "kdco/test-agent"], testDir)

		if (exitCode !== 0) {
			console.log(output)
		}
		expect(exitCode).toBe(0)

		// Verify files (V2: root-relative paths)
		expect(existsSync(join(testDir, ".opencode", "agents", "test-agent.md"))).toBe(true)
		expect(existsSync(join(testDir, ".opencode", "skills", "test-skill", "SKILL.md"))).toBe(true)
		expect(existsSync(join(testDir, ".opencode", "plugins", "test-plugin.ts"))).toBe(true)

		// V1: Verify receipt file (replaces ocx.lock)
		const receiptPath = join(testDir, ".ocx/receipt.jsonc")
		expect(existsSync(receiptPath)).toBe(true)
		const receipt = parseJsonc(await readFile(receiptPath, "utf-8"))
		// V2: Receipt uses canonical IDs as keys
		const installedKeys = Object.keys(receipt.installed)
		expect(installedKeys.length).toBe(3)
		expect(installedKeys.some((k) => k.includes("test-agent"))).toBe(true)
		expect(installedKeys.some((k) => k.includes("test-skill"))).toBe(true)
		expect(installedKeys.some((k) => k.includes("test-plugin"))).toBe(true)

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
		await runCLI(["init"], testDir)

		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const config = parseJsonc(await readFile(configPath, "utf-8"))
		config.registries = {
			kdco: { url: registry.url },
		}
		await writeFile(configPath, JSON.stringify(config, null, 2))

		// Install component first time
		const { exitCode: firstExitCode } = await runCLI(["add", "kdco/test-plugin"], testDir)
		expect(firstExitCode).toBe(0)

		// Install same component again (should skip, not fail)
		const { exitCode } = await runCLI(["add", "kdco/test-plugin"], testDir)
		expect(exitCode).toBe(0)
		// File should still exist (V2 path)
		expect(existsSync(join(testDir, ".opencode", "plugins", "test-plugin.ts"))).toBe(true)
	})

	it("should fail on conflict", async () => {
		testDir = await createTempDir("add-conflict-no-yes")

		// Init and add registry
		await runCLI(["init"], testDir)

		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const config = parseJsonc(await readFile(configPath, "utf-8"))
		config.registries = {
			kdco: { url: registry.url },
		}
		await writeFile(configPath, JSON.stringify(config, null, 2))

		// Install component first time
		await runCLI(["add", "kdco/test-plugin"], testDir)

		// Modify the file to create a conflict (V2 path)
		const filePath = join(testDir, ".opencode", "plugins", "test-plugin.ts")
		await writeFile(filePath, "// Modified by user")

		// Try to install again (should fail with conflict)
		const { exitCode, output } = await runCLI(["add", "kdco/test-plugin"], testDir)
		expect(exitCode).not.toBe(0)
		expect(output).toContain("conflict")
		expect(output).toContain("ocx remove")
	})

	it("should preserve mcp from dependencies when main component has no mcp (regression)", async () => {
		testDir = await createTempDir("add-mcp-regression")

		// Init and add registry
		await runCLI(["init"], testDir)

		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const config = parseJsonc(await readFile(configPath, "utf-8"))
		config.registries = {
			kdco: { url: registry.url },
		}
		await writeFile(configPath, JSON.stringify(config, null, 2))

		// Install test-no-mcp which depends on test-mcp-provider
		// test-mcp-provider has MCP config, test-no-mcp does not
		// This tests the regression where MCP was lost due to undefined overwriting
		const { exitCode, output } = await runCLI(["add", "kdco/test-no-mcp"], testDir)

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
		await runCLI(["init"], testDir)

		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const config = parseJsonc(await readFile(configPath, "utf-8"))
		config.registries = {
			kdco: { url: registry.url },
		}
		await writeFile(configPath, JSON.stringify(config, null, 2))

		// Install test-no-mcp which depends on test-mcp-provider
		// Both have plugin arrays that should be concatenated
		const { exitCode, output } = await runCLI(["add", "kdco/test-no-mcp"], testDir)

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
		await runCLI(["init"], testDir)

		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const config = parseJsonc(await readFile(configPath, "utf-8"))
		config.registries = {
			kdco: { url: registry.url },
		}
		await writeFile(configPath, JSON.stringify(config, null, 2))

		// 1. Install normally to create lock entry
		await runCLI(["add", "kdco/test-plugin"], testDir)

		// 2. Tamper with the registry content
		registry.setFileContent("test-plugin", "index.ts", "TAMPERED CONTENT")

		// 3. Try to add again (should fail integrity check)
		const { exitCode, output } = await runCLI(["add", "kdco/test-plugin"], testDir)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("Integrity verification failed")
		expect(output).toContain("The registry content has changed since this component was locked")
	})

	it("should resolve command root to singular when only singular directory exists", async () => {
		testDir = await createTempDir("add-adaptive-singular-command")

		await runCLI(["init"], testDir)

		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const config = parseJsonc(await readFile(configPath, "utf-8")) as {
			registries?: Record<string, { url: string }>
		}
		config.registries = {
			kdco: { url: registry.url },
		}
		await writeFile(configPath, JSON.stringify(config, null, 2))

		await mkdir(join(testDir, ".opencode", "command"), { recursive: true })

		const { exitCode, output } = await runCLI(["add", "kdco/test-command"], testDir)

		if (exitCode !== 0) {
			console.log(output)
		}
		expect(exitCode).toBe(0)
		expect(existsSync(join(testDir, ".opencode", "command", "test-command.md"))).toBe(true)
		expect(existsSync(join(testDir, ".opencode", "commands", "test-command.md"))).toBe(false)
	})

	it("should fail loud on cross-root logical collision", async () => {
		testDir = await createTempDir("add-adaptive-cross-root-collision")

		await runCLI(["init"], testDir)

		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const config = parseJsonc(await readFile(configPath, "utf-8")) as {
			registries?: Record<string, { url: string }>
		}
		config.registries = {
			kdco: { url: registry.url },
		}
		await writeFile(configPath, JSON.stringify(config, null, 2))

		await mkdir(join(testDir, ".opencode", "command"), { recursive: true })
		await mkdir(join(testDir, ".opencode", "commands"), { recursive: true })
		await writeFile(join(testDir, ".opencode", "command", "test-command.md"), "existing")

		const { exitCode, output } = await runCLI(["add", "kdco/test-command"], testDir)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("Cross-root logical collision")
		expect(output).toContain("command/test-command.md")
	})

	it("should fail loud on intra-batch collisions from dependency installs", async () => {
		testDir = await createTempDir("add-intra-batch-collision")

		await runCLI(["init"], testDir)

		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const config = parseJsonc(await readFile(configPath, "utf-8")) as {
			registries?: Record<string, { url: string }>
		}
		config.registries = {
			kdco: { url: registry.url },
		}
		await writeFile(configPath, JSON.stringify(config, null, 2))

		const { exitCode, output } = await runCLI(["add", "kdco/collision-parent"], testDir)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("Intra-batch target collision")
		expect(output).toContain("commands/shared-collision.md")

		expect(existsSync(join(testDir, ".opencode", "commands", "shared-collision.md"))).toBe(false)
		expect(existsSync(join(testDir, ".opencode", "command", "shared-collision.md"))).toBe(false)
	})

	it("should fail loud on intra-batch collisions even when duplicate content matches", async () => {
		testDir = await createTempDir("add-intra-batch-same-content")

		await runCLI(["init"], testDir)

		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const config = parseJsonc(await readFile(configPath, "utf-8")) as {
			registries?: Record<string, { url: string }>
		}
		config.registries = {
			kdco: { url: registry.url },
		}
		await writeFile(configPath, JSON.stringify(config, null, 2))

		registry.setFileContent("collision-command-a", "A.md", "same")
		registry.setFileContent("collision-command-b", "B.md", "same")

		try {
			const { exitCode, output } = await runCLI(["add", "kdco/collision-parent"], testDir)

			expect(exitCode).not.toBe(0)
			expect(output).toContain("Intra-batch target collision")
			expect(output).toContain("commands/shared-collision.md")
		} finally {
			registry.clearFileContent()
		}
	})

	it("rolls back files and preserves receipt when install fails mid-write", async () => {
		testDir = await createTempDir("add-atomic-mid-write-failure")

		await runCLI(["init"], testDir)

		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const config = parseJsonc(await readFile(configPath, "utf-8")) as {
			registries?: Record<string, { url: string }>
		}
		config.registries = {
			kdco: { url: registry.url },
		}
		await writeFile(configPath, JSON.stringify(config, null, 2))

		const { exitCode: baselineInstallExit } = await runCLI(["add", "kdco/test-command"], testDir)
		expect(baselineInstallExit).toBe(0)

		const receiptPath = join(testDir, ".ocx", "receipt.jsonc")
		const baselineReceipt = await readFile(receiptPath, "utf-8")

		registry.setRouteError(
			"/components/test-write-failure.json",
			200,
			JSON.stringify({
				name: "test-write-failure",
				"dist-tags": {
					latest: "1.0.0",
				},
				versions: {
					"1.0.0": {
						name: "test-write-failure",
						type: "plugin",
						description: "Fixture for mid-write add failure",
						files: [
							{ path: "first.ts", target: "plugins/test-write-failure.ts" },
							{ path: "keep.md", target: "plugins/write-failure-dir/.keep" },
							{ path: "second.md", target: "plugins/write-failure-dir" },
						],
						dependencies: [],
					},
				},
			}),
		)

		registry.setFileContent("test-write-failure", "first.ts", "// should be rolled back")
		registry.setFileContent("test-write-failure", "keep.md", "keep")
		registry.setFileContent("test-write-failure", "second.md", "second")

		try {
			const { exitCode } = await runCLI(["add", "kdco/test-write-failure"], testDir)
			expect(exitCode).not.toBe(0)

			expect(existsSync(join(testDir, ".opencode", "plugins", "test-write-failure.ts"))).toBe(false)
			expect(existsSync(join(testDir, ".opencode", "plugins", "write-failure-dir", ".keep"))).toBe(
				false,
			)
			expect(await readFile(receiptPath, "utf-8")).toBe(baselineReceipt)
		} finally {
			registry.clearRouteOverrides()
			registry.clearFileContent()
		}
	})

	it("rolls back manifest side effects when receipt write fails after install", async () => {
		testDir = await createTempDir("add-atomic-manifest-rollback")

		await runCLI(["init"], testDir)

		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const config = parseJsonc(await readFile(configPath, "utf-8")) as {
			registries?: Record<string, { url: string }>
		}
		config.registries = {
			kdco: { url: registry.url },
		}
		await writeFile(configPath, JSON.stringify(config, null, 2))

		const opencodePath = join(testDir, ".opencode", "opencode.jsonc")
		const packageJsonPath = join(testDir, ".opencode", "package.json")
		const gitignorePath = join(testDir, ".opencode", ".gitignore")

		const baselineOpencode = await readFile(opencodePath, "utf-8")
		const baselinePackageExists = existsSync(packageJsonPath)
		const baselinePackageContent = baselinePackageExists
			? await readFile(packageJsonPath, "utf-8")
			: null
		const baselineGitignoreExists = existsSync(gitignorePath)
		const baselineGitignoreContent = baselineGitignoreExists
			? await readFile(gitignorePath, "utf-8")
			: null

		// Force late failure at receipt write to exercise manifest rollback.
		// writeReceipt() expects .ocx to be a directory; a file here guarantees failure after
		// component and manifest side effects have been attempted.
		const receiptRootPath = join(testDir, ".ocx")
		if (existsSync(receiptRootPath)) {
			await rm(receiptRootPath, { recursive: true, force: true })
		}
		await writeFile(receiptRootPath, "receipt-dir-blocker")

		const { exitCode } = await runCLI(["add", "kdco/test-agent"], testDir)
		expect(exitCode).not.toBe(0)

		// Component files should be rolled back.
		expect(existsSync(join(testDir, ".opencode", "agents", "test-agent.md"))).toBe(false)
		expect(existsSync(join(testDir, ".opencode", "skills", "test-skill", "SKILL.md"))).toBe(false)
		expect(existsSync(join(testDir, ".opencode", "plugins", "test-plugin.ts"))).toBe(false)

		// Manifest side effects should also be rolled back.
		expect(await readFile(opencodePath, "utf-8")).toBe(baselineOpencode)
		expect(existsSync(packageJsonPath)).toBe(baselinePackageExists)
		if (baselinePackageExists) {
			expect(await readFile(packageJsonPath, "utf-8")).toBe(baselinePackageContent)
		}
		expect(existsSync(gitignorePath)).toBe(baselineGitignoreExists)
		if (baselineGitignoreExists) {
			expect(await readFile(gitignorePath, "utf-8")).toBe(baselineGitignoreContent)
		}

		// Regression guard: rollback must not delete pre-existing blocker files.
		expect(existsSync(receiptRootPath)).toBe(true)
		expect((await stat(receiptRootPath)).isFile()).toBe(true)
		expect(await readFile(receiptRootPath, "utf-8")).toBe("receipt-dir-blocker")
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

		// Create .git marker to prevent findLocalConfigDir from walking up
		// to the repo root and finding .opencode/profiles/
		await mkdir(join(testDir, ".git"), { recursive: true })

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
			["add", "kdco/test-plugin", "--profile", "test-profile"],
			workDir,
		)

		if (exitCode !== 0) {
			console.log(output)
		}
		expect(exitCode).toBe(0)

		// V2: Verify file installed to flattened path (plugins/, not plugins/)
		expect(existsSync(join(profileDir, "plugins", "test-plugin.ts"))).toBe(true)

		// Verify NOT installed to nested .opencode/ path
		expect(existsSync(join(profileDir, ".opencode", "plugins", "test-plugin.ts"))).toBe(false)
	})

	it("should install component with dependencies to flattened paths", async () => {
		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		// Install agent which depends on skill which depends on plugin
		const { exitCode, output } = await runCLI(
			["add", "kdco/test-agent", "--profile", "test-profile"],
			workDir,
		)

		if (exitCode !== 0) {
			console.log(output)
		}
		expect(exitCode).toBe(0)

		// V2: Verify all installed to flattened paths with correct directory names
		expect(existsSync(join(profileDir, "agents", "test-agent.md"))).toBe(true)
		expect(existsSync(join(profileDir, "skills", "test-skill", "SKILL.md"))).toBe(true)
		expect(existsSync(join(profileDir, "plugins", "test-plugin.ts"))).toBe(true)

		// V1: Verify receipt file at profile root/.ocx/
		expect(existsSync(join(profileDir, ".ocx", "receipt.jsonc"))).toBe(true)
	})

	it("should place package.json at profile root, not in .opencode/", async () => {
		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		const { exitCode } = await runCLI(
			["add", "kdco/test-plugin", "--profile", "test-profile"],
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
			["add", "kdco/test-plugin", "--profile", "test-profile"],
			workDir,
		)

		// Should succeed without "Run 'ocx init' first" error
		expect(exitCode).toBe(0)
		expect(output).not.toContain("Run 'ocx init' first")

		// Component installed to profile, not workDir (V2 flattened path: plugins/)
		expect(existsSync(join(profileDir, "plugins", "test-plugin.ts"))).toBe(true)
		expect(existsSync(join(workDir, ".opencode"))).toBe(false)
	})

	it("should detect conflicts at flattened paths", async () => {
		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		// First install
		await runCLI(["add", "kdco/test-plugin", "--profile", "test-profile"], workDir)

		// Modify the file to create a conflict (V2 flattened path: plugins/)
		const filePath = join(profileDir, "plugins", "test-plugin.ts")
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

describe("ocx add --from", () => {
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

	it("should install from ephemeral registry URL", async () => {
		testDir = await createTempDir("add-from-basic")

		// Init project (required for local mode)
		await runCLI(["init"], testDir)

		// Install from ephemeral registry (prefix becomes the ephemeral registry alias)
		const { exitCode, output } = await runCLI(
			["add", "kdco/test-plugin", "--from", registry.url],
			testDir,
		)

		if (exitCode !== 0) {
			console.log(output)
		}
		expect(exitCode).toBe(0)

		// Verify file installed
		expect(existsSync(join(testDir, ".opencode", "plugins", "test-plugin.ts"))).toBe(true)

		// Verify receipt created
		const receiptPath = join(testDir, ".ocx/receipt.jsonc")
		expect(existsSync(receiptPath)).toBe(true)
		const receipt = parseJsonc(await readFile(receiptPath, "utf-8")) as {
			installed: Record<string, unknown>
		}
		expect(Object.keys(receipt.installed).some((k) => k.includes("test-plugin"))).toBe(true)
	})

	it("should NOT persist ephemeral registry to ocx.jsonc", async () => {
		testDir = await createTempDir("add-from-no-persist")

		// Init project
		await runCLI(["init"], testDir)

		// Read initial config
		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const initialConfig = parseJsonc(await readFile(configPath, "utf-8")) as {
			registries?: Record<string, unknown>
		}
		const initialRegistryCount = Object.keys(initialConfig.registries ?? {}).length

		// Install from ephemeral registry
		const { exitCode } = await runCLI(["add", "kdco/test-plugin", "--from", registry.url], testDir)
		expect(exitCode).toBe(0)

		// Verify config unchanged - ephemeral registry NOT persisted
		const finalConfig = parseJsonc(await readFile(configPath, "utf-8")) as {
			registries?: Record<string, unknown>
		}
		const finalRegistryCount = Object.keys(finalConfig.registries ?? {}).length
		expect(finalRegistryCount).toBe(initialRegistryCount)

		// Verify the ephemeral registry URL is NOT in the config
		const registryUrls = Object.values(finalConfig.registries ?? {}).map(
			(r) => (r as { url?: string }).url,
		)
		expect(registryUrls).not.toContain(registry.url)
	})

	it("should reject invalid --from URL", async () => {
		testDir = await createTempDir("add-from-invalid-url")

		// Init project
		await runCLI(["init"], testDir)

		// Try with invalid URL
		const { exitCode, output } = await runCLI(
			["add", "kdco/test-plugin", "--from", "not-a-valid-url"],
			testDir,
		)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("Invalid --from URL")
	})

	it("should accept any prefix with --from (prefix becomes ephemeral registry name)", async () => {
		testDir = await createTempDir("add-from-any-prefix")

		// Init project
		await runCLI(["init"], testDir)

		// Use any prefix — it becomes the ephemeral registry name
		const { exitCode } = await runCLI(
			["add", "custom-name/test-plugin", "--from", registry.url],
			testDir,
		)

		expect(exitCode).toBe(0)
	})

	it("should reject mixed prefixes with --from", async () => {
		testDir = await createTempDir("add-from-mixed-prefix")

		// Init project
		await runCLI(["init"], testDir)

		// Try with mixed prefixes (foo/comp1 and bar/comp2 in same --from call)
		const { exitCode, output } = await runCLI(
			["add", "foo/test-plugin", "bar/test-agent", "--from", registry.url],
			testDir,
		)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("Mixed registry prefixes")
	})

	it("should NOT write files or receipt in dry-run mode", async () => {
		testDir = await createTempDir("add-from-dry-run")

		// Init project
		await runCLI(["init"], testDir)

		// Dry-run install from ephemeral registry
		const { exitCode, output } = await runCLI(
			["add", "kdco/test-plugin", "--from", registry.url, "--dry-run"],
			testDir,
		)

		expect(exitCode).toBe(0)
		expect(output).toContain("dry-run") // Should indicate dry-run mode

		// Verify NO files written
		expect(existsSync(join(testDir, ".opencode", "plugins", "test-plugin.ts"))).toBe(false)

		// Verify NO receipt created
		expect(existsSync(join(testDir, ".ocx/receipt.jsonc"))).toBe(false)
	})

	it("should install component with dependencies from ephemeral registry", async () => {
		testDir = await createTempDir("add-from-with-deps")

		// Init project
		await runCLI(["init"], testDir)

		// Install agent which has transitive dependencies (agent -> skill -> plugin)
		const { exitCode, output } = await runCLI(
			["add", "kdco/test-agent", "--from", registry.url],
			testDir,
		)

		if (exitCode !== 0) {
			console.log(output)
		}
		expect(exitCode).toBe(0)

		// Verify all files installed (agent + skill + plugin)
		expect(existsSync(join(testDir, ".opencode", "agents", "test-agent.md"))).toBe(true)
		expect(existsSync(join(testDir, ".opencode", "skills", "test-skill", "SKILL.md"))).toBe(true)
		expect(existsSync(join(testDir, ".opencode", "plugins", "test-plugin.ts"))).toBe(true)

		// Verify receipt contains all 3 components
		const receiptPath = join(testDir, ".ocx/receipt.jsonc")
		const receipt = parseJsonc(await readFile(receiptPath, "utf-8")) as {
			installed: Record<string, unknown>
		}
		const installedKeys = Object.keys(receipt.installed)
		expect(installedKeys.length).toBe(3)
	})
})

describe("ocx add --json mixed-input contract", () => {
	let testDir: string
	let registry: MockRegistry
	const originalFetch = global.fetch

	function getRequestUrl(input: string | URL | Request): string {
		if (typeof input === "string") return input
		if (input instanceof URL) return input.toString()
		return input.url
	}

	beforeAll(() => {
		registry = startMockRegistry()
	})

	afterAll(() => {
		registry.stop()
	})

	afterEach(async () => {
		mock.restore()
		global.fetch = originalFetch
		if (testDir) {
			await cleanupTempDir(testDir)
		}
	})

	it("emits exactly one JSON document for mixed npm + registry success", async () => {
		testDir = await createTempDir("add-json-mixed-success")

		const fetchSpy = spyOn(global, "fetch").mockImplementation(
			mock(async (input: string | URL | Request, init?: RequestInit) => {
				const url = getRequestUrl(input)
				if (url.startsWith("https://registry.npmjs.org/test-plugin")) {
					return new Response(
						JSON.stringify({
							name: "test-plugin",
							"dist-tags": { latest: "1.0.0" },
							versions: {},
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					)
				}

				return originalFetch(input as RequestInfo | URL, init)
			}) as unknown as typeof fetch,
		)

		const consoleLogSpy = spyOn(console, "log").mockImplementation(() => {})
		const consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {})

		const { runAddCore } = await importAddCommandModule()
		const provider = {
			cwd: testDir,
			getRegistries: () => ({ kdco: { url: registry.url } }),
			getComponentPath: () => ".opencode/components",
			getScope: () => "local" as const,
		}

		await runAddCore(
			["npm:test-plugin", "kdco/test-plugin"],
			{
				json: true,
				quiet: true,
				trust: true,
			},
			provider,
		)

		expect(fetchSpy).toHaveBeenCalled()
		expect(consoleErrorSpy).not.toHaveBeenCalled()
		expect(consoleLogSpy).toHaveBeenCalledTimes(1)

		const output = String(consoleLogSpy.mock.calls[0]?.[0] ?? "")
		const payload = JSON.parse(output) as {
			success: boolean
			plugins?: string[]
			installed?: string[]
		}

		expect(payload.success).toBe(true)
		expect(payload.plugins).toEqual(["test-plugin"])
		expect(payload.installed).toEqual(["kdco/test-plugin"])
	})

	it("preserves configured plugin tuples and detects npm conflicts by their specifier", async () => {
		testDir = await createTempDir("add-npm-plugin-tuple")
		const configDir = join(testDir, ".opencode")
		await mkdir(configDir, { recursive: true })
		const configuredTuple = ["npm:configured-plugin@1.0.0", { nested: { enabled: true } }] as const
		await writeFile(
			join(configDir, "opencode.jsonc"),
			JSON.stringify({ plugin: [configuredTuple] }),
		)

		spyOn(global, "fetch").mockImplementation(
			mock(async (input: string | URL | Request, init?: RequestInit) => {
				const url = getRequestUrl(input)
				const packageName = url.split("/").at(-1)
				if (packageName === "new-plugin" || packageName === "configured-plugin") {
					return new Response(
						JSON.stringify({
							name: packageName,
							"dist-tags": { latest: "1.0.0" },
							versions: {},
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					)
				}

				return originalFetch(input as RequestInfo | URL, init)
			}) as unknown as typeof fetch,
		)

		const { runAddCore } = await importAddCommandModule()
		const provider = {
			cwd: testDir,
			getRegistries: () => ({}),
			getComponentPath: () => ".opencode/components",
			getScope: () => "local" as const,
		}

		await runAddCore(["npm:new-plugin"], { quiet: true, trust: true }, provider)

		const config = parseJsonc(await readFile(join(configDir, "opencode.jsonc"), "utf-8"))
		expect(config.plugin).toEqual([configuredTuple, "new-plugin"])

		await expect(
			runAddCore(["npm:configured-plugin"], { quiet: true, trust: true }, provider),
		).rejects.toThrow("Plugin(s) already exist")
	})

	it("emits strict single-channel JSON on mixed-mode conflict failure without stderr contamination", async () => {
		testDir = await createTempDir("add-json-mixed-failure")

		const fetchSpy = spyOn(global, "fetch").mockImplementation(
			mock(async (input: string | URL | Request, init?: RequestInit) => {
				const url = getRequestUrl(input)
				if (url.startsWith("https://registry.npmjs.org/test-plugin")) {
					return new Response(
						JSON.stringify({
							name: "test-plugin",
							"dist-tags": { latest: "1.0.0" },
							versions: {},
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					)
				}

				return originalFetch(input as RequestInfo | URL, init)
			}) as unknown as typeof fetch,
		)

		const consoleLogSpy = spyOn(console, "log").mockImplementation(() => {})
		const consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {})
		let capturedExitCode: number | null = null
		const processExitSpy = spyOn(process, "exit").mockImplementation((code?: number) => {
			capturedExitCode = code ?? 0
			throw new Error("process.exit called")
		})

		const conflictDir = join(testDir, ".opencode", "plugins")
		await mkdir(conflictDir, { recursive: true })
		await writeFile(join(conflictDir, "test-plugin.ts"), "// local conflicting content\n")

		const { runAddCore } = await importAddCommandModule()
		const provider = {
			cwd: testDir,
			getRegistries: () => ({ kdco: { url: registry.url } }),
			getComponentPath: () => ".opencode/components",
			getScope: () => "local" as const,
		}

		let thrownError: unknown
		try {
			await runAddCore(
				["npm:test-plugin", "kdco/test-plugin"],
				{
					json: true,
					quiet: true,
					trust: true,
				},
				provider,
			)
		} catch (error) {
			thrownError = error
		}

		expect(thrownError).toBeDefined()
		expect(fetchSpy).toHaveBeenCalled()

		// No partial JSON should be emitted before command-level error handling.
		expect(consoleLogSpy).not.toHaveBeenCalled()

		try {
			handleError(thrownError, { json: true })
		} catch {
			// Expected: process.exit is mocked to throw.
		}

		// Strict contract: exactly one output channel, one JSON document, no human stderr.
		expect(processExitSpy).toHaveBeenCalledTimes(1)
		expect(capturedExitCode).not.toBe(0)
		expect(consoleErrorSpy).not.toHaveBeenCalled()
		expect(consoleLogSpy).toHaveBeenCalledTimes(1)

		const output = String(consoleLogSpy.mock.calls[0]?.[0] ?? "")
		const payload = JSON.parse(output) as {
			success: boolean
			error?: { code?: string; message?: string }
		}

		expect(payload.success).toBe(false)
		expect(payload.error?.code).toBe("CONFLICT")
		expect(payload.error?.message).toContain("conflicts")
	})
})

describe("ocx add legacy registry compatibility", () => {
	let testDir: string

	afterEach(async () => {
		if (testDir) {
			await cleanupTempDir(testDir)
		}
	})

	it("should install kdco/workspace from legacy v1 object index fixture", async () => {
		testDir = await createTempDir("add-legacy-kdco-workspace")
		const fixtureRegistry = startLegacyFixtureRegistry("kdco")

		try {
			await runCLI(["init"], testDir)
			const configPath = join(testDir, ".opencode", "ocx.jsonc")
			const config = parseJsonc(await readFile(configPath, "utf-8")) as Record<string, unknown>
			config.registries = {
				kdco: { url: fixtureRegistry.url },
			}
			await writeFile(configPath, JSON.stringify(config, null, 2))

			const { exitCode, output } = await runCLI(["add", "kdco/workspace"], testDir)

			if (exitCode !== 0) {
				console.log(output)
			}
			expect(exitCode).toBe(0)

			const receipt = parseJsonc(
				await readFile(join(testDir, ".ocx", "receipt.jsonc"), "utf-8"),
			) as {
				installed: Record<string, unknown>
			}
			expect(Object.keys(receipt.installed).some((key) => key.includes("workspace"))).toBe(true)
		} finally {
			fixtureRegistry.stop()
		}
	})

	it("should return success JSON when adding legacy kdco/workspace", async () => {
		testDir = await createTempDir("add-legacy-json-success")
		const fixtureRegistry = startLegacyFixtureRegistry("kdco")

		try {
			await runCLI(["init"], testDir)
			const configPath = join(testDir, ".opencode", "ocx.jsonc")
			const config = parseJsonc(await readFile(configPath, "utf-8")) as Record<string, unknown>
			config.registries = {
				kdco: { url: fixtureRegistry.url },
			}
			await writeFile(configPath, JSON.stringify(config, null, 2))

			const { exitCode, stdout, stderr } = await runCLI(
				["add", "kdco/workspace", "--json"],
				testDir,
			)

			expect(exitCode).toBe(0)
			const payload = JSON.parse(stdout || stderr)
			expect(payload.success).toBe(true)
			expect(payload.installed).toContain("kdco/workspace")
		} finally {
			fixtureRegistry.stop()
		}
	})

	it("should fail with actionable error when registry returns legacy array format", async () => {
		testDir = await createTempDir("add-legacy-registry")

		// Start a server that returns legacy array format
		const server = Bun.serve({
			port: 0,
			fetch() {
				return Response.json([{ name: "button", type: "plugin", description: "A button" }])
			},
		})

		try {
			// Init and configure registry pointing to legacy server
			await runCLI(["init"], testDir)
			const configPath = join(testDir, ".opencode", "ocx.jsonc")
			const config = parseJsonc(await readFile(configPath, "utf-8")) as Record<string, unknown>
			config.registries = {
				legacy: { url: `http://localhost:${server.port}` },
			}
			await writeFile(configPath, JSON.stringify(config, null, 2))

			// Try to add a component from the legacy registry
			const { exitCode, output } = await runCLI(["add", "legacy/button"], testDir)

			expect(exitCode).not.toBe(0)
			expect(output).toContain("legacy schema v1")
			expect(output).toContain("object index payload")
			// Should NOT show raw Zod errors
			expect(output).not.toMatch(/^Required$/m)
		} finally {
			server.stop()
		}
	})

	it("should not bypass format incompatibility with --skip-compat-check", async () => {
		testDir = await createTempDir("add-skip-compat-no-bypass")

		// Start a server that returns legacy array format
		const server = Bun.serve({
			port: 0,
			fetch() {
				return Response.json([{ name: "button", type: "plugin", description: "A button" }])
			},
		})

		try {
			// Init and configure registry pointing to legacy server
			await runCLI(["init"], testDir)
			const configPath = join(testDir, ".opencode", "ocx.jsonc")
			const config = parseJsonc(await readFile(configPath, "utf-8")) as Record<string, unknown>
			config.registries = {
				legacy: { url: `http://localhost:${server.port}` },
			}
			await writeFile(configPath, JSON.stringify(config, null, 2))

			// --skip-compat-check should NOT bypass format incompatibility
			const { exitCode, output } = await runCLI(
				["add", "legacy/button", "--skip-compat-check"],
				testDir,
			)

			expect(exitCode).not.toBe(0)
			expect(output).toContain("legacy schema v1")
			expect(output).toContain("object index payload")
		} finally {
			server.stop()
		}
	})

	it("should reject unsafe legacy target canonicalization inputs", async () => {
		testDir = await createTempDir("add-legacy-unsafe-target")

		const server = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url)
				if (url.pathname === "/index.json") {
					return Response.json({
						author: "Legacy",
						components: [{ name: "unsafe", type: "ocx:plugin", description: "Unsafe plugin" }],
					})
				}

				if (url.pathname === "/components/unsafe.json") {
					return Response.json({
						name: "unsafe",
						"dist-tags": { latest: "1.4.6" },
						versions: {
							"1.4.6": {
								name: "unsafe",
								type: "ocx:plugin",
								description: "Unsafe plugin",
								files: [
									{
										path: "plugin.ts",
										target: ".opencode/plugin/%2e%2e/escape.ts",
									},
								],
								dependencies: [],
							},
						},
					})
				}

				if (url.pathname === "/components/unsafe/plugin.ts") {
					return new Response("export default {}")
				}

				return new Response("Not Found", { status: 404 })
			},
		})

		try {
			await runCLI(["init"], testDir)
			const configPath = join(testDir, ".opencode", "ocx.jsonc")
			const config = parseJsonc(await readFile(configPath, "utf-8")) as Record<string, unknown>
			config.registries = {
				legacy: { url: `http://localhost:${server.port}` },
			}
			await writeFile(configPath, JSON.stringify(config, null, 2))

			const { exitCode, output } = await runCLI(["add", "legacy/unsafe"], testDir)

			expect(exitCode).not.toBe(0)
			expect(output).toContain("Unsafe target")
			expect(output).toContain("encoded paths")
		} finally {
			server.stop()
		}
	})

	it("should show compatibility error in JSON mode for add flow", async () => {
		testDir = await createTempDir("add-legacy-json")

		const server = Bun.serve({
			port: 0,
			fetch() {
				return Response.json({ foo: "bar", count: 42 })
			},
		})

		try {
			await runCLI(["init"], testDir)
			const configPath = join(testDir, ".opencode", "ocx.jsonc")
			const config = parseJsonc(await readFile(configPath, "utf-8")) as Record<string, unknown>
			config.registries = {
				bad: { url: `http://localhost:${server.port}` },
			}
			await writeFile(configPath, JSON.stringify(config, null, 2))

			const { exitCode, stdout, stderr } = await runCLI(["add", "bad/something", "--json"], testDir)

			expect(exitCode).not.toBe(0)
			const jsonOutput = JSON.parse(stdout || stderr)
			expect(jsonOutput.success).toBe(false)
			expect(jsonOutput.error.code).toBe("REGISTRY_COMPAT_ERROR")
			expect(jsonOutput.error.details.issue).toBe("legacy-schema-v1")
			expect(jsonOutput.error.details.url).toContain("index.json")
		} finally {
			server.stop()
		}
	})
})

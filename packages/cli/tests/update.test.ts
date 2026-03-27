import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { existsSync } from "node:fs"
import * as fsPromises from "node:fs/promises"
import {
	rename as fsRename,
	rm as fsRm,
	mkdir,
	readdir,
	readFile,
	writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import { resolveUpdateFailureMessage, runUpdateCore } from "../src/commands/update"
import { LocalConfigProvider } from "../src/config/provider"
import { _clearFetcherCacheForTests } from "../src/registry/fetcher"
import { cleanupTempDir, createTempDir, parseJsonc, runCLI } from "./helpers"
import { type MockRegistry, startMockRegistry } from "./mock-registry"

describe("ocx update", () => {
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

	/**
	 * Helper to initialize project and add registry
	 */
	async function setupProject(name: string): Promise<string> {
		const dir = await createTempDir(name)
		await runCLI(["init"], dir)

		const configPath = join(dir, ".opencode", "ocx.jsonc")
		const config = parseJsonc(await readFile(configPath, "utf-8")) as Record<string, unknown>
		config.registries = {
			kdco: { url: registry.url },
		}
		await writeFile(configPath, JSON.stringify(config, null, 2))

		return dir
	}

	/**
	 * Helper to install a component
	 */
	async function installComponent(dir: string, componentName: string): Promise<void> {
		const { exitCode, output } = await runCLI(["add", componentName], dir)
		if (exitCode !== 0) {
			throw new Error(`Failed to install ${componentName}: ${output}`)
		}
	}

	// =========================================================================
	// Basic update tests
	// =========================================================================

	it("should update a component when source changed", async () => {
		testDir = await setupProject("update-basic")

		// Install component
		await installComponent(testDir, "kdco/test-plugin")

		// Verify initial content
		const filePath = join(testDir, ".opencode", "plugins", "test-plugin.ts")
		const originalContent = await readFile(filePath, "utf-8")
		expect(originalContent).toContain("test-plugin")

		// Change registry content to simulate update
		const newContent = "// Updated content for test-plugin v2"
		registry.setFileContent("test-plugin", "index.ts", newContent)
		_clearFetcherCacheForTests() // Clear cache to ensure fresh fetch

		// Run update
		const { exitCode, output } = await runCLI(["update", "kdco/test-plugin"], testDir)

		expect(exitCode).toBe(0)
		expect(output).toContain("Updated")

		// Verify file was updated
		const updatedContent = await readFile(filePath, "utf-8")
		expect(updatedContent).toBe(newContent)

		// Verify receipt was updated (V1: .ocx/receipt.jsonc)
		const receiptPath = join(testDir, ".ocx/receipt.jsonc")
		const receipt = parseJsonc(await readFile(receiptPath, "utf-8")) as Record<string, unknown>
		const installed = receipt.installed as Record<string, { updatedAt?: string }>
		// V2: Receipt uses canonical IDs, find entry containing test-plugin
		const pluginEntry = Object.entries(installed).find(([id]) => id.includes("test-plugin"))
		expect(pluginEntry).toBeDefined()
		expect(pluginEntry?.[1].updatedAt).toBeDefined()
	})

	// =========================================================================
	// --all flag tests
	// =========================================================================

	it("should update all installed components with --all", async () => {
		testDir = await setupProject("update-all")

		// Install multiple components
		await installComponent(testDir, "kdco/test-plugin")
		await installComponent(testDir, "kdco/test-skill")

		// Change registry content for both
		registry.setFileContent("test-plugin", "index.ts", "// Plugin v2")
		registry.setFileContent("test-skill", "SKILL.md", "# Skill v2")

		// Run update --all
		const { exitCode, output } = await runCLI(["update", "--all"], testDir)

		expect(exitCode).toBe(0)
		expect(output).toContain("Updated")

		// Verify both files were updated
		const pluginContent = await readFile(
			join(testDir, ".opencode", "plugins", "test-plugin.ts"),
			"utf-8",
		)
		expect(pluginContent).toBe("// Plugin v2")

		const skillContent = await readFile(
			join(testDir, ".opencode", "skills", "test-skill", "SKILL.md"),
			"utf-8",
		)
		expect(skillContent).toBe("# Skill v2")
	})

	// =========================================================================
	// --registry flag tests
	// =========================================================================

	it("should update only components from specified registry", async () => {
		testDir = await setupProject("update-registry")

		// Install component
		await installComponent(testDir, "kdco/test-plugin")

		// Record original content
		const filePath = join(testDir, ".opencode", "plugins", "test-plugin.ts")
		const originalContent = await readFile(filePath, "utf-8")

		// Change registry content
		registry.setFileContent("test-plugin", "index.ts", "// Updated via --registry")

		// Run update with --registry
		const { exitCode } = await runCLI(["update", "--registry", "kdco"], testDir)

		expect(exitCode).toBe(0)

		// Verify component was updated
		const updatedContent = await readFile(filePath, "utf-8")
		expect(updatedContent).not.toBe(originalContent)
		expect(updatedContent).toBe("// Updated via --registry")
	})

	it("should fail when no components from specified registry are installed", async () => {
		testDir = await setupProject("update-registry-empty")

		// Install component
		await installComponent(testDir, "kdco/test-plugin")

		// Try to update from non-existent registry
		const { exitCode, output } = await runCLI(["update", "--registry", "other"], testDir)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("No installed components from registry")
	})

	// =========================================================================
	// --dry-run flag tests
	// =========================================================================

	it("should preview changes with --dry-run without modifying files", async () => {
		testDir = await setupProject("update-dry-run")

		// Install component
		await installComponent(testDir, "kdco/test-plugin")

		// Record original content
		const filePath = join(testDir, ".opencode", "plugins", "test-plugin.ts")
		const originalContent = await readFile(filePath, "utf-8")
		const receiptPath = join(testDir, ".ocx/receipt.jsonc")
		const originalReceipt = await readFile(receiptPath, "utf-8")

		// Change registry content
		registry.setFileContent("test-plugin", "index.ts", "// Dry run change")

		// Run update with --dry-run
		const { exitCode, output } = await runCLI(["update", "kdco/test-plugin", "--dry-run"], testDir)

		expect(exitCode).toBe(0)
		expect(output).toContain("Would update")

		// Verify file was NOT modified
		const currentContent = await readFile(filePath, "utf-8")
		expect(currentContent).toBe(originalContent)

		// Verify receipt was NOT modified
		const currentReceipt = await readFile(receiptPath, "utf-8")
		expect(currentReceipt).toBe(originalReceipt)
	})

	it("should output JSON with --dry-run --json", async () => {
		testDir = await setupProject("update-dry-run-json")

		// Install component
		await installComponent(testDir, "kdco/test-plugin")

		// Change registry content
		registry.setFileContent("test-plugin", "index.ts", "// JSON dry run")

		// Run update with --dry-run --json
		const { exitCode, output } = await runCLI(
			["update", "kdco/test-plugin", "--dry-run", "--json"],
			testDir,
		)

		expect(exitCode).toBe(0)

		const json = JSON.parse(output)
		expect(json.dryRun).toBe(true)
		expect(json.wouldPerform).toBeDefined()
		expect(json.wouldPerform.length).toBeGreaterThan(0)
	})

	// =========================================================================
	// Conflict detection tests
	// =========================================================================

	it("should fail when --all used with component args", async () => {
		testDir = await setupProject("update-all-conflict")

		// Install component
		await installComponent(testDir, "kdco/test-plugin")

		// Try to use --all with component args
		const { exitCode, output } = await runCLI(["update", "kdco/test-plugin", "--all"], testDir)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("Cannot specify components with --all")
	})

	it("should fail when --registry used with component args", async () => {
		testDir = await setupProject("update-registry-conflict")

		// Install component
		await installComponent(testDir, "kdco/test-plugin")

		// Try to use --registry with component args
		const { exitCode, output } = await runCLI(
			["update", "kdco/test-plugin", "--registry", "kdco"],
			testDir,
		)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("Cannot specify components with --registry")
	})

	it("should fail when --all used with --registry", async () => {
		testDir = await setupProject("update-all-registry-conflict")

		// Install component
		await installComponent(testDir, "kdco/test-plugin")

		// Try to use --all with --registry
		const { exitCode, output } = await runCLI(["update", "--all", "--registry", "kdco"], testDir)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("Cannot use --all with --registry")
	})

	// =========================================================================
	// Not installed tests
	// =========================================================================

	it("should fail fast when updating non-installed component", async () => {
		testDir = await setupProject("update-not-installed")

		// Don't install anything, just try to update
		// First install something so lock file exists
		await installComponent(testDir, "kdco/test-plugin")

		// Try to update a component that's not installed
		const { exitCode, output } = await runCLI(["update", "kdco/test-agent"], testDir)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("not installed")
		expect(output).toContain("ocx add")
	})

	it("should fail when no lock file exists", async () => {
		testDir = await setupProject("update-no-lock")

		// Don't install anything (no lock file will exist)
		const { exitCode, output } = await runCLI(["update", "kdco/test-plugin"], testDir)

		expect(exitCode).toBe(66) // NotFoundError exit code
		expect(output).toContain("Component 'kdco/test-plugin' is not installed")
	})

	// =========================================================================
	// Ambiguous name tests
	// =========================================================================

	it("should fail with suggestions for ambiguous component name", async () => {
		testDir = await setupProject("update-ambiguous")

		// Install component
		await installComponent(testDir, "kdco/test-plugin")

		// Try to update without registry prefix
		const { exitCode, output } = await runCLI(["update", "test-plugin"], testDir)

		expect(exitCode).not.toBe(0)
		// Should suggest the qualified name
		expect(output).toContain("kdco/test-plugin")
	})

	it("should fail when component name lacks registry alias and is not found", async () => {
		testDir = await setupProject("update-no-prefix")

		// Install component
		await installComponent(testDir, "kdco/test-plugin")

		// Try to update a non-existent component without prefix
		const { exitCode, output } = await runCLI(["update", "nonexistent"], testDir)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("must include a registry alias")
	})

	// =========================================================================
	// No args/flags tests
	// =========================================================================

	it("should fail with usage hint when no args or flags provided", async () => {
		testDir = await setupProject("update-no-args")

		// Install component so lock exists
		await installComponent(testDir, "kdco/test-plugin")

		// Try to run update without any args
		const { exitCode, output } = await runCLI(["update"], testDir)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("Specify components")
		expect(output).toContain("--all")
		expect(output).toContain("--registry")
	})

	// =========================================================================
	// Already up to date tests
	// =========================================================================

	// =========================================================================
	// Invalid version specifier tests (trailing @)
	// =========================================================================

	it("should reject trailing @ with CONFIG error (exit 78)", async () => {
		testDir = await setupProject("update-trailing-at")

		// Install a component so receipt exists
		await installComponent(testDir, "kdco/test-plugin")

		// Try to update with trailing @ (empty version specifier)
		const { exitCode, output } = await runCLI(["update", "kdco/test-plugin@"], testDir)

		expect(exitCode).toBe(78) // ConfigError exit code
		expect(output).toContain("Invalid version specifier")
		expect(output).toContain("kdco/test-plugin@")
	})

	it("should reject trailing @ for any component name", async () => {
		testDir = await setupProject("update-trailing-at-any")

		// Install a component so receipt exists
		await installComponent(testDir, "kdco/test-plugin")

		// Even a non-installed component with trailing @ should fail at parse, not receipt lookup
		const { exitCode, output } = await runCLI(["update", "kdco/researcher@"], testDir)

		expect(exitCode).toBe(78) // ConfigError, NOT 66 (NotFoundError)
		expect(output).toContain("Invalid version specifier")
		expect(output).toContain("kdco/researcher")
	})

	it("should skip components with matching hash (already up to date)", async () => {
		testDir = await setupProject("update-up-to-date")

		// Install component
		await installComponent(testDir, "kdco/test-plugin")

		// Run update without changing registry content
		const { exitCode, output } = await runCLI(["update", "kdco/test-plugin"], testDir)

		expect(exitCode).toBe(0)
		expect(output).toContain("up to date")
	})

	it("should report all up to date when nothing needs updating", async () => {
		testDir = await setupProject("update-all-current")

		// Install components
		await installComponent(testDir, "kdco/test-plugin")
		await installComponent(testDir, "kdco/test-skill")

		// Run update --all without changing anything
		const { exitCode, output } = await runCLI(["update", "--all"], testDir)

		expect(exitCode).toBe(0)
		expect(output).toContain("up to date")
	})

	// =========================================================================
	// JSON output tests
	// =========================================================================

	it("should output JSON when --json flag is used", async () => {
		testDir = await setupProject("update-json")

		// Install component
		await installComponent(testDir, "kdco/test-plugin")

		// Change registry content
		registry.setFileContent("test-plugin", "index.ts", "// JSON output test")

		// Run update with --json
		const { exitCode, output } = await runCLI(["update", "kdco/test-plugin", "--json"], testDir)

		expect(exitCode).toBe(0)

		const json = JSON.parse(output)
		expect(json.success).toBe(true)
		expect(json.updated).toBeDefined()
		expect(json.upToDate).toBeDefined()
	})

	// =========================================================================
	// Edge cases
	// =========================================================================

	it("should update global component and receipt metadata in flattened global paths (global)", async () => {
		testDir = await createTempDir("update-global-happy")

		const xdgConfigHome = join(testDir, "xdg-config")
		const emptyCwd = join(testDir, "workspace")
		await mkdir(emptyCwd, { recursive: true })

		const isolatedOptions = {
			isolated: true as const,
			env: { XDG_CONFIG_HOME: xdgConfigHome },
		}

		expect(existsSync(join(emptyCwd, ".opencode"))).toBe(false)
		expect(existsSync(join(emptyCwd, "ocx.jsonc"))).toBe(false)

		const initResult = await runCLI(["init", "--global"], emptyCwd, isolatedOptions)
		expect(initResult.exitCode).toBe(0)

		const globalConfigPath = join(xdgConfigHome, "opencode", "ocx.jsonc")
		const globalConfig = parseJsonc(await readFile(globalConfigPath, "utf-8")) as Record<
			string,
			unknown
		>
		globalConfig.registries = {
			kdco: { url: registry.url },
		}
		await writeFile(globalConfigPath, JSON.stringify(globalConfig, null, 2))

		const addResult = await runCLI(
			["add", "--global", "kdco/test-plugin"],
			emptyCwd,
			isolatedOptions,
		)
		expect(addResult.exitCode).toBe(0)

		const globalPluginPath = join(xdgConfigHome, "opencode", "plugins", "test-plugin.ts")
		const initialPluginContent = await readFile(globalPluginPath, "utf-8")

		const globalReceiptPath = join(xdgConfigHome, "opencode", ".ocx", "receipt.jsonc")
		const initialReceipt = parseJsonc(await readFile(globalReceiptPath, "utf-8")) as {
			installed: Record<
				string,
				{
					revision: string
					hash: string
					files: Array<{ path: string; hash: string }>
					updatedAt?: string
				}
			>
		}

		const initialEntryMatch = Object.entries(initialReceipt.installed).find(([id]) =>
			id.includes("test-plugin"),
		)
		expect(initialEntryMatch).toBeDefined()
		if (!initialEntryMatch) {
			throw new Error("Expected installed global test-plugin entry")
		}

		const [canonicalId, initialEntry] = initialEntryMatch

		const updatedRegistryContent = "// global update content v2"
		registry.setFileContent("test-plugin", "index.ts", updatedRegistryContent)
		_clearFetcherCacheForTests()

		const updateResult = await runCLI(
			["update", "--global", "kdco/test-plugin"],
			emptyCwd,
			isolatedOptions,
		)

		expect(updateResult.exitCode).toBe(0)
		expect(updateResult.output).toContain("Updated")

		const updatedPluginContent = await readFile(globalPluginPath, "utf-8")
		expect(updatedPluginContent).not.toBe(initialPluginContent)
		expect(updatedPluginContent).toBe(updatedRegistryContent)

		const updatedReceipt = parseJsonc(await readFile(globalReceiptPath, "utf-8")) as {
			installed: Record<
				string,
				{
					revision: string
					hash: string
					files: Array<{ path: string; hash: string }>
					updatedAt?: string
				}
			>
		}
		const updatedEntry = updatedReceipt.installed[canonicalId]
		expect(updatedEntry).toBeDefined()
		if (!updatedEntry) {
			throw new Error("Expected updated global test-plugin entry")
		}

		expect(updatedEntry.revision).not.toBe(initialEntry.revision)
		expect(updatedEntry.hash).not.toBe(initialEntry.hash)
		expect(updatedEntry.files).toHaveLength(1)
		expect(updatedEntry.files[0]?.path).toBe("plugins/test-plugin.ts")
		expect(updatedEntry.files[0]?.hash).not.toBe(initialEntry.files[0]?.hash)
		expect(updatedEntry.updatedAt).toBeDefined()
		expect(Number.isNaN(Date.parse(updatedEntry.updatedAt ?? ""))).toBe(false)
	})

	it("should fail global update when global init is missing (global)", async () => {
		testDir = await createTempDir("update-global-missing-init")

		const xdgConfigHome = join(testDir, "xdg-config")
		const emptyCwd = join(testDir, "workspace")
		await mkdir(emptyCwd, { recursive: true })

		const { exitCode, output } = await runCLI(
			["update", "--global", "kdco/test-plugin"],
			emptyCwd,
			{
				isolated: true,
				env: { XDG_CONFIG_HOME: xdgConfigHome },
			},
		)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("Global config not found")
		expect(output).toContain("ocx init --global")
	})

	it("should fail global update when OpenCode directory exists without ocx global config (global)", async () => {
		testDir = await createTempDir("update-global-missing-ocx-config")

		const xdgConfigHome = join(testDir, "xdg-config")
		const emptyCwd = join(testDir, "workspace")
		await mkdir(emptyCwd, { recursive: true })
		await mkdir(join(xdgConfigHome, "opencode"), { recursive: true })

		const { exitCode, output } = await runCLI(
			["update", "--global", "kdco/test-plugin"],
			emptyCwd,
			{
				isolated: true,
				env: { XDG_CONFIG_HOME: xdgConfigHome },
			},
		)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("Global config not found")
		expect(output).toContain("ocx init --global")
	})

	it("should suggest --global add hint for missing global component", async () => {
		testDir = await createTempDir("update-global-missing-component-hint")

		const xdgConfigHome = join(testDir, "xdg-config")
		const emptyCwd = join(testDir, "workspace")
		await mkdir(emptyCwd, { recursive: true })

		const isolatedOptions = {
			isolated: true as const,
			env: { XDG_CONFIG_HOME: xdgConfigHome },
		}

		const initResult = await runCLI(["init", "--global"], emptyCwd, isolatedOptions)
		expect(initResult.exitCode).toBe(0)

		const globalConfigPath = join(xdgConfigHome, "opencode", "ocx.jsonc")
		const globalConfig = parseJsonc(await readFile(globalConfigPath, "utf-8")) as Record<
			string,
			unknown
		>
		globalConfig.registries = {
			kdco: { url: registry.url },
		}
		await writeFile(globalConfigPath, JSON.stringify(globalConfig, null, 2))

		const addResult = await runCLI(
			["add", "--global", "kdco/test-plugin"],
			emptyCwd,
			isolatedOptions,
		)
		expect(addResult.exitCode).toBe(0)

		const { exitCode, output } = await runCLI(
			["update", "--global", "kdco/test-agent"],
			emptyCwd,
			isolatedOptions,
		)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("ocx add --global kdco/test-agent")
		expect(output).not.toContain("Run 'ocx add kdco/test-agent' to install it first.")
	})

	it("should suggest generic --global add hint when no global components installed", async () => {
		testDir = await createTempDir("update-global-no-components-installed-hint")

		const xdgConfigHome = join(testDir, "xdg-config")
		const emptyCwd = join(testDir, "workspace")
		await mkdir(emptyCwd, { recursive: true })

		const isolatedOptions = {
			isolated: true as const,
			env: { XDG_CONFIG_HOME: xdgConfigHome },
		}

		const initResult = await runCLI(["init", "--global"], emptyCwd, isolatedOptions)
		expect(initResult.exitCode).toBe(0)

		const globalConfigPath = join(xdgConfigHome, "opencode", "ocx.jsonc")
		const globalConfig = parseJsonc(await readFile(globalConfigPath, "utf-8")) as Record<
			string,
			unknown
		>
		globalConfig.registries = {
			kdco: { url: registry.url },
		}
		await writeFile(globalConfigPath, JSON.stringify(globalConfig, null, 2))

		const { exitCode, output } = await runCLI(
			["update", "--global", "--all"],
			emptyCwd,
			isolatedOptions,
		)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("No components installed")
		expect(output).toContain("ocx add --global <component>")
		expect(output).not.toContain("ocx add <component>")
	})

	it("should handle component with dependencies correctly", async () => {
		testDir = await setupProject("update-with-deps")

		// Install component with dependencies
		await installComponent(testDir, "kdco/test-agent")

		// Verify all dependencies were installed (matches mock-registry paths)
		expect(existsSync(join(testDir, ".opencode", "agents", "test-agent.md"))).toBe(true)
		expect(existsSync(join(testDir, ".opencode", "skills", "test-skill", "SKILL.md"))).toBe(true)
		expect(existsSync(join(testDir, ".opencode", "plugins", "test-plugin.ts"))).toBe(true)

		// Change registry content for the main component only
		registry.setFileContent("test-agent", "agent.md", "# Agent v2")
		_clearFetcherCacheForTests() // Clear cache to ensure fresh fetch

		// Run update on just the agent
		const { exitCode, output } = await runCLI(["update", "kdco/test-agent"], testDir)

		expect(exitCode).toBe(0)
		expect(output).toContain("Updated")

		// Verify agent was updated
		const agentContent = await readFile(
			join(testDir, ".opencode", "agents", "test-agent.md"),
			"utf-8",
		)
		expect(agentContent).toBe("# Agent v2")
	})

	it("preflights target resolution before writing any files during update", async () => {
		testDir = await setupProject("update-preflight-target-resolution")

		await installComponent(testDir, "kdco/test-plugin")

		const pluginPath = join(testDir, ".opencode", "plugins", "test-plugin.ts")
		const originalPluginContent = await readFile(pluginPath, "utf-8")

		await writeFile(join(testDir, ".opencode", "command"), "blocker")

		registry.setRouteError(
			"/components/test-plugin.json",
			200,
			JSON.stringify({
				name: "test-plugin",
				"dist-tags": {
					latest: "1.0.0",
				},
				versions: {
					"1.0.0": {
						name: "test-plugin",
						type: "plugin",
						description: "Preflight failure fixture",
						files: [
							{ path: "index.ts", target: "plugins/test-plugin.ts" },
							{ path: "extra.md", target: "command/update-preflight-collision.md" },
						],
						dependencies: [],
					},
				},
			}),
		)
		registry.setFileContent("test-plugin", "index.ts", "// should-not-be-written")
		registry.setFileContent("test-plugin", "extra.md", "extra")
		_clearFetcherCacheForTests()

		try {
			const { exitCode, output } = await runCLI(["update", "kdco/test-plugin"], testDir)

			expect(exitCode).not.toBe(0)
			expect(output).toContain("not a directory")

			const afterFailurePluginContent = await readFile(pluginPath, "utf-8")
			expect(afterFailurePluginContent).toBe(originalPluginContent)
		} finally {
			registry.clearRouteOverrides()
			registry.clearFileContent()
			_clearFetcherCacheForTests()
		}
	})

	it("rolls back already-written files when apply phase fails mid-update", async () => {
		testDir = await setupProject("update-atomic-rollback")

		await installComponent(testDir, "kdco/test-plugin")

		const pluginPath = join(testDir, ".opencode", "plugins", "test-plugin.ts")
		const receiptPath = join(testDir, ".ocx", "receipt.jsonc")
		const originalPluginContent = await readFile(pluginPath, "utf-8")
		const originalReceiptContent = await readFile(receiptPath, "utf-8")

		await mkdir(join(testDir, ".opencode", "plugins", "directory-target"), { recursive: true })

		registry.setRouteError(
			"/components/test-plugin.json",
			200,
			JSON.stringify({
				name: "test-plugin",
				"dist-tags": {
					latest: "1.0.0",
				},
				versions: {
					"1.0.0": {
						name: "test-plugin",
						type: "plugin",
						description: "Apply phase failure fixture",
						files: [
							{ path: "index.ts", target: "plugins/test-plugin.ts" },
							{ path: "second.md", target: "plugins/directory-target" },
						],
						dependencies: [],
					},
				},
			}),
		)
		registry.setFileContent("test-plugin", "index.ts", "// should-be-rolled-back")
		registry.setFileContent("test-plugin", "second.md", "second")
		_clearFetcherCacheForTests()

		try {
			const { exitCode, output } = await runCLI(["update", "kdco/test-plugin"], testDir)

			expect(exitCode).not.toBe(0)
			expect(output).toContain("target path is a directory")

			expect(await readFile(pluginPath, "utf-8")).toBe(originalPluginContent)
			expect(await readFile(receiptPath, "utf-8")).toBe(originalReceiptContent)
		} finally {
			registry.clearRouteOverrides()
			registry.clearFileContent()
			_clearFetcherCacheForTests()
		}
	})

	it("maps update failure phases to accurate spinner messages", () => {
		expect(resolveUpdateFailureMessage("check")).toBe("Failed to check for updates")
		expect(resolveUpdateFailureMessage("apply")).toBe("Failed to update components")
	})

	it("succeeds when backup cleanup fails after commit and leaves committed state", async () => {
		testDir = await setupProject("update-post-commit-cleanup-failure")

		await installComponent(testDir, "kdco/test-plugin")

		const pluginPath = join(testDir, ".opencode", "plugins", "test-plugin.ts")
		const receiptPath = join(testDir, ".ocx", "receipt.jsonc")
		const originalReceiptContent = await readFile(receiptPath, "utf-8")

		registry.setFileContent("test-plugin", "index.ts", "// committed-despite-cleanup-failure")
		_clearFetcherCacheForTests()

		const provider = await LocalConfigProvider.requireInitialized(testDir)
		const rmSpy = spyOn(fsPromises, "rm").mockImplementation(
			async (
				targetPath: Parameters<typeof fsPromises.rm>[0],
				options?: Parameters<typeof fsPromises.rm>[1],
			) => {
				if (String(targetPath).includes(".ocx-update-backup-")) {
					throw new Error("injected backup cleanup failure")
				}

				return fsRm(targetPath, options)
			},
		)

		try {
			await expect(
				runUpdateCore(["kdco/test-plugin"], { quiet: true }, provider),
			).resolves.toBeUndefined()
		} finally {
			rmSpy.mockRestore()
		}

		expect(await readFile(pluginPath, "utf-8")).toBe("// committed-despite-cleanup-failure")
		expect(await readFile(receiptPath, "utf-8")).not.toBe(originalReceiptContent)
	})

	it("restores original file when swap rename fails after backup exists", async () => {
		testDir = await setupProject("update-swap-rename-failure")

		await installComponent(testDir, "kdco/test-plugin")

		const pluginPath = join(testDir, ".opencode", "plugins", "test-plugin.ts")
		const receiptPath = join(testDir, ".ocx", "receipt.jsonc")
		const originalPluginContent = await readFile(pluginPath, "utf-8")
		const originalReceiptContent = await readFile(receiptPath, "utf-8")

		registry.setFileContent("test-plugin", "index.ts", "// rename-boundary-failure")
		_clearFetcherCacheForTests()

		let sawBackupRename = false
		let sawInjectedSwapFailure = false
		const provider = await LocalConfigProvider.requireInitialized(testDir)

		const renameWithInjectedSwapFailure = async (
			oldPath: string,
			newPath: string,
		): Promise<void> => {
			if (newPath.includes(".ocx-update-backup-")) {
				await fsRename(oldPath, newPath)
				sawBackupRename = true
				return
			}

			if (
				oldPath.includes(".ocx-update-tmp-") &&
				/[\\/]plugins[\\/]test-plugin\.ts$/.test(newPath)
			) {
				sawInjectedSwapFailure = true
				throw new Error("injected swap rename failure")
			}

			await fsRename(oldPath, newPath)
		}

		await expect(
			runUpdateCore(["kdco/test-plugin"], { quiet: true }, provider, {
				rename: renameWithInjectedSwapFailure,
			}),
		).rejects.toThrow(/injected swap rename failure/)

		expect(sawBackupRename).toBe(true)
		expect(sawInjectedSwapFailure).toBe(true)
		expect(await readFile(pluginPath, "utf-8")).toBe(originalPluginContent)
		expect(await readFile(receiptPath, "utf-8")).toBe(originalReceiptContent)

		const pluginDirEntries = await readdir(join(testDir, ".opencode", "plugins"))
		expect(pluginDirEntries.some((entry) => entry.includes(".ocx-update-backup-"))).toBe(false)
		expect(pluginDirEntries.some((entry) => entry.includes(".ocx-update-tmp-"))).toBe(false)
	})

	it("should fail if not initialized", async () => {
		testDir = await createTempDir("update-no-init")

		const { exitCode, output } = await runCLI(["update", "kdco/test-plugin"], testDir)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("ocx init")
	})
})

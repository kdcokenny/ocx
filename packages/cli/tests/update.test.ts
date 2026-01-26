import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
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
		await runCLI(["init", "--force"], dir)

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
		const { exitCode, output } = await runCLI(["add", componentName, "--force"], dir)
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
		const filePath = join(testDir, ".opencode/plugin/test-plugin.ts")
		const originalContent = await readFile(filePath, "utf-8")
		expect(originalContent).toContain("test-plugin")

		// Change registry content to simulate update
		const newContent = "// Updated content for test-plugin v2"
		registry.setFileContent("test-plugin", "index.ts", newContent)

		// Run update
		const { exitCode, output } = await runCLI(["update", "kdco/test-plugin"], testDir)

		expect(exitCode).toBe(0)
		expect(output).toContain("Updated")

		// Verify file was updated
		const updatedContent = await readFile(filePath, "utf-8")
		expect(updatedContent).toBe(newContent)

		// Verify lock file was updated
		const lockPath = join(testDir, ".opencode/ocx.lock")
		const lock = parseJsonc(await readFile(lockPath, "utf-8")) as Record<string, unknown>
		const installed = lock.installed as Record<string, { updatedAt?: string }>
		expect(installed["kdco/test-plugin"].updatedAt).toBeDefined()
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
		const pluginContent = await readFile(join(testDir, ".opencode/plugin/test-plugin.ts"), "utf-8")
		expect(pluginContent).toBe("// Plugin v2")

		const skillContent = await readFile(
			join(testDir, ".opencode/skills/test-skill/SKILL.md"),
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
		const filePath = join(testDir, ".opencode/plugin/test-plugin.ts")
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
		const filePath = join(testDir, ".opencode/plugin/test-plugin.ts")
		const originalContent = await readFile(filePath, "utf-8")
		const lockPath = join(testDir, ".opencode/ocx.lock")
		const originalLock = await readFile(lockPath, "utf-8")

		// Change registry content
		registry.setFileContent("test-plugin", "index.ts", "// Dry run change")

		// Run update with --dry-run
		const { exitCode, output } = await runCLI(["update", "kdco/test-plugin", "--dry-run"], testDir)

		expect(exitCode).toBe(0)
		expect(output).toContain("Would update")

		// Verify file was NOT modified
		const currentContent = await readFile(filePath, "utf-8")
		expect(currentContent).toBe(originalContent)

		// Verify lock was NOT modified
		const currentLock = await readFile(lockPath, "utf-8")
		expect(currentLock).toBe(originalLock)
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
		expect(json.wouldUpdate).toBeDefined()
		expect(json.wouldUpdate.length).toBeGreaterThan(0)
	})

	// =========================================================================
	// @version syntax tests
	// =========================================================================

	it("should pin to specific version with @version syntax", async () => {
		testDir = await setupProject("update-version")

		// Install component
		await installComponent(testDir, "kdco/test-plugin")

		// Record original file content
		const filePath = join(testDir, ".opencode/plugin/test-plugin.ts")
		const originalContent = await readFile(filePath, "utf-8")

		// Change registry content
		registry.setFileContent("test-plugin", "index.ts", "// Version pinned content")

		// Run update with @version syntax
		const { exitCode, output } = await runCLI(["update", "kdco/test-plugin@1.0.0"], testDir)

		expect(exitCode).toBe(0)
		expect(output).toContain("Updated")

		// Verify file was updated (not just that exit code is 0)
		const updatedContent = await readFile(filePath, "utf-8")
		expect(updatedContent).not.toBe(originalContent)
		expect(updatedContent).toBe("// Version pinned content")

		// Verify lock has the specified version
		const lockPath = join(testDir, ".opencode/ocx.lock")
		const lock = parseJsonc(await readFile(lockPath, "utf-8")) as Record<string, unknown>
		const installed = lock.installed as Record<string, { version: string }>
		expect(installed["kdco/test-plugin"].version).toBe("1.0.0")
	})

	it("should allow multiple components with different versions", async () => {
		testDir = await setupProject("update-version-multi")

		// Install multiple components
		await installComponent(testDir, "kdco/test-plugin")
		await installComponent(testDir, "kdco/test-skill")

		// Change registry content for both
		registry.setFileContent("test-plugin", "index.ts", "// Plugin v1.0.0")
		registry.setFileContent("test-skill", "SKILL.md", "# Skill v1.0.0")

		// Update multiple components with same version (both have 1.0.0 available)
		const { exitCode, output } = await runCLI(
			["update", "kdco/test-plugin@1.0.0", "kdco/test-skill@1.0.0"],
			testDir,
		)

		expect(exitCode).toBe(0)
		expect(output).toContain("Updated")

		// Verify lock has the specified versions
		const lockPath = join(testDir, ".opencode/ocx.lock")
		const lock = parseJsonc(await readFile(lockPath, "utf-8")) as Record<string, unknown>
		const installed = lock.installed as Record<string, { version: string }>
		expect(installed["kdco/test-plugin"].version).toBe("1.0.0")
		expect(installed["kdco/test-skill"].version).toBe("1.0.0")
	})

	it("should fail with empty version specifier", async () => {
		testDir = await setupProject("update-version-empty")

		// Install component
		await installComponent(testDir, "kdco/test-plugin")

		// Try to update with empty version
		const { exitCode, output } = await runCLI(["update", "kdco/test-plugin@"], testDir)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("Invalid version specifier")
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

		expect(exitCode).not.toBe(0)
		expect(output).toContain("Nothing installed yet")
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

	it("should fail when component name lacks registry prefix and is not found", async () => {
		testDir = await setupProject("update-no-prefix")

		// Install component
		await installComponent(testDir, "kdco/test-plugin")

		// Try to update a non-existent component without prefix
		const { exitCode, output } = await runCLI(["update", "nonexistent"], testDir)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("must include a registry prefix")
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

	it("should handle component with dependencies correctly", async () => {
		testDir = await setupProject("update-with-deps")

		// Install component with dependencies
		await installComponent(testDir, "kdco/test-agent")

		// Verify all dependencies were installed
		expect(existsSync(join(testDir, ".opencode/agent/test-agent.md"))).toBe(true)
		expect(existsSync(join(testDir, ".opencode/skills/test-skill/SKILL.md"))).toBe(true)
		expect(existsSync(join(testDir, ".opencode/plugin/test-plugin.ts"))).toBe(true)

		// Change registry content for the main component only
		registry.setFileContent("test-agent", "agent.md", "# Agent v2")

		// Run update on just the agent
		const { exitCode } = await runCLI(["update", "kdco/test-agent"], testDir)

		expect(exitCode).toBe(0)

		// Verify agent was updated
		const agentContent = await readFile(join(testDir, ".opencode/agent/test-agent.md"), "utf-8")
		expect(agentContent).toBe("# Agent v2")
	})

	it("should fail if not initialized", async () => {
		testDir = await createTempDir("update-no-init")

		const { exitCode, output } = await runCLI(["update", "kdco/test-plugin"], testDir)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("ocx init")
	})
})

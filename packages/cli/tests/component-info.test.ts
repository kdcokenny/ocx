import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { EXIT_CODES } from "../src/utils/errors"
import { cleanupTempDir, createTempDir, runCLI } from "./helpers"
import { type MockRegistry, startMockRegistry } from "./mock-registry"

describe("ocx component info", () => {
	let testDir: string
	let registry: MockRegistry

	beforeEach(async () => {
		testDir = await createTempDir("component-info-test")
		registry = startMockRegistry()
		await runCLI(["init", "--force"], testDir)
		const addResult = await runCLI(["registry", "add", registry.url, "--name", "test"], testDir)
		if (addResult.exitCode !== 0) {
			console.log("Failed to add registry in component-info test:", addResult.output)
		}
	})

	afterEach(async () => {
		registry.stop()
		await cleanupTempDir(testDir)
	})

	// Test case 1: Basic functionality - token estimates for a skill component
	it("should display token estimates for a skill component", async () => {
		const result = await runCLI(["component", "info", "test-skill"], testDir)

		// Should succeed
		expect(result.exitCode).toBe(0)

		// Should contain component information
		expect(result.output).toContain("test-skill")
		expect(result.output).toContain("ocx:skill")
		expect(result.output).toContain("A test skill")

		// Should contain token estimates section
		expect(result.output).toContain("Token Estimates:")
		expect(result.output).toContain("Claude (Sonnet)")
		expect(result.output).toContain("GPT-4o")
		expect(result.output).toContain("tokens")

		// Should contain average estimate
		expect(result.output).toContain("Estimated Context:")
		expect(result.output).toContain("avg")

		// Should contain file stats
		expect(result.output).toContain("Files:")
		expect(result.output).toContain("Size:")
	})

	// Test case 2: Agent component
	it("should display token estimates for an agent component", async () => {
		const result = await runCLI(["component", "info", "test-agent"], testDir)

		expect(result.exitCode).toBe(0)
		expect(result.output).toContain("test-agent")
		expect(result.output).toContain("ocx:agent")
		expect(result.output).toContain("Token Estimates:")
	})

	// Test case 3: JSON output mode
	it("should output valid JSON when --json flag is used", async () => {
		const result = await runCLI(["component", "info", "test-skill", "--json"], testDir)

		expect(result.exitCode).toBe(0)

		// Parse output as JSON
		const json = JSON.parse(result.stdout)

		// Validate structure
		expect(json.success).toBe(true)
		expect(json.component).toBeDefined()
		expect(json.component.name).toBe("test-skill")
		expect(json.component.type).toBe("ocx:skill")
		expect(json.component.description).toBeDefined()

		// Validate token estimates
		expect(json.tokenEstimates).toBeDefined()
		expect(typeof json.tokenEstimates.claude).toBe("number")
		expect(typeof json.tokenEstimates.gpt4o).toBe("number")
		expect(typeof json.tokenEstimates.average).toBe("number")

		// Validate stats
		expect(json.stats).toBeDefined()
		expect(typeof json.stats.totalFiles).toBe("number")
		expect(typeof json.stats.totalBytes).toBe("number")
	})

	// Test case 4: Component not found error
	it("should handle component not found error gracefully", async () => {
		const result = await runCLI(["component", "info", "nonexistent-component"], testDir)

		expect(result.exitCode).toBe(EXIT_CODES.NOT_FOUND)
		expect(result.output.toLowerCase()).toContain("not found")
	})

	// Test case 5: Network error handling
	it("should handle network errors gracefully", async () => {
		// Configure mock registry to return 500 error for a specific component
		registry.setRouteError("/component/error-component.json", 500, "Internal Server Error")

		const result = await runCLI(["component", "info", "error-component"], testDir)

		expect(result.exitCode).toBe(EXIT_CODES.NOT_FOUND)
		// Component not found because the registry returned an error
	})

	// Test case 6: Quiet mode
	it("should respect --quiet flag", async () => {
		const result = await runCLI(["component", "info", "test-skill", "--quiet"], testDir)

		expect(result.exitCode).toBe(0)
		expect(result.stdout.trim()).toBe("")
		expect(result.stderr.trim()).toBe("")
	})

	// Test case 7: Quiet + JSON mode
	it("should respect --quiet --json flags together", async () => {
		const result = await runCLI(["component", "info", "test-skill", "--quiet", "--json"], testDir)

		expect(result.exitCode).toBe(0)
		// Should contain ONLY JSON output (no spinners, progress messages)
		const json = JSON.parse(result.stdout)
		expect(json.success).toBe(true)
		expect(result.stderr.trim()).toBe("")
	})

	// Test case 8: Registry-qualified component name
	it("should fetch component from correct registry when qualified", async () => {
		const result = await runCLI(["component", "info", "test/test-plugin"], testDir)

		expect(result.exitCode).toBe(0)
		expect(result.output).toContain("test-plugin")
	})

	// Test case 9: Plugin component (different type)
	it("should handle plugin component type", async () => {
		const result = await runCLI(["component", "info", "test-plugin"], testDir)

		expect(result.exitCode).toBe(0)
		expect(result.output).toContain("test-plugin")
		expect(result.output).toContain("ocx:plugin")
		expect(result.output).toContain("Token Estimates:")
	})
})

describe("ocx component info --with-dependencies", () => {
	let testDir: string
	let registry: MockRegistry

	beforeEach(async () => {
		testDir = await createTempDir("component-info-deps-test")
		registry = startMockRegistry()
		await runCLI(["init", "--force"], testDir)
		const addResult = await runCLI(["registry", "add", registry.url, "--name", "test"], testDir)
		if (addResult.exitCode !== 0) {
			console.log("Failed to add registry in component-info-deps test:", addResult.output)
		}
	})

	afterEach(async () => {
		registry.stop()
		await cleanupTempDir(testDir)
	})

	// Test case 1: Display dependency tree with --with-dependencies flag
	it("should display dependency tree with --with-dependencies flag", async () => {
		const result = await runCLI(
			["component", "info", "test-agent-with-deps", "--with-dependencies"],
			testDir,
		)

		expect(result.exitCode).toBe(0)

		// Should contain Dependencies section
		expect(result.output).toContain("Dependencies:")

		// Should list the dependency
		expect(result.output).toContain("test-skill-dep")

		// Should contain Cumulative Estimates section
		expect(result.output).toContain("Cumulative Estimates (with dependencies):")

		// Should show main component qualifier
		expect(result.output).toContain("(test-agent-with-deps only):")

		// Should show total context
		expect(result.output).toContain("Total Context:")
	})

	// Test case 2: Output valid JSON with --with-dependencies --json
	it("should output valid JSON with --with-dependencies --json", async () => {
		const result = await runCLI(
			["component", "info", "test-agent-with-deps", "--with-dependencies", "--json"],
			testDir,
		)

		expect(result.exitCode).toBe(0)

		// Parse output as JSON
		const json = JSON.parse(result.stdout)

		// Validate structure
		expect(json.success).toBe(true)
		expect(json.dependencies).toBeDefined()
		expect(json.dependencies.components).toBeInstanceOf(Array)
		expect(json.dependencies.components.length).toBeGreaterThan(0)

		// Validate dependency structure
		const dep = json.dependencies.components[0]
		expect(dep.name).toBeDefined()
		expect(dep.qualifiedName).toBeDefined()
		expect(dep.type).toBeDefined()
		expect(dep.tokenEstimates).toBeDefined()
		expect(dep.totalFiles).toBeDefined()
		expect(dep.totalBytes).toBeDefined()

		// Validate cumulative structure
		expect(json.dependencies.cumulative).toBeDefined()
		expect(json.dependencies.cumulative.tokenEstimates).toBeDefined()
		expect(json.dependencies.cumulative.totalFiles).toBeDefined()
		expect(json.dependencies.cumulative.totalBytes).toBeDefined()
	})

	// Test case 3: Handle multi-level dependencies correctly
	it("should handle multi-level dependencies correctly", async () => {
		const result = await runCLI(
			["component", "info", "test-multi-level", "--with-dependencies"],
			testDir,
		)

		expect(result.exitCode).toBe(0)

		// Should show multiple dependencies in output
		expect(result.output).toContain("Dependencies:")

		// Both level-2 and level-3 should be shown
		expect(result.output).toContain("test-level-2")
		expect(result.output).toContain("test-level-3")

		// Should show cumulative estimates
		expect(result.output).toContain("Cumulative Estimates (with dependencies):")
	})

	// Test case 4: Don't show dependencies without flag
	it("should not show dependencies without flag", async () => {
		const result = await runCLI(["component", "info", "test-agent-with-deps"], testDir)

		expect(result.exitCode).toBe(0)

		// Should NOT contain Dependencies section
		expect(result.output).not.toContain("Dependencies:")

		// Should NOT contain qualifier
		expect(result.output).not.toContain("(test-agent-with-deps only):")

		// Should use original label
		expect(result.output).toContain("Token Estimates:")
		expect(result.output).toContain("Estimated Context:")
	})

	// Test case 5: Handle component with no dependencies gracefully
	it("should handle component with no dependencies gracefully", async () => {
		const result = await runCLI(
			["component", "info", "test-skill-dep", "--with-dependencies"],
			testDir,
		)

		expect(result.exitCode).toBe(0)

		// Should succeed without errors
		expect(result.output).toContain("test-skill-dep")

		// For components with no dependencies, should still show token estimates
		// but not have a Dependencies section with items
		expect(result.output).toContain("Token Estimates:")
	})
})

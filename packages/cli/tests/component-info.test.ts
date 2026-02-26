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
		expect(json.tokenEstimates).not.toHaveProperty("gemini")

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

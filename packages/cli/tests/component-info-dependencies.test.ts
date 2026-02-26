import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { runComponentInfoCore } from "../src/commands/component/info"
import { LocalConfigProvider } from "../src/config/provider"
import type { MockRegistry } from "./mock-registry"
import { startMockRegistry } from "./mock-registry"

describe("component info with dependencies", () => {
	let registry: MockRegistry
	let testDir: string
	let configPath: string

	beforeAll(async () => {
		// Set up test directory
		testDir = `/tmp/ocx-test-deps-${Date.now()}`
		configPath = path.join(testDir, ".opencode")
		await fs.promises.mkdir(configPath, { recursive: true })

		// Create config with mock registry
		registry = startMockRegistry()
		const config = {
			$schema: "https://ocx.sh/schema.json",
			registries: {
				test: {
					url: registry.url,
				},
			},
		}
		await fs.promises.writeFile(
			path.join(configPath, "ocx.jsonc"),
			JSON.stringify(config, null, "\t"),
		)

		// Load test fixtures
		const fixturesDir = path.join(__dirname, "fixtures/token-estimation")

		// Load file contents
		const agentMain = await fs.promises.readFile(
			path.join(fixturesDir, "sample-files/agent-main.md"),
			"utf-8",
		)
		const skillDepContent = await fs.promises.readFile(
			path.join(fixturesDir, "sample-files/skill-dep.md"),
			"utf-8",
		)
		const multiMain = await fs.promises.readFile(
			path.join(fixturesDir, "sample-files/multi-main.md"),
			"utf-8",
		)
		const level2Content = await fs.promises.readFile(
			path.join(fixturesDir, "sample-files/level-2.md"),
			"utf-8",
		)
		const level3Content = await fs.promises.readFile(
			path.join(fixturesDir, "sample-files/level-3.md"),
			"utf-8",
		)

		// Set file contents in mock registry
		registry.setFileContent("test-agent-with-deps", "agent-main.md", agentMain)
		registry.setFileContent("test-skill-dep", "skill-dep.md", skillDepContent)
		registry.setFileContent("test-multi-level", "multi-main.md", multiMain)
		registry.setFileContent("test-level-2", "level-2.md", level2Content)
		registry.setFileContent("test-level-3", "level-3.md", level3Content)
	})

	afterAll(async () => {
		registry.stop()
		await fs.promises.rm(testDir, { recursive: true, force: true })
	})

	it("should resolve single-level dependency tree", async () => {
		const provider = await LocalConfigProvider.requireInitialized(testDir)
		const result = await runComponentInfoCore(
			"test-agent-with-deps",
			{ cwd: testDir, withDependencies: true },
			provider,
		)

		expect(result.dependencies).toBeDefined()
		expect(result.dependencies?.components).toHaveLength(1)
		expect(result.dependencies?.components[0].name).toBe("test-skill-dep")
		expect(result.dependencies?.components[0].qualifiedName).toBe("test/test-skill-dep")
		expect(result.dependencies?.components[0].type).toBe("ocx:skill")
	})

	it("should resolve multi-level dependency tree", async () => {
		const provider = await LocalConfigProvider.requireInitialized(testDir)
		const result = await runComponentInfoCore(
			"test-multi-level",
			{ cwd: testDir, withDependencies: true },
			provider,
		)

		expect(result.dependencies).toBeDefined()
		expect(result.dependencies?.components).toHaveLength(2)
		// Dependencies should be in resolution order (dependencies first)
		expect(result.dependencies?.components.map((c) => c.name)).toEqual([
			"test-level-3",
			"test-level-2",
		])
	})

	it("should calculate cumulative token estimates correctly", async () => {
		const provider = await LocalConfigProvider.requireInitialized(testDir)
		const result = await runComponentInfoCore(
			"test-agent-with-deps",
			{ cwd: testDir, withDependencies: true },
			provider,
		)

		expect(result.dependencies).toBeDefined()

		// Main component tokens
		expect(result.tokenEstimates.average).toBeGreaterThan(0)

		// Dependency tokens
		expect(result.dependencies?.components[0].tokenEstimates.average).toBeGreaterThan(0)

		// Cumulative should be approximately the sum (within 10% tolerance for tokenizer variance)
		const mainTokens = result.tokenEstimates.average
		const depTokens = result.dependencies?.components[0].tokenEstimates.average || 0
		const expectedCumulative = mainTokens + depTokens
		const actualCumulative = result.dependencies?.cumulative.tokenEstimates.average || 0

		const tolerance = expectedCumulative * 0.1
		expect(Math.abs(actualCumulative - expectedCumulative)).toBeLessThan(tolerance)
	})

	it("should not include dependencies field when flag is false", async () => {
		const provider = await LocalConfigProvider.requireInitialized(testDir)
		const result = await runComponentInfoCore(
			"test-agent-with-deps",
			{ cwd: testDir, withDependencies: false },
			provider,
		)

		expect(result.dependencies).toBeUndefined()
	})

	it("should identify main component correctly", async () => {
		const provider = await LocalConfigProvider.requireInitialized(testDir)
		const result = await runComponentInfoCore(
			"test-agent-with-deps",
			{ cwd: testDir, withDependencies: true },
			provider,
		)

		// Main component should be test-agent-with-deps
		expect(result.component.name).toBe("test-agent-with-deps")

		// Dependencies should not include the main component
		expect(
			result.dependencies?.components.find((c) => c.name === "test-agent-with-deps"),
		).toBeUndefined()
	})
})

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import { cleanupTempDir, createTempDir, runCLI } from "./helpers"
import { type MockRegistry, startMockRegistry } from "./mock-registry"

describe("ocx search", () => {
	let testDir: string
	let registry: MockRegistry

	beforeEach(async () => {
		testDir = await createTempDir("search-test")
		registry = startMockRegistry()
		await runCLI(["init", "--project"], testDir)
		const addResult = await runCLI(
			["registry", "add", "--project", registry.url, "--name", "kdco"],
			testDir,
		)
		if (addResult.exitCode !== 0) {
			console.log("Failed to add registry in search test:", addResult.output)
		}
	})

	afterEach(async () => {
		registry.stop()
		await cleanupTempDir(testDir)
	})

	it("should find components across registries", async () => {
		const { exitCode, output } = await runCLI(["search", "--project", "test", "--verbose"], testDir)

		if (exitCode !== 0 || !output.includes("kdco/test-agent")) {
			console.log(output)
		}
		expect(exitCode).toBe(0)
		expect(output).toContain("kdco/test-agent")
		expect(output).toContain("kdco/test-skill")
		expect(output).toContain("kdco/test-plugin")
	})

	it("should filter by query", async () => {
		const { exitCode, output } = await runCLI(["search", "--project", "agent"], testDir)

		expect(exitCode).toBe(0)
		expect(output).toContain("kdco/test-agent")
		expect(output).not.toContain("kdco/test-skill")
	})

	it("should list installed components with --installed", async () => {
		// Install one component
		await runCLI(["add", "--project", "kdco/test-plugin"], testDir)

		const { exitCode, output } = await runCLI(["search", "--project", "--installed"], testDir)

		expect(exitCode).toBe(0)
		expect(output).toContain("kdco/test-plugin")
		expect(output).not.toContain("kdco/test-agent")
	})

	it("should output JSON when requested", async () => {
		const { exitCode, output } = await runCLI(["search", "--project", "test", "--json"], testDir)

		expect(exitCode).toBe(0)
		const json = JSON.parse(output)
		expect(json.success).toBe(true)
		expect(json.data.components).toBeDefined()
		expect(json.data.components.length).toBeGreaterThan(0)
	})

	it("should fail clearly when a configured registry is incompatible", async () => {
		const badServer = Bun.serve({
			port: 0,
			fetch() {
				return Response.json({
					author: "Legacy Registry",
					components: [{ name: "legacy", type: "plugin", description: "Legacy" }],
				})
			},
		})

		try {
			const configPath = join(testDir, ".opencode", "ocx.jsonc")
			const config = parseJsonc(await readFile(configPath, "utf-8")) as {
				registries?: Record<string, { url: string }>
			}

			config.registries = {
				...(config.registries ?? {}),
				legacy: { url: `http://localhost:${badServer.port}` },
			}
			await writeFile(configPath, JSON.stringify(config, null, 2))

			const { exitCode, output } = await runCLI(["search", "--project", "test", "--json"], testDir)

			expect(exitCode).not.toBe(0)
			const json = JSON.parse(output)
			expect(json.success).toBe(false)
			expect(json.error.message).toContain("Use OCX 2")
		} finally {
			badServer.stop()
		}
	})
})

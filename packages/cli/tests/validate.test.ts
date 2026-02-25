import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { validateRegistryLocal } from "../src/lib/validate-registry-local"
import { cleanupTempDir, createTempDir } from "./helpers"

describe("validateRegistryLocal", () => {
	let testDir: string

	beforeEach(async () => {
		testDir = await createTempDir("validate-test")
	})

	afterEach(async () => {
		await cleanupTempDir(testDir)
	})

	it("should validate a valid registry", async () => {
		// Create a valid registry
		const registryJson = {
			name: "Test Registry",
			namespace: "test",
			version: "1.0.0",
			author: "Test Author",
			components: [
				{
					name: "test-component",
					type: "ocx:plugin",
					description: "A test component",
					files: ["plugin/test.ts"],
					dependencies: [],
				},
			],
		}

		await writeFile(join(testDir, "registry.json"), JSON.stringify(registryJson, null, 2))

		// Create files directory and source file
		const filesDir = join(testDir, "files")
		await mkdir(filesDir, { recursive: true })
		await mkdir(join(filesDir, "plugin"), { recursive: true })
		await writeFile(join(filesDir, "plugin", "test.ts"), "// Test plugin")

		const result = await validateRegistryLocal(testDir)

		expect(result.valid).toBe(true)
		expect(result.errors).toHaveLength(0)
		expect(result.stats.componentsCount).toBe(1)
		expect(result.stats.filesCount).toBe(1)
		expect(result.metadata?.name).toBe("Test Registry")
		expect(result.metadata?.namespace).toBe("test")
	})

	it("should detect missing source files", async () => {
		// Create registry with file reference that doesn't exist
		const registryJson = {
			name: "Test Registry",
			namespace: "test",
			version: "1.0.0",
			author: "Test Author",
			components: [
				{
					name: "test-component",
					type: "ocx:plugin",
					description: "A test component",
					files: ["plugin/missing.ts"],
					dependencies: [],
				},
			],
		}

		await writeFile(join(testDir, "registry.json"), JSON.stringify(registryJson, null, 2))

		// Create files directory but NOT the referenced file
		const filesDir = join(testDir, "files")
		await mkdir(filesDir, { recursive: true })

		const result = await validateRegistryLocal(testDir)

		expect(result.valid).toBe(false)
		expect(result.errors).toHaveLength(1)
		expect(result.errors[0].type).toBe("missing_file")
		expect(result.errors[0].component).toBe("test-component")
	})
})

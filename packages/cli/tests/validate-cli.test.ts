import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir, runCLI } from "./helpers"

describe("ocx validate command", () => {
	let testDir: string

	beforeEach(async () => {
		testDir = await createTempDir("validate-cli-test")
	})

	afterEach(async () => {
		await cleanupTempDir(testDir)
	})

	it("should exit 0 for valid registry", async () => {
		// Setup valid registry
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

		const { exitCode, output } = await runCLI(["validate", "."], testDir)

		expect(exitCode).toBe(0)
		expect(output).toContain("Valid registry")
	})

	it("should exit 1 for invalid registry", async () => {
		// Setup invalid registry (missing file)
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

		const { exitCode, output } = await runCLI(["validate", "."], testDir)

		expect(exitCode).toBe(1)
		expect(output).toContain("missing_file")
	})

	it("should exit 0 with warnings in non-strict mode", async () => {
		// Setup registry with duplicate targets
		const registryJson = {
			name: "Test Registry",
			namespace: "test",
			version: "1.0.0",
			author: "Test Author",
			components: [
				{
					name: "comp-a",
					type: "ocx:plugin",
					description: "Component A",
					files: [{ path: "plugin/shared.ts", target: ".opencode/plugin/shared.ts" }],
					dependencies: [],
				},
				{
					name: "comp-b",
					type: "ocx:plugin",
					description: "Component B",
					files: [{ path: "plugin/shared.ts", target: ".opencode/plugin/shared.ts" }],
					dependencies: [],
				},
			],
		}

		await writeFile(join(testDir, "registry.json"), JSON.stringify(registryJson, null, 2))

		// Create all source files
		const filesDir = join(testDir, "files")
		await mkdir(filesDir, { recursive: true })
		await mkdir(join(filesDir, "plugin"), { recursive: true })
		await writeFile(join(filesDir, "plugin", "shared.ts"), "// Shared file")

		const { exitCode } = await runCLI(["validate", "."], testDir)

		expect(exitCode).toBe(0)
	})

	it("should exit 1 with --no-duplicate-targets flag", async () => {
		// Setup registry with duplicate targets
		const registryJson = {
			name: "Test Registry",
			namespace: "test",
			version: "1.0.0",
			author: "Test Author",
			components: [
				{
					name: "comp-a",
					type: "ocx:plugin",
					description: "Component A",
					files: [{ path: "plugin/shared.ts", target: ".opencode/plugin/shared.ts" }],
					dependencies: [],
				},
				{
					name: "comp-b",
					type: "ocx:plugin",
					description: "Component B",
					files: [{ path: "plugin/shared.ts", target: ".opencode/plugin/shared.ts" }],
					dependencies: [],
				},
			],
		}

		await writeFile(join(testDir, "registry.json"), JSON.stringify(registryJson, null, 2))

		// Create all source files
		const filesDir = join(testDir, "files")
		await mkdir(filesDir, { recursive: true })
		await mkdir(join(filesDir, "plugin"), { recursive: true })
		await writeFile(join(filesDir, "plugin", "shared.ts"), "// Shared file")

		const { exitCode } = await runCLI(["validate", ".", "--no-duplicate-targets"], testDir)

		expect(exitCode).toBe(1)
	})

	it("should output enhanced human-readable format by default", async () => {
		// Setup registry with some errors and warnings
		const registryJson = {
			name: "Test Registry",
			namespace: "test",
			version: "1.0.0",
			author: "Test Author",
			components: [
				{
					name: "comp-a",
					type: "ocx:plugin",
					description: "Component A",
					files: [{ path: "plugin/shared.ts", target: ".opencode/plugin/shared.ts" }],
					dependencies: [],
				},
				{
					name: "comp-b",
					type: "ocx:plugin",
					description: "Component B",
					files: [{ path: "plugin/shared.ts", target: ".opencode/plugin/shared.ts" }],
					dependencies: [],
				},
			],
		}

		await writeFile(join(testDir, "registry.json"), JSON.stringify(registryJson, null, 2))

		// Create all source files
		const filesDir = join(testDir, "files")
		await mkdir(filesDir, { recursive: true })
		await mkdir(join(filesDir, "plugin"), { recursive: true })
		await writeFile(join(filesDir, "plugin", "shared.ts"), "// Shared file")

		const { exitCode, output } = await runCLI(["validate", "."], testDir)

		// Should contain formatted sections
		expect(output).toContain("Registry Metadata")
		expect(output).toContain("Name: Test Registry")
		expect(output).toContain("Namespace: test")
		expect(output).toContain("Version: 1.0.0")
		expect(output).toContain("Author: Test Author")
		expect(output).toContain("Components")
		expect(output).toContain("2 total")
		expect(output).toContain("Files")
		expect(output).toContain("Warnings")
		expect(output).toContain("duplicate_target")
		expect(output).toContain("Summary")
		expect(exitCode).toBe(0)
	})

	it("should treat Windows absolute paths as local, not remote", async () => {
		// Setup valid registry
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

		// Use Windows-style absolute path
		const windowsPath = `C:${testDir.replace(/\//g, "\\")}`
		const { exitCode, output } = await runCLI(["validate", windowsPath], testDir)

		// Should NOT be treated as remote URL
		expect(output).not.toContain("Remote validation not yet implemented")
		expect(exitCode).toBeDefined()
	})
})

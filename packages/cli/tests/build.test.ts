import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir, runCLI } from "./helpers"

describe("ocx build", () => {
	let testDir: string

	beforeEach(async () => {
		testDir = await createTempDir("build-test")
	})

	afterEach(async () => {
		await cleanupTempDir(testDir)
	})

	it("should build a valid registry from source", async () => {
		// Create registry source
		const sourceDir = join(testDir, "registry")
		await mkdir(sourceDir, { recursive: true })

		const registryJson = {
			name: "Test Registry",
			namespace: "kdco",
			version: "1.0.0",
			author: "Test Author",
			components: [
				{
					name: "comp-1",
					type: "ocx:plugin",
					description: "Test component 1",
					files: [{ path: "index.ts", target: ".opencode/plugin/comp-1.ts" }],
					dependencies: [],
				},
				{
					name: "comp-2",
					type: "ocx:agent",
					description: "Test component 2",
					files: [{ path: "agent.md", target: ".opencode/agent/comp-2.md" }],
					dependencies: ["comp-1"],
				},
			],
		}

		await writeFile(join(sourceDir, "registry.json"), JSON.stringify(registryJson, null, 2))

		// Create the files directory and source files
		const filesDir = join(sourceDir, "files")
		await mkdir(filesDir, { recursive: true })
		await writeFile(join(filesDir, "index.ts"), "// Test plugin content")
		await writeFile(join(filesDir, "agent.md"), "# Test agent content")

		// Run build
		const outDir = "dist"
		const { exitCode, output } = await runCLI(["build", "registry", "--out", outDir], testDir)

		if (exitCode !== 0) {
			console.log(output)
		}
		expect(exitCode).toBe(0)
		expect(output).toContain("Built 2 components")

		// Verify output files
		const fullOutDir = join(testDir, outDir)
		expect(existsSync(join(fullOutDir, "index.json"))).toBe(true)
		expect(existsSync(join(fullOutDir, "components", "comp-1.json"))).toBe(true)
		expect(existsSync(join(fullOutDir, "components", "comp-2.json"))).toBe(true)
		expect(existsSync(join(fullOutDir, ".well-known", "ocx.json"))).toBe(true)

		// Verify .well-known/ocx.json content (discovery endpoint)
		const discovery = JSON.parse(
			await readFile(join(fullOutDir, ".well-known", "ocx.json"), "utf-8"),
		)
		expect(discovery.registry).toBe("/index.json")

		// Verify index.json content
		const index = JSON.parse(await readFile(join(fullOutDir, "index.json"), "utf-8"))
		expect(index.name).toBe("Test Registry")
		expect(index.components.length).toBe(2)
		expect(index.components[0].name).toBe("comp-1")
	})

	it("should fail if component name is invalid", async () => {
		const sourceDir = join(testDir, "registry-invalid")
		await mkdir(sourceDir, { recursive: true })

		const registryJson = {
			name: "Invalid Registry",
			namespace: "kdco",
			version: "1.0.0",
			author: "Test Author",
			components: [
				{
					name: "INVALID_NAME",
					type: "ocx:plugin",
					description: "Invalid component",
					files: [{ path: "index.ts", target: ".opencode/plugin/invalid.ts" }],
					dependencies: [],
				},
			],
		}

		await writeFile(join(sourceDir, "registry.json"), JSON.stringify(registryJson, null, 2))

		const { exitCode, output } = await runCLI(["build", "registry-invalid"], testDir)

		expect(exitCode).not.toBe(0)
		// Match the actual Zod error message for invalid component name
		expect(output).toContain("Must be lowercase")
	})

	it("should fail on missing dependencies", async () => {
		const sourceDir = join(testDir, "registry-missing-dep")
		await mkdir(sourceDir, { recursive: true })

		const registryJson = {
			name: "Missing Dep Registry",
			namespace: "kdco",
			version: "1.0.0",
			author: "Test Author",
			components: [
				{
					name: "comp",
					type: "ocx:plugin",
					description: "Component with missing dep",
					files: [{ path: "index.ts", target: ".opencode/plugin/comp.ts" }],
					dependencies: ["non-existent"],
				},
			],
		}

		await writeFile(join(sourceDir, "registry.json"), JSON.stringify(registryJson, null, 2))

		const { exitCode, output } = await runCLI(["build", "registry-missing-dep"], testDir)

		expect(exitCode).not.toBe(0)
		// Match the actual Zod error message
		expect(output).toContain(
			"Bare dependencies must reference components that exist in the registry",
		)
	})

	it("should build from registry.jsonc with comments", async () => {
		const sourceDir = join(testDir, "registry-jsonc")
		await mkdir(sourceDir, { recursive: true })

		// JSONC content with inline and block comments
		const registryJsonc = `{
	// This is an inline comment
	"name": "JSONC Registry",
	"namespace": "test",
	"version": "1.0.0",
	"author": "Test Author",
	/*
	 * Block comment describing components
	 */
	"components": [
		{
			"name": "jsonc-comp",
			"type": "ocx:plugin",
			"description": "Component from JSONC", // trailing comment
			"files": [{ "path": "index.ts", "target": ".opencode/plugin/jsonc-comp.ts" }],
			"dependencies": [],
		}
	],
}`

		await writeFile(join(sourceDir, "registry.jsonc"), registryJsonc)

		// Create the files directory and source files
		const filesDir = join(sourceDir, "files")
		await mkdir(filesDir, { recursive: true })
		await writeFile(join(filesDir, "index.ts"), "// JSONC test content")

		// Run build
		const outDir = "dist-jsonc"
		const { exitCode, output } = await runCLI(["build", "registry-jsonc", "--out", outDir], testDir)

		if (exitCode !== 0) {
			console.log(output)
		}
		expect(exitCode).toBe(0)
		expect(output).toContain("Built 1 component")

		// Verify output files
		const fullOutDir = join(testDir, outDir)
		expect(existsSync(join(fullOutDir, "index.json"))).toBe(true)
		expect(existsSync(join(fullOutDir, "components", "jsonc-comp.json"))).toBe(true)

		// Verify index.json content
		const index = JSON.parse(await readFile(join(fullOutDir, "index.json"), "utf-8"))
		expect(index.name).toBe("JSONC Registry")
	})

	it("should prefer registry.jsonc over registry.json when both exist", async () => {
		const sourceDir = join(testDir, "registry-both")
		await mkdir(sourceDir, { recursive: true })

		// Create registry.json with one name
		const registryJson = {
			name: "JSON Registry",
			namespace: "test",
			version: "1.0.0",
			author: "Test Author",
			components: [
				{
					name: "from-json",
					type: "ocx:plugin",
					description: "Component from JSON",
					files: [{ path: "index.ts", target: ".opencode/plugin/from-json.ts" }],
					dependencies: [],
				},
			],
		}

		// Create registry.jsonc with a different name
		const registryJsonc = `{
	// JSONC should be preferred
	"name": "JSONC Registry Preferred",
	"namespace": "test",
	"version": "1.0.0",
	"author": "Test Author",
	"components": [
		{
			"name": "from-jsonc",
			"type": "ocx:plugin",
			"description": "Component from JSONC",
			"files": [{ "path": "index.ts", "target": ".opencode/plugin/from-jsonc.ts" }],
			"dependencies": [],
		}
	]
}`

		await writeFile(join(sourceDir, "registry.json"), JSON.stringify(registryJson, null, 2))
		await writeFile(join(sourceDir, "registry.jsonc"), registryJsonc)

		// Create the files directory and source files
		const filesDir = join(sourceDir, "files")
		await mkdir(filesDir, { recursive: true })
		await writeFile(join(filesDir, "index.ts"), "// Test content")

		// Run build
		const outDir = "dist-both"
		const { exitCode, output } = await runCLI(["build", "registry-both", "--out", outDir], testDir)

		if (exitCode !== 0) {
			console.log(output)
		}
		expect(exitCode).toBe(0)

		// Verify the JSONC version was used (check for JSONC registry name)
		const fullOutDir = join(testDir, outDir)
		const index = JSON.parse(await readFile(join(fullOutDir, "index.json"), "utf-8"))
		expect(index.name).toBe("JSONC Registry Preferred")
		expect(index.components[0].name).toBe("from-jsonc")
	})

	it("should fail on circular dependencies", async () => {
		const sourceDir = join(testDir, "registry-circular")
		await mkdir(sourceDir, { recursive: true })

		const registryJson = {
			name: "Circular Registry",
			namespace: "test",
			version: "1.0.0",
			author: "Test Author",
			components: [
				{
					name: "comp-a",
					type: "ocx:plugin",
					description: "Component A",
					files: [{ path: "a.ts", target: ".opencode/plugin/a.ts" }],
					dependencies: ["comp-b"],
				},
				{
					name: "comp-b",
					type: "ocx:plugin",
					description: "Component B",
					files: [{ path: "b.ts", target: ".opencode/plugin/b.ts" }],
					dependencies: ["comp-c"],
				},
				{
					name: "comp-c",
					type: "ocx:plugin",
					description: "Component C",
					files: [{ path: "c.ts", target: ".opencode/plugin/c.ts" }],
					dependencies: ["comp-a"],
				},
			],
		}

		await writeFile(join(sourceDir, "registry.json"), JSON.stringify(registryJson, null, 2))

		// Create the files directory and source files
		const filesDir = join(sourceDir, "files")
		await mkdir(filesDir, { recursive: true })
		await writeFile(join(filesDir, "a.ts"), "// Component A")
		await writeFile(join(filesDir, "b.ts"), "// Component B")
		await writeFile(join(filesDir, "c.ts"), "// Component C")

		const { exitCode, output } = await runCLI(["build", "registry-circular"], testDir)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("Circular dependency")
	})
})

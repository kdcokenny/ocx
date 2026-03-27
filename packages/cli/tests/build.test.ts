import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { EXIT_CODES } from "../src/utils/errors"
import { cleanupTempDir, createTempDir, runCLI } from "./helpers"

const REGISTRY_SCHEMA_V2_URL = "https://ocx.kdco.dev/schemas/v2/registry.json"

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
			$schema: REGISTRY_SCHEMA_V2_URL,
			name: "Test Registry",
			namespace: "kdco",
			version: "1.0.0",
			author: "Test Author",
			components: [
				{
					name: "comp-1",
					type: "plugin", // V2: No ocx: prefix
					description: "Test component 1",
					files: [{ path: "index.ts", target: "plugins/comp-1.ts" }], // V2: root-relative
					dependencies: [],
				},
				{
					name: "comp-2",
					type: "agent", // V2: No ocx: prefix
					description: "Test component 2",
					files: [{ path: "agent.md", target: "agents/comp-2.md" }], // V2: root-relative
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

	it("should display validation results when --show-validation is used", async () => {
		const sourceDir = join(testDir, "registry")
		await mkdir(sourceDir, { recursive: true })

		const registryJson = {
			$schema: REGISTRY_SCHEMA_V2_URL,
			name: "Test Registry",
			namespace: "kdco",
			version: "1.0.0",
			author: "Test Author",
			components: [
				{
					name: "test-component",
					type: "plugin",
					description: "Test component",
					files: [{ path: "test.ts", target: "plugins/test.ts" }],
					dependencies: [],
				},
			],
		}

		await writeFile(join(sourceDir, "registry.json"), JSON.stringify(registryJson, null, 2))

		const filesDir = join(sourceDir, "files")
		await mkdir(filesDir, { recursive: true })
		await writeFile(join(filesDir, "test.ts"), "// test file")

		const outDir = "dist"
		const { exitCode, output } = await runCLI(
			["build", "registry", "--out", outDir, "--show-validation"],
			testDir,
		)

		expect(exitCode).toBe(0)

		// Verify validation output structure and content
		expect(output).toContain("Running validation checks...")
		expect(output).toContain("Schema compatibility and structure")
		expect(output).toContain("Source files")
		expect(output).toContain("No circular dependencies")
		expect(output).toContain("No duplicate targets")

		// Verify validation appears before build success message
		const validationIndex = output.indexOf("Running validation checks...")
		const buildIndex = output.indexOf("Built")
		expect(validationIndex).toBeGreaterThan(-1)
		expect(buildIndex).toBeGreaterThan(-1)
		expect(validationIndex).toBeLessThan(buildIndex)
	})

	it("should NOT display validation results when --show-validation is not used", async () => {
		const sourceDir = join(testDir, "registry-no-validation")
		await mkdir(sourceDir, { recursive: true })

		const registryJson = {
			$schema: REGISTRY_SCHEMA_V2_URL,
			name: "Test Registry No Validation",
			namespace: "kdco",
			version: "1.0.0",
			author: "Test Author",
			components: [
				{
					name: "test-component",
					type: "plugin",
					description: "Test component",
					files: [{ path: "test.ts", target: "plugins/test.ts" }],
					dependencies: [],
				},
			],
		}

		await writeFile(join(sourceDir, "registry.json"), JSON.stringify(registryJson, null, 2))

		const filesDir = join(sourceDir, "files")
		await mkdir(filesDir, { recursive: true })
		await writeFile(join(filesDir, "test.ts"), "// test file")

		const outDir = "dist"
		const { exitCode, output } = await runCLI(
			["build", "registry-no-validation", "--out", outDir],
			testDir,
		)

		expect(exitCode).toBe(0)

		// Verify validation output is NOT present
		expect(output).not.toContain("Running validation checks...")
		expect(output).not.toContain("Schema compatibility and structure")
		expect(output).not.toContain("Source files")
		expect(output).not.toContain("No circular dependencies")
		expect(output).not.toContain("No duplicate targets")

		// Verify build output is still present
		expect(output).toContain("Built 1 component")
	})

	it("should run --show-validation checks even in JSON mode", async () => {
		const sourceDir = join(testDir, "registry-json-show-validation")
		await mkdir(sourceDir, { recursive: true })

		const registryJson = {
			$schema: REGISTRY_SCHEMA_V2_URL,
			name: "JSON Validation Registry",
			namespace: "kdco",
			version: "1.0.0",
			author: "Test Author",
			components: [
				{
					name: "component-a",
					type: "plugin",
					description: "Component A",
					files: [],
					dependencies: ["component-b"],
				},
				{
					name: "component-b",
					type: "plugin",
					description: "Component B",
					files: [],
					dependencies: ["component-a"],
				},
			],
		}

		await writeFile(join(sourceDir, "registry.json"), JSON.stringify(registryJson, null, 2))

		const outDir = "dist-json-show-validation"
		const { exitCode, stdout, stderr } = await runCLI(
			["build", "registry-json-show-validation", "--out", outDir, "--show-validation", "--json"],
			testDir,
		)

		expect(exitCode).toBe(EXIT_CODES.CONFIG)
		expect(stderr).toBe("")

		const payload = JSON.parse(stdout) as {
			success: boolean
			error: {
				code: string
				details: {
					valid: boolean
					errors: string[]
					summary: {
						circularDependencyErrors: number
					}
				}
			}
		}

		expect(payload.success).toBe(false)
		expect(payload.error.code).toBe("VALIDATION_FAILED")
		expect(payload.error.details.valid).toBe(false)
		expect(
			payload.error.details.errors.some((error) => error.includes("Circular dependency")),
		).toBe(true)
		expect(payload.error.details.summary.circularDependencyErrors).toBeGreaterThan(0)
	})

	it("should run --show-validation checks even in quiet mode", async () => {
		const sourceDir = join(testDir, "registry-quiet-show-validation")
		await mkdir(sourceDir, { recursive: true })

		const registryJson = {
			$schema: REGISTRY_SCHEMA_V2_URL,
			name: "Quiet Validation Registry",
			namespace: "kdco",
			version: "1.0.0",
			author: "Test Author",
			components: [
				{
					name: "component-a",
					type: "plugin",
					description: "Component A",
					files: [],
					dependencies: ["component-b"],
				},
				{
					name: "component-b",
					type: "plugin",
					description: "Component B",
					files: [],
					dependencies: ["component-a"],
				},
			],
		}

		await writeFile(join(sourceDir, "registry.json"), JSON.stringify(registryJson, null, 2))

		const outDir = "dist-quiet-show-validation"
		const { exitCode, output } = await runCLI(
			["build", "registry-quiet-show-validation", "--out", outDir, "--show-validation", "--quiet"],
			testDir,
		)

		expect(exitCode).toBe(EXIT_CODES.CONFIG)
		expect(output).not.toContain("Built")
		expect(output).not.toContain("Running validation checks")
	})

	it("should fail if component name is invalid", async () => {
		const sourceDir = join(testDir, "registry-invalid")
		await mkdir(sourceDir, { recursive: true })

		const registryJson = {
			$schema: REGISTRY_SCHEMA_V2_URL,
			name: "Invalid Registry",
			namespace: "kdco",
			version: "1.0.0",
			author: "Test Author",
			components: [
				{
					name: "INVALID_NAME",
					type: "plugin", // V2: No ocx: prefix
					description: "Invalid component",
					files: [{ path: "index.ts", target: "plugins/invalid.ts" }], // V2: root-relative
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
			$schema: REGISTRY_SCHEMA_V2_URL,
			name: "Missing Dep Registry",
			namespace: "kdco",
			version: "1.0.0",
			author: "Test Author",
			components: [
				{
					name: "comp",
					type: "plugin", // V2: No ocx: prefix
					description: "Component with missing dep",
					files: [{ path: "index.ts", target: "plugins/comp.ts" }], // V2: root-relative
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
	"$schema": "${REGISTRY_SCHEMA_V2_URL}",
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
			"type": "plugin",
			"description": "Component from JSONC", // trailing comment
			"files": [{ "path": "index.ts", "target": "plugins/jsonc-comp.ts" }],
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
			$schema: REGISTRY_SCHEMA_V2_URL,
			name: "JSON Registry",
			namespace: "test",
			version: "1.0.0",
			author: "Test Author",
			components: [
				{
					name: "from-json",
					type: "plugin", // V2: No ocx: prefix
					description: "Component from JSON",
					files: [{ path: "index.ts", target: "plugins/from-json.ts" }], // V2: root-relative
					dependencies: [],
				},
			],
		}

		// Create registry.jsonc with a different name
		const registryJsonc = `{
	// JSONC should be preferred
	"$schema": "${REGISTRY_SCHEMA_V2_URL}",
	"name": "JSONC Registry Preferred",
	"namespace": "test",
	"version": "1.0.0",
	"author": "Test Author",
	"components": [
		{
			"name": "from-jsonc",
			"type": "plugin",
			"description": "Component from JSONC",
			"files": [{ "path": "index.ts", "target": "plugins/from-jsonc.ts" }],
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

	it("should fail when schema URL is missing (legacy v1)", async () => {
		const sourceDir = join(testDir, "registry-missing-schema")
		await mkdir(sourceDir, { recursive: true })

		const registryJson = {
			name: "Missing Schema Registry",
			namespace: "test",
			version: "1.0.0",
			author: "Test Author",
			components: [],
		}

		await writeFile(join(sourceDir, "registry.json"), JSON.stringify(registryJson, null, 2))

		const { exitCode, output } = await runCLI(["build", "registry-missing-schema"], testDir)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("legacy-schema-v1")
		expect(output).toContain("v2")
	})

	it("should fail when schema major is unsupported", async () => {
		const sourceDir = join(testDir, "registry-unsupported-schema")
		await mkdir(sourceDir, { recursive: true })

		const registryJson = {
			$schema: "https://ocx.kdco.dev/schemas/v3/registry.json",
			name: "Unsupported Schema Registry",
			namespace: "test",
			version: "1.0.0",
			author: "Test Author",
			components: [],
		}

		await writeFile(join(sourceDir, "registry.json"), JSON.stringify(registryJson, null, 2))

		const { exitCode, output } = await runCLI(["build", "registry-unsupported-schema"], testDir)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("unsupported-schema-version")
		expect(output).toContain("v2")
	})

	it("should fail when schema URL is non-canonical", async () => {
		const sourceDir = join(testDir, "registry-invalid-schema")
		await mkdir(sourceDir, { recursive: true })

		const registryJson = {
			$schema: "https://example.com/registry.json",
			name: "Invalid Schema URL Registry",
			namespace: "test",
			version: "1.0.0",
			author: "Test Author",
			components: [],
		}

		await writeFile(join(sourceDir, "registry.json"), JSON.stringify(registryJson, null, 2))

		const { exitCode, output } = await runCLI(["build", "registry-invalid-schema"], testDir)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("invalid-schema-url")
		expect(output).toContain(REGISTRY_SCHEMA_V2_URL)
	})

	it("should fail when schema URL includes explicit default HTTPS port (:443)", async () => {
		const sourceDir = join(testDir, "registry-invalid-schema-443")
		await mkdir(sourceDir, { recursive: true })

		const registryJson = {
			$schema: "https://ocx.kdco.dev:443/schemas/v2/registry.json",
			name: "Invalid Schema URL Port Registry",
			namespace: "test",
			version: "1.0.0",
			author: "Test Author",
			components: [],
		}

		await writeFile(join(sourceDir, "registry.json"), JSON.stringify(registryJson, null, 2))

		const { exitCode, output } = await runCLI(["build", "registry-invalid-schema-443"], testDir)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("invalid-schema-url")
		expect(output).toContain(REGISTRY_SCHEMA_V2_URL)
	})
})

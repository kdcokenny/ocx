import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
	loadRegistrySource,
	validateRegistrySchema,
	validateRegistrySource,
	validateRegistryWithOptions,
	validateSourceFiles,
} from "../src/lib/validators"
import { cleanupTempDir, createTempDir } from "./helpers"

describe("validateRegistrySource", () => {
	describe("schema validation", () => {
		it("should validate a valid registry schema", () => {
			const validRegistry = {
				$schema: "https://ocx.kdco.dev/schemas/v2/registry.json",
				name: "Test Registry",
				namespace: "test",
				version: "1.0.0",
				author: "Test Author",
				components: [],
			}

			const result = validateRegistrySource(validRegistry, "/fake/path")

			expect(result.valid).toBe(true)
			expect(result.errors).toEqual([])
		})
	})
})

describe("validateSourceFiles", () => {
	let testDir: string

	beforeEach(async () => {
		testDir = await createTempDir("validate-files-test")
	})

	afterEach(async () => {
		await cleanupTempDir(testDir)
	})

	it("should validate when all source files exist", async () => {
		const filesDir = join(testDir, "files")
		await mkdir(filesDir, { recursive: true })
		await writeFile(join(filesDir, "test.ts"), "// test file")

		const registry = {
			$schema: "https://ocx.kdco.dev/schemas/v2/registry.json",
			name: "Test Registry",
			namespace: "test",
			version: "1.0.0",
			author: "Test Author",
			components: [
				{
					name: "test-component",
					type: "plugin" as const,
					description: "Test",
					files: [{ path: "test.ts", target: "plugins/test.ts" }],
					dependencies: [],
				},
			],
		}

		const result = await validateSourceFiles(registry, testDir)

		expect(result.valid).toBe(true)
		expect(result.errors).toEqual([])
	})

	it("should report error when source file is missing", async () => {
		const filesDir = join(testDir, "files")
		await mkdir(filesDir, { recursive: true })

		const registry = {
			$schema: "https://ocx.kdco.dev/schemas/v2/registry.json",
			name: "Test Registry",
			namespace: "test",
			version: "1.0.0",
			author: "Test Author",
			components: [
				{
					name: "test-component",
					type: "plugin" as const,
					description: "Test",
					files: [{ path: "missing.ts", target: "plugins/missing.ts" }],
					dependencies: [],
				},
			],
		}

		const result = await validateSourceFiles(registry, testDir)

		expect(result.valid).toBe(false)
		expect(result.errors.length).toBeGreaterThan(0)
		expect(result.errors[0]).toContain("missing.ts")
	})
})

describe("validateRegistryWithOptions", () => {
	let testDir: string

	beforeEach(async () => {
		testDir = await createTempDir("validate-registry-test")
	})

	afterEach(async () => {
		await cleanupTempDir(testDir)
	})

	it("should yield validation errors from all validators", async () => {
		const filesDir = join(testDir, "files")
		await mkdir(filesDir, { recursive: true })

		const registry = {
			$schema: "https://ocx.kdco.dev/schemas/v2/registry.json",
			name: "Test Registry",
			namespace: "test",
			version: "1.0.0",
			author: "Test Author",
			components: [
				{
					name: "comp-a",
					type: "plugin" as const,
					description: "Component A",
					files: [{ path: "missing.ts", target: "plugins/a.ts" }],
					dependencies: ["comp-b"],
				},
				{
					name: "comp-b",
					type: "plugin" as const,
					description: "Component B",
					files: [{ path: "b.ts", target: "plugins/a.ts" }],
					dependencies: ["comp-a"],
				},
			],
		}

		const errors: string[] = []
		for await (const error of validateRegistryWithOptions(registry, testDir, {
			skipDuplicateTargets: false,
		})) {
			errors.push(error)
		}

		// Should have errors from:
		// 1. Missing source file (missing.ts)
		// 2. Circular dependency (comp-a <-> comp-b)
		// 3. Duplicate target (plugins/a.ts used twice)
		expect(errors.length).toBeGreaterThan(0)
		expect(errors.some((e) => e.includes("missing.ts"))).toBe(true)
		expect(errors.some((e) => e.includes("Circular dependency"))).toBe(true)
		expect(errors.some((e) => e.includes("Duplicate target"))).toBe(true)
	})

	it("should treat equivalent target paths as duplicates", async () => {
		const filesDir = join(testDir, "files")
		await mkdir(filesDir, { recursive: true })
		await writeFile(join(filesDir, "a.ts"), "// a")
		await writeFile(join(filesDir, "b.ts"), "// b")

		const registry = {
			$schema: "https://ocx.kdco.dev/schemas/v2/registry.json",
			name: "Test Registry",
			namespace: "test",
			version: "1.0.0",
			author: "Test Author",
			components: [
				{
					name: "comp-a",
					type: "plugin" as const,
					description: "Component A",
					files: [{ path: "a.ts", target: "./plugins/shared.ts" }],
					dependencies: [],
				},
				{
					name: "comp-b",
					type: "plugin" as const,
					description: "Component B",
					files: [{ path: "b.ts", target: "plugins/./shared.ts" }],
					dependencies: [],
				},
			],
		}

		const errors: string[] = []
		for await (const error of validateRegistryWithOptions(registry, testDir, {
			skipDuplicateTargets: false,
		})) {
			errors.push(error)
		}

		expect(errors).toContain(
			'Duplicate target "plugins/shared.ts" in components "comp-a" and "comp-b"',
		)
	})

	it("should skip duplicate target validation when option is set", async () => {
		const filesDir = join(testDir, "files")
		await mkdir(filesDir, { recursive: true })
		await writeFile(join(filesDir, "test.ts"), "// test")

		const registry = {
			$schema: "https://ocx.kdco.dev/schemas/v2/registry.json",
			name: "Test Registry",
			namespace: "test",
			version: "1.0.0",
			author: "Test Author",
			components: [
				{
					name: "comp-a",
					type: "plugin" as const,
					description: "Component A",
					files: [{ path: "test.ts", target: "plugins/same.ts" }],
					dependencies: [],
				},
				{
					name: "comp-b",
					type: "plugin" as const,
					description: "Component B",
					files: [{ path: "test.ts", target: "plugins/same.ts" }],
					dependencies: [],
				},
			],
		}

		const errors: string[] = []
		for await (const error of validateRegistryWithOptions(registry, testDir, {
			skipDuplicateTargets: true,
		})) {
			errors.push(error)
		}

		// Should NOT have duplicate target error
		expect(errors.some((e) => e.includes("Duplicate target"))).toBe(false)
	})
})

describe("loadRegistrySource", () => {
	let testDir: string

	beforeEach(async () => {
		testDir = await createTempDir("load-registry-test")
	})

	afterEach(async () => {
		await cleanupTempDir(testDir)
	})

	it("should load and parse registry.json file", async () => {
		const registryData = {
			$schema: "https://ocx.kdco.dev/schemas/v2/registry.json",
			name: "Test Registry",
			namespace: "test",
			version: "1.0.0",
			author: "Test Author",
			components: [],
		}

		await writeFile(join(testDir, "registry.json"), JSON.stringify(registryData))

		const result = await loadRegistrySource(testDir)

		expect(result.success).toBe(true)
		expect(result.data).toEqual(registryData)
	})

	it("should load and parse registry.jsonc file", async () => {
		const registryData = {
			$schema: "https://ocx.kdco.dev/schemas/v2/registry.json",
			name: "Test Registry",
			namespace: "test",
			version: "1.0.0",
			author: "Test Author",
			components: [],
		}

		// Write JSONC with comments and trailing commas
		await writeFile(
			join(testDir, "registry.jsonc"),
			`{
  // Comment
  "$schema": "https://ocx.kdco.dev/schemas/v2/registry.json",
  "name": "Test Registry",
  "namespace": "test",
  "version": "1.0.0",
  "author": "Test Author",
  "components": [],
}`,
		)

		const result = await loadRegistrySource(testDir)

		expect(result.success).toBe(true)
		expect(result.data).toEqual(registryData)
	})

	it("should prefer registry.jsonc over registry.json when both exist", async () => {
		const jsonData = {
			$schema: "https://ocx.kdco.dev/schemas/v2/registry.json",
			name: "JSON Registry",
			namespace: "json",
			version: "1.0.0",
			author: "JSON Author",
			components: [],
		}

		const jsoncData = {
			$schema: "https://ocx.kdco.dev/schemas/v2/registry.json",
			name: "JSONC Registry",
			namespace: "jsonc",
			version: "1.0.0",
			author: "JSONC Author",
			components: [],
		}

		await writeFile(join(testDir, "registry.json"), JSON.stringify(jsonData))
		await writeFile(join(testDir, "registry.jsonc"), JSON.stringify(jsoncData))

		const result = await loadRegistrySource(testDir)

		expect(result.success).toBe(true)
		expect((result.data as { name?: string } | undefined)?.name).toBe("JSONC Registry")
	})

	it("should return error when no registry file exists", async () => {
		const result = await loadRegistrySource(testDir)

		expect(result.success).toBe(false)
		expect(result.error).toContain("No registry.jsonc or registry.json found")
	})

	it("should return error when registry.jsonc contains malformed JSON", async () => {
		// Write malformed JSONC with syntax error
		await writeFile(
			join(testDir, "registry.jsonc"),
			`{
  "$schema": "https://ocx.kdco.dev/schemas/v2/registry.json",
  "name": "Test Registry",
  "namespace": "test",
  "version": "1.0.0",
  "author": "Test Author",
  "components": [
  // Missing closing bracket
}`,
		)

		const result = await loadRegistrySource(testDir)

		expect(result.success).toBe(false)
		expect(result.error).toBeDefined()
		expect(result.error).toContain("Invalid JSONC")
	})

	it("should return error when registry.json contains malformed JSON", async () => {
		// Write malformed JSON with syntax error
		await writeFile(
			join(testDir, "registry.json"),
			`{
  "$schema": "https://ocx.kdco.dev/schemas/v2/registry.json",
  "name": "Test Registry"
  "namespace": "test"
}`,
		)

		const result = await loadRegistrySource(testDir)

		expect(result.success).toBe(false)
		expect(result.error).toBeDefined()
		expect(result.error).toContain("Invalid JSONC")
	})

	it("should include parse error details in error message", async () => {
		// Write JSONC with unexpected token
		await writeFile(
			join(testDir, "registry.jsonc"),
			`{
  "$schema": "https://ocx.kdco.dev/schemas/v2/registry.json",
  "name": "Test Registry",
  ]
}`,
		)

		const result = await loadRegistrySource(testDir)

		expect(result.success).toBe(false)
		expect(result.error).toBeDefined()
		// Error should contain both the error type and location info
		expect(result.error).toMatch(/Invalid JSONC.*offset/)
	})
})

describe("validateRegistrySchema", () => {
	it("should validate a valid registry schema", () => {
		const validRegistry = {
			$schema: "https://ocx.kdco.dev/schemas/v2/registry.json",
			name: "Test Registry",
			namespace: "test",
			version: "1.0.0",
			author: "Test Author",
			components: [],
		}

		const result = validateRegistrySchema(validRegistry, "/test/path")

		expect(result.valid).toBe(true)
		expect(result.errors).toEqual([])
		expect(result.data).toBeDefined()
	})

	it("should detect schema compatibility issues", () => {
		const incompatibleRegistry = {
			// Missing $schema field - v1 format
			name: "Old Registry",
			version: "1.0.0",
			author: "Test",
			components: [],
		}

		const result = validateRegistrySchema(incompatibleRegistry, "/test/path")

		expect(result.valid).toBe(false)
		expect(result.errors.length).toBeGreaterThan(0)
		expect(result.errors[0]).toContain("schema")
	})

	it("should detect schema validation errors", () => {
		const invalidRegistry = {
			$schema: "https://ocx.kdco.dev/schemas/v2/registry.json",
			name: "Test Registry",
			// Missing required 'version' field
			author: "Test Author",
			components: [],
		}

		const result = validateRegistrySchema(invalidRegistry, "/test/path")

		expect(result.valid).toBe(false)
		expect(result.errors.length).toBeGreaterThan(0)
	})

	it("should return parsed data on success", () => {
		const validRegistry = {
			$schema: "https://ocx.kdco.dev/schemas/v2/registry.json",
			name: "Test Registry",
			namespace: "test",
			version: "1.0.0",
			author: "Test Author",
			components: [
				{
					name: "test-component",
					type: "plugin" as const,
					description: "Test",
					files: [],
					dependencies: [],
				},
			],
		}

		const result = validateRegistrySchema(validRegistry, "/test/path")

		expect(result.valid).toBe(true)
		expect(result.data).toBeDefined()
		expect(result.data?.name).toBe("Test Registry")
		expect(result.data?.components.length).toBe(1)
	})
})

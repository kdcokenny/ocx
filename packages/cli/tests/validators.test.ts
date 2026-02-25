/**
 * Tests for individual validator functions
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import {
	detectCircularDependencies,
	detectDuplicateTargets,
	validateFileExistence,
	validateSchema,
} from "../src/lib/validators/index"
import { runValidation } from "../src/lib/validators/run-validation"
import type { Registry } from "../src/schemas/registry"

describe("validateSchema", () => {
	it("should return no errors for valid registry data", () => {
		const validData = {
			name: "Test Registry",
			namespace: "test",
			version: "1.0.0",
			author: "Test Author",
			components: [],
		}

		const result = validateSchema(validData)

		expect(result.errors).toEqual([])
	})

	it("should return schema errors for invalid registry data", () => {
		const invalidData = {
			name: "",
			namespace: "test",
			version: "invalid-version",
			author: "Test Author",
			components: [],
		}

		const result = validateSchema(invalidData)

		expect(result.errors.length).toBeGreaterThan(0)
		expect(result.errors[0]?.type).toBe("invalid_schema")
	})

	it("should return schema errors for missing required fields", () => {
		const invalidData = {
			namespace: "test",
		}

		const result = validateSchema(invalidData)

		expect(result.errors.length).toBeGreaterThan(0)
		expect(result.errors.some((e) => e.type === "invalid_schema")).toBe(true)
	})
})

describe("validateFileExistence", () => {
	let testDir: string

	beforeAll(async () => {
		testDir = join(import.meta.dir, "tmp-validators-test")
		await mkdir(join(testDir, "files"), { recursive: true })
	})

	afterAll(async () => {
		await rm(testDir, { recursive: true, force: true })
	})

	it("should return no errors when all files exist", async () => {
		// Create test file in plugin subdirectory
		await mkdir(join(testDir, "files", "plugin"), { recursive: true })
		await Bun.write(join(testDir, "files", "plugin", "test.ts"), "// test content")

		const registry: Registry = {
			name: "Test",
			namespace: "test",
			version: "1.0.0",
			author: "Test",
			components: [
				{
					name: "comp1",
					type: "ocx:plugin",
					description: "Test component",
					files: ["plugin/test.ts"],
					dependencies: [],
				},
			],
		}

		const result = await validateFileExistence(registry, testDir)

		expect(result.errors).toEqual([])
		expect(result.filesCount).toBe(1)
	})

	it("should return errors for missing files", async () => {
		const registry: Registry = {
			name: "Test",
			namespace: "test",
			version: "1.0.0",
			author: "Test",
			components: [
				{
					name: "comp1",
					type: "ocx:plugin",
					description: "Test component",
					files: ["plugin/missing.ts"],
					dependencies: [],
				},
			],
		}

		const result = await validateFileExistence(registry, testDir)

		expect(result.errors.length).toBe(1)
		expect(result.errors[0]?.type).toBe("missing_file")
		expect(result.errors[0]?.file).toBe("plugin/missing.ts")
		expect(result.filesCount).toBe(0)
	})
})

describe("detectCircularDependencies", () => {
	it("should return no errors when there are no circular dependencies", () => {
		const registry: Registry = {
			name: "Test",
			namespace: "test",
			version: "1.0.0",
			author: "Test",
			components: [
				{
					name: "comp1",
					type: "ocx:plugin",
					description: "Component 1",
					files: ["plugin/comp1.ts"],
					dependencies: ["comp2"],
				},
				{
					name: "comp2",
					type: "ocx:plugin",
					description: "Component 2",
					files: ["plugin/comp2.ts"],
					dependencies: [],
				},
			],
		}

		const result = detectCircularDependencies(registry)

		expect(result.errors).toEqual([])
	})

	it("should detect direct circular dependency", () => {
		const registry: Registry = {
			name: "Test",
			namespace: "test",
			version: "1.0.0",
			author: "Test",
			components: [
				{
					name: "comp1",
					type: "ocx:plugin",
					description: "Component 1",
					files: ["plugin/comp1.ts"],
					dependencies: ["comp2"],
				},
				{
					name: "comp2",
					type: "ocx:plugin",
					description: "Component 2",
					files: ["plugin/comp2.ts"],
					dependencies: ["comp1"],
				},
			],
		}

		const result = detectCircularDependencies(registry)

		expect(result.errors.length).toBeGreaterThan(0)
		expect(result.errors[0]?.type).toBe("circular_dependency")
		expect(result.errors[0]?.message).toContain("comp1")
		expect(result.errors[0]?.message).toContain("comp2")
	})

	it("should detect indirect circular dependency", () => {
		const registry: Registry = {
			name: "Test",
			namespace: "test",
			version: "1.0.0",
			author: "Test",
			components: [
				{
					name: "comp1",
					type: "ocx:plugin",
					description: "Component 1",
					files: ["plugin/comp1.ts"],
					dependencies: ["comp2"],
				},
				{
					name: "comp2",
					type: "ocx:plugin",
					description: "Component 2",
					files: ["plugin/comp2.ts"],
					dependencies: ["comp3"],
				},
				{
					name: "comp3",
					type: "ocx:plugin",
					description: "Component 3",
					files: ["plugin/comp3.ts"],
					dependencies: ["comp1"],
				},
			],
		}

		const result = detectCircularDependencies(registry)

		expect(result.errors.length).toBeGreaterThan(0)
		expect(result.errors[0]?.type).toBe("circular_dependency")
		expect(result.errors[0]?.message).toContain("comp1")
		expect(result.errors[0]?.message).toContain("comp2")
		expect(result.errors[0]?.message).toContain("comp3")
	})

	it("should ignore cross-namespace dependencies", () => {
		const registry: Registry = {
			name: "Test",
			namespace: "test",
			version: "1.0.0",
			author: "Test",
			components: [
				{
					name: "comp1",
					type: "ocx:plugin",
					description: "Component 1",
					files: ["plugin/comp1.ts"],
					dependencies: ["other/comp2"],
				},
			],
		}

		const result = detectCircularDependencies(registry)

		expect(result.errors).toEqual([])
	})
})

describe("detectDuplicateTargets", () => {
	it("should return no warnings when there are no duplicate targets", () => {
		const registry: Registry = {
			name: "Test",
			namespace: "test",
			version: "1.0.0",
			author: "Test",
			components: [
				{
					name: "comp1",
					type: "ocx:plugin",
					description: "Component 1",
					files: ["plugin/comp1.ts"],
					dependencies: [],
				},
				{
					name: "comp2",
					type: "ocx:plugin",
					description: "Component 2",
					files: ["plugin/comp2.ts"],
					dependencies: [],
				},
			],
		}

		const result = detectDuplicateTargets(registry)

		expect(result.warnings).toEqual([])
	})

	it("should detect duplicate targets from two components", () => {
		const registry: Registry = {
			name: "Test",
			namespace: "test",
			version: "1.0.0",
			author: "Test",
			components: [
				{
					name: "comp1",
					type: "ocx:plugin",
					description: "Component 1",
					files: ["plugin/shared.ts"],
					dependencies: [],
				},
				{
					name: "comp2",
					type: "ocx:plugin",
					description: "Component 2",
					files: ["plugin/shared.ts"],
					dependencies: [],
				},
			],
		}

		const result = detectDuplicateTargets(registry)

		expect(result.warnings.length).toBe(1)
		expect(result.warnings[0]?.type).toBe("duplicate_target")
		expect(result.warnings[0]?.message).toContain("plugin/shared.ts")
		expect(result.warnings[0]?.message).toContain("comp1")
		expect(result.warnings[0]?.message).toContain("comp2")
	})

	it("should detect duplicate targets from multiple components", () => {
		const registry: Registry = {
			name: "Test",
			namespace: "test",
			version: "1.0.0",
			author: "Test",
			components: [
				{
					name: "comp1",
					type: "ocx:plugin",
					description: "Component 1",
					files: ["plugin/shared.ts"],
					dependencies: [],
				},
				{
					name: "comp2",
					type: "ocx:plugin",
					description: "Component 2",
					files: ["plugin/shared.ts"],
					dependencies: [],
				},
				{
					name: "comp3",
					type: "ocx:plugin",
					description: "Component 3",
					files: ["plugin/shared.ts"],
					dependencies: [],
				},
			],
		}

		const result = detectDuplicateTargets(registry)

		expect(result.warnings.length).toBe(1)
		expect(result.warnings[0]?.type).toBe("duplicate_target")
		expect(result.warnings[0]?.message).toContain("comp1")
		expect(result.warnings[0]?.message).toContain("comp2")
		expect(result.warnings[0]?.message).toContain("comp3")
	})

	it("should handle components with different types correctly", () => {
		const registry: Registry = {
			name: "Test",
			namespace: "test",
			version: "1.0.0",
			author: "Test",
			components: [
				{
					name: "comp1",
					type: "ocx:plugin",
					description: "Component 1",
					files: ["plugin/shared.ts"],
					dependencies: [],
				},
				{
					name: "comp2",
					type: "ocx:skill",
					description: "Component 2",
					files: ["skills/shared.ts"],
					dependencies: [],
				},
			],
		}

		const result = detectDuplicateTargets(registry)

		// Different types means different target paths, so no duplicates
		expect(result.warnings).toEqual([])
	})
})

describe("runValidation", () => {
	let testDir: string

	beforeAll(async () => {
		testDir = join(import.meta.dir, "tmp-run-validation-test")
		await mkdir(join(testDir, "files", "plugin"), { recursive: true })
		await Bun.write(
			join(testDir, "registry.json"),
			JSON.stringify({
				name: "Test Registry",
				namespace: "test",
				version: "1.0.0",
				author: "Test Author",
				components: [
					{
						name: "comp1",
						type: "ocx:plugin",
						description: "Test component",
						files: ["plugin/test.ts"],
						dependencies: [],
					},
				],
			}),
		)
		await Bun.write(join(testDir, "files", "plugin", "test.ts"), "// test content")
	})

	afterAll(async () => {
		await rm(testDir, { recursive: true, force: true })
	})

	it("should run all validations and return complete result", async () => {
		const result = await runValidation(testDir)

		expect(result.valid).toBe(true)
		expect(result.errors).toEqual([])
		expect(result.warnings).toEqual([])
		expect(result.stats.componentsCount).toBe(1)
		expect(result.stats.filesCount).toBe(1)
		expect(result.metadata?.name).toBe("Test Registry")
		expect(result.metadata?.namespace).toBe("test")
	})

	it("should detect schema errors", async () => {
		const invalidDir = join(import.meta.dir, "tmp-invalid-schema-test")
		await mkdir(invalidDir, { recursive: true })
		await Bun.write(
			join(invalidDir, "registry.json"),
			JSON.stringify({
				name: "",
				namespace: "test",
				components: [],
			}),
		)

		const result = await runValidation(invalidDir)

		expect(result.valid).toBe(false)
		expect(result.errors.length).toBeGreaterThan(0)
		expect(result.errors.some((e) => e.type === "invalid_schema")).toBe(true)

		await rm(invalidDir, { recursive: true, force: true })
	})

	it("should detect missing files", async () => {
		const missingFileDir = join(import.meta.dir, "tmp-missing-file-test")
		await mkdir(join(missingFileDir, "files"), { recursive: true })
		await Bun.write(
			join(missingFileDir, "registry.json"),
			JSON.stringify({
				name: "Test Registry",
				namespace: "test",
				version: "1.0.0",
				author: "Test Author",
				components: [
					{
						name: "comp1",
						type: "ocx:plugin",
						description: "Test component",
						files: ["plugin/missing.ts"],
						dependencies: [],
					},
				],
			}),
		)

		const result = await runValidation(missingFileDir)

		expect(result.valid).toBe(false)
		expect(result.errors.length).toBe(1)
		expect(result.errors[0]?.type).toBe("missing_file")

		await rm(missingFileDir, { recursive: true, force: true })
	})

	it("should detect circular dependencies", async () => {
		const circularDir = join(import.meta.dir, "tmp-circular-test")
		await mkdir(join(circularDir, "files", "plugin"), { recursive: true })
		await Bun.write(
			join(circularDir, "registry.json"),
			JSON.stringify({
				name: "Test Registry",
				namespace: "test",
				version: "1.0.0",
				author: "Test Author",
				components: [
					{
						name: "comp1",
						type: "ocx:plugin",
						description: "Component 1",
						files: ["plugin/comp1.ts"],
						dependencies: ["comp2"],
					},
					{
						name: "comp2",
						type: "ocx:plugin",
						description: "Component 2",
						files: ["plugin/comp2.ts"],
						dependencies: ["comp1"],
					},
				],
			}),
		)
		await Bun.write(join(circularDir, "files", "plugin", "comp1.ts"), "// test")
		await Bun.write(join(circularDir, "files", "plugin", "comp2.ts"), "// test")

		const result = await runValidation(circularDir)

		expect(result.valid).toBe(false)
		expect(result.errors.length).toBeGreaterThan(0)
		expect(result.errors[0]?.type).toBe("circular_dependency")

		await rm(circularDir, { recursive: true, force: true })
	})

	it("should detect duplicate targets as warnings", async () => {
		const duplicateDir = join(import.meta.dir, "tmp-duplicate-test")
		await mkdir(join(duplicateDir, "files", "plugin"), { recursive: true })
		await Bun.write(
			join(duplicateDir, "registry.json"),
			JSON.stringify({
				name: "Test Registry",
				namespace: "test",
				version: "1.0.0",
				author: "Test Author",
				components: [
					{
						name: "comp1",
						type: "ocx:plugin",
						description: "Component 1",
						files: ["plugin/shared.ts"],
						dependencies: [],
					},
					{
						name: "comp2",
						type: "ocx:plugin",
						description: "Component 2",
						files: ["plugin/shared.ts"],
						dependencies: [],
					},
				],
			}),
		)
		await Bun.write(join(duplicateDir, "files", "plugin", "shared.ts"), "// test")

		const result = await runValidation(duplicateDir)

		expect(result.valid).toBe(true)
		expect(result.errors).toEqual([])
		expect(result.warnings.length).toBe(1)
		expect(result.warnings[0]?.type).toBe("duplicate_target")

		await rm(duplicateDir, { recursive: true, force: true })
	})

	it("should skip circular dependency check when skipCircularDeps is true", async () => {
		const circularDir = join(import.meta.dir, "tmp-skip-circular-test")
		await mkdir(join(circularDir, "files", "plugin"), { recursive: true })
		await Bun.write(
			join(circularDir, "registry.json"),
			JSON.stringify({
				name: "Test Registry",
				namespace: "test",
				version: "1.0.0",
				author: "Test Author",
				components: [
					{
						name: "comp1",
						type: "ocx:plugin",
						description: "Component 1",
						files: ["plugin/comp1.ts"],
						dependencies: ["comp2"],
					},
					{
						name: "comp2",
						type: "ocx:plugin",
						description: "Component 2",
						files: ["plugin/comp2.ts"],
						dependencies: ["comp1"],
					},
				],
			}),
		)
		await Bun.write(join(circularDir, "files", "plugin", "comp1.ts"), "// test")
		await Bun.write(join(circularDir, "files", "plugin", "comp2.ts"), "// test")

		const result = await runValidation(circularDir, { skipCircularDeps: true })

		expect(result.valid).toBe(true)
		expect(result.errors).toEqual([])

		await rm(circularDir, { recursive: true, force: true })
	})

	it("should skip duplicate target check when skipDuplicateTargets is true", async () => {
		const duplicateDir = join(import.meta.dir, "tmp-skip-duplicate-test")
		await mkdir(join(duplicateDir, "files", "plugin"), { recursive: true })
		await Bun.write(
			join(duplicateDir, "registry.json"),
			JSON.stringify({
				name: "Test Registry",
				namespace: "test",
				version: "1.0.0",
				author: "Test Author",
				components: [
					{
						name: "comp1",
						type: "ocx:plugin",
						description: "Component 1",
						files: ["plugin/shared.ts"],
						dependencies: [],
					},
					{
						name: "comp2",
						type: "ocx:plugin",
						description: "Component 2",
						files: ["plugin/shared.ts"],
						dependencies: [],
					},
				],
			}),
		)
		await Bun.write(join(duplicateDir, "files", "plugin", "shared.ts"), "// test")

		const result = await runValidation(duplicateDir, { skipDuplicateTargets: true })

		expect(result.valid).toBe(true)
		expect(result.errors).toEqual([])
		expect(result.warnings).toEqual([])

		await rm(duplicateDir, { recursive: true, force: true })
	})
})

/**
 * Tests for individual validator functions
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { validateFileExistence, validateSchema } from "../src/lib/validators/index"
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

/**
 * Tests for individual validator functions
 */

import { describe, expect, it } from "bun:test"
import { validateSchema } from "../src/lib/validators/index"

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

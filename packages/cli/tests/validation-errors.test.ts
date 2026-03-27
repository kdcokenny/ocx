import { describe, expect, it } from "bun:test"
import {
	categorizeValidationErrors,
	displayCategorizedErrors,
	summarizeValidationErrors,
} from "../src/utils/validation-errors"

describe("categorizeValidationErrors", () => {
	it("should categorize file errors", () => {
		const errors = [
			"comp-a: Source file not found at path/to/file.ts",
			"comp-b: Source file not found at another/file.ts",
		]

		const result = categorizeValidationErrors(errors)

		expect(result.file).toEqual(errors)
		expect(result.circular).toEqual([])
		expect(result.duplicate).toEqual([])
	})

	it("should categorize circular dependency errors", () => {
		const errors = ["Circular dependency detected: comp-a -> comp-b -> comp-a"]

		const result = categorizeValidationErrors(errors)

		expect(result.file).toEqual([])
		expect(result.circular).toEqual(errors)
		expect(result.duplicate).toEqual([])
	})

	it("should categorize duplicate target errors", () => {
		const errors = ['Duplicate target "plugins/test.ts" in components "comp-a" and "comp-b"']

		const result = categorizeValidationErrors(errors)

		expect(result.file).toEqual([])
		expect(result.circular).toEqual([])
		expect(result.duplicate).toEqual(errors)
	})

	it("should categorize mixed errors", () => {
		const errors = [
			"comp-a: Source file not found at file.ts",
			"Circular dependency detected: comp-a -> comp-b -> comp-a",
			'Duplicate target "plugins/test.ts" in components "comp-a" and "comp-b"',
			"comp-c: Source file not found at another.ts",
		]

		const result = categorizeValidationErrors(errors)

		expect(result.file).toEqual([
			"comp-a: Source file not found at file.ts",
			"comp-c: Source file not found at another.ts",
		])
		expect(result.circular).toEqual(["Circular dependency detected: comp-a -> comp-b -> comp-a"])
		expect(result.duplicate).toEqual([
			'Duplicate target "plugins/test.ts" in components "comp-a" and "comp-b"',
		])
	})

	it("should return empty arrays for empty input", () => {
		const result = categorizeValidationErrors([])

		expect(result.file).toEqual([])
		expect(result.circular).toEqual([])
		expect(result.duplicate).toEqual([])
	})
})

describe("displayCategorizedErrors", () => {
	it("should display file errors with heading", () => {
		const categorized = {
			file: ["comp-a: Source file not found at file.ts"],
			circular: [],
			duplicate: [],
		}

		const output: string[] = []
		const mockLog = (msg: string) => output.push(msg)

		displayCategorizedErrors(categorized, mockLog)

		expect(output).toContain("✗ Source files")
		expect(output).toContain("  comp-a: Source file not found at file.ts")
	})

	it("should display circular dependency errors with heading", () => {
		const categorized = {
			file: [],
			circular: ["Circular dependency detected: comp-a -> comp-b -> comp-a"],
			duplicate: [],
		}

		const output: string[] = []
		const mockLog = (msg: string) => output.push(msg)

		displayCategorizedErrors(categorized, mockLog)

		expect(output).toContain("✗ Circular dependencies")
		expect(output).toContain("  Circular dependency detected: comp-a -> comp-b -> comp-a")
	})

	it("should display duplicate target errors with heading", () => {
		const categorized = {
			file: [],
			circular: [],
			duplicate: ['Duplicate target "plugins/test.ts" in components "comp-a" and "comp-b"'],
		}

		const output: string[] = []
		const mockLog = (msg: string) => output.push(msg)

		displayCategorizedErrors(categorized, mockLog)

		expect(output).toContain("✗ Duplicate targets")
		expect(output).toContain(
			'  Duplicate target "plugins/test.ts" in components "comp-a" and "comp-b"',
		)
	})

	it("should display multiple error categories", () => {
		const categorized = {
			file: ["comp-a: Source file not found at file.ts"],
			circular: ["Circular dependency detected: comp-a -> comp-b -> comp-a"],
			duplicate: ['Duplicate target "plugins/test.ts" in components "comp-a" and "comp-b"'],
		}

		const output: string[] = []
		const mockLog = (msg: string) => output.push(msg)

		displayCategorizedErrors(categorized, mockLog)

		expect(output).toContain("✗ Source files")
		expect(output).toContain("✗ Circular dependencies")
		expect(output).toContain("✗ Duplicate targets")
	})

	it("should not display categories with no errors", () => {
		const categorized = {
			file: ["comp-a: Source file not found at file.ts"],
			circular: [],
			duplicate: [],
		}

		const output: string[] = []
		const mockLog = (msg: string) => output.push(msg)

		displayCategorizedErrors(categorized, mockLog)

		expect(output).toContain("✗ Source files")
		expect(output).not.toContain("✗ Circular dependencies")
		expect(output).not.toContain("✗ Duplicate targets")
	})
})

describe("summarizeValidationErrors", () => {
	it("should summarize category counts for rule validation errors", () => {
		const errors = [
			"comp-a: Source file not found at file.ts",
			"Circular dependency detected: comp-a -> comp-b -> comp-a",
			'Duplicate target "plugins/test.ts" in components "comp-a" and "comp-b"',
		]

		const summary = summarizeValidationErrors(errors)

		expect(summary).toEqual({
			valid: false,
			totalErrors: 3,
			schemaErrors: 0,
			sourceFileErrors: 1,
			circularDependencyErrors: 1,
			duplicateTargetErrors: 1,
			otherErrors: 0,
		})
	})

	it("should support explicit schema error counts", () => {
		const errors = ["name: Required", "components.0.name: Must be lowercase"]

		const summary = summarizeValidationErrors(errors, { schemaErrors: errors.length })

		expect(summary).toEqual({
			valid: false,
			totalErrors: 2,
			schemaErrors: 2,
			sourceFileErrors: 0,
			circularDependencyErrors: 0,
			duplicateTargetErrors: 0,
			otherErrors: 0,
		})
	})

	it("should return zero counts for valid results", () => {
		const summary = summarizeValidationErrors([])

		expect(summary).toEqual({
			valid: true,
			totalErrors: 0,
			schemaErrors: 0,
			sourceFileErrors: 0,
			circularDependencyErrors: 0,
			duplicateTargetErrors: 0,
			otherErrors: 0,
		})
	})
})

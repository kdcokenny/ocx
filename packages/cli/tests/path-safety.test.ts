import { describe, expect, it } from "bun:test"
import { safeRelativePathSchema } from "../src/schemas/common"
import { ValidationError } from "../src/utils/errors"
import { assertPathInside, isPathInside } from "../src/utils/path-safety"

describe("isPathInside", () => {
	it("returns true for path inside parent", () => {
		expect(isPathInside("/project/src/file.ts", "/project")).toBe(true)
	})

	it("returns true for nested paths", () => {
		expect(isPathInside("/project/src/deep/nested/file.ts", "/project")).toBe(true)
	})

	it("returns false for path outside parent", () => {
		expect(isPathInside("/etc/passwd", "/project")).toBe(false)
	})

	it("returns false for traversal attempt", () => {
		expect(isPathInside("/project/../etc/passwd", "/project")).toBe(false)
	})

	it("returns false for sibling directory", () => {
		expect(isPathInside("/other-project/file.ts", "/project")).toBe(false)
	})

	it("returns true for same path (root-level installation)", () => {
		// Same path is considered "inside" - allows root-level component installation
		// where componentPath="" or "." resolves to the project directory itself
		expect(isPathInside("/project", "/project")).toBe(true)
	})

	it("handles relative paths correctly", () => {
		// Both relative paths should work
		expect(isPathInside("./src/file.ts", ".")).toBe(true)
		expect(isPathInside("../other/file.ts", ".")).toBe(false)
	})
})

describe("assertPathInside", () => {
	it("does not throw for valid paths", () => {
		expect(() => assertPathInside("/project/src/file.ts", "/project")).not.toThrow()
	})

	it("throws ValidationError for path outside parent", () => {
		expect(() => assertPathInside("/etc/passwd", "/project")).toThrow(ValidationError)
	})

	it("throws ValidationError for traversal attempt", () => {
		expect(() => assertPathInside("/project/../etc/passwd", "/project")).toThrow(ValidationError)
	})

	it("includes both paths in error message", () => {
		try {
			assertPathInside("/etc/passwd", "/project")
		} catch (error) {
			expect(error).toBeInstanceOf(ValidationError)
			expect((error as ValidationError).message).toContain("/etc/passwd")
			expect((error as ValidationError).message).toContain("/project")
		}
	})
})

describe("safeRelativePathSchema", () => {
	it("accepts valid relative paths", () => {
		expect(() => safeRelativePathSchema.parse("src/components")).not.toThrow()
		expect(() => safeRelativePathSchema.parse("lib/ui")).not.toThrow()
		expect(() => safeRelativePathSchema.parse("file.ts")).not.toThrow()
		expect(() => safeRelativePathSchema.parse(".opencode/agents")).not.toThrow()
	})

	it("accepts paths with dots in filenames", () => {
		expect(() => safeRelativePathSchema.parse("src/file.config.ts")).not.toThrow()
		expect(() => safeRelativePathSchema.parse(".hidden/file")).not.toThrow()
	})

	it("rejects path traversal with ..", () => {
		expect(() => safeRelativePathSchema.parse("../etc")).toThrow()
		expect(() => safeRelativePathSchema.parse("src/../../etc")).toThrow()
		expect(() => safeRelativePathSchema.parse("..")).toThrow()
	})

	it("rejects traversal in middle of path", () => {
		expect(() => safeRelativePathSchema.parse("src/../../../etc/passwd")).toThrow()
	})

	it("rejects absolute paths", () => {
		expect(() => safeRelativePathSchema.parse("/etc/passwd")).toThrow()
		expect(() => safeRelativePathSchema.parse("/usr/local/bin")).toThrow()
	})

	it("rejects null bytes", () => {
		expect(() => safeRelativePathSchema.parse("src\0/file")).toThrow()
		expect(() => safeRelativePathSchema.parse("file\0.ts")).toThrow()
	})

	it("rejects Windows-style traversal", () => {
		expect(() => safeRelativePathSchema.parse("..\\etc")).toThrow()
		expect(() => safeRelativePathSchema.parse("src\\..\\..\\etc")).toThrow()
	})

	it("rejects Windows UNC paths on any platform", () => {
		expect(() => safeRelativePathSchema.parse("\\\\server\\share")).toThrow()
		expect(() => safeRelativePathSchema.parse("\\\\server\\share\\file.txt")).toThrow()
	})

	it("rejects Windows drive paths on any platform", () => {
		expect(() => safeRelativePathSchema.parse("C:\\folder")).toThrow()
		expect(() => safeRelativePathSchema.parse("D:\\Users\\file.txt")).toThrow()
		expect(() => safeRelativePathSchema.parse("c:\\folder")).toThrow()
	})
})

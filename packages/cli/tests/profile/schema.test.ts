/**
 * Profile Schema Unit Tests
 *
 * Tests for profile name validation:
 * - Valid names pass validation
 * - Various invalid names fail with appropriate errors
 * - Path traversal attacks are rejected
 */

import { describe, expect, it } from "bun:test"
import { profileNameSchema } from "../../src/profile/schema"

// =============================================================================
// VALID PROFILE NAMES
// =============================================================================

describe("profileNameSchema - valid names", () => {
	it("should accept simple lowercase name", () => {
		const result = profileNameSchema.safeParse("default")
		expect(result.success).toBe(true)
	})

	it("should accept simple uppercase name", () => {
		const result = profileNameSchema.safeParse("Default")
		expect(result.success).toBe(true)
	})

	it("should accept name with numbers", () => {
		const result = profileNameSchema.safeParse("profile1")
		expect(result.success).toBe(true)
	})

	it("should accept name with dots", () => {
		const result = profileNameSchema.safeParse("my.profile")
		expect(result.success).toBe(true)
	})

	it("should accept name with underscores", () => {
		const result = profileNameSchema.safeParse("my_profile")
		expect(result.success).toBe(true)
	})

	it("should accept name with hyphens", () => {
		const result = profileNameSchema.safeParse("my-profile")
		expect(result.success).toBe(true)
	})

	it("should accept mixed valid characters", () => {
		const result = profileNameSchema.safeParse("My.Profile_Name-v2")
		expect(result.success).toBe(true)
	})

	it("should accept single character name", () => {
		const result = profileNameSchema.safeParse("a")
		expect(result.success).toBe(true)
	})

	it("should accept 32 character name (max length)", () => {
		const name = "a".repeat(32)
		const result = profileNameSchema.safeParse(name)
		expect(result.success).toBe(true)
	})
})

// =============================================================================
// INVALID PROFILE NAMES - EMPTY
// =============================================================================

describe("profileNameSchema - empty names", () => {
	it("should reject empty string", () => {
		const result = profileNameSchema.safeParse("")
		expect(result.success).toBe(false)
		expect(result.error?.errors[0]?.message).toContain("required")
	})
})

// =============================================================================
// INVALID PROFILE NAMES - LENGTH
// =============================================================================

describe("profileNameSchema - length validation", () => {
	it("should reject names over 32 characters", () => {
		const name = "a".repeat(33)
		const result = profileNameSchema.safeParse(name)
		expect(result.success).toBe(false)
		expect(result.error?.errors[0]?.message).toContain("32 characters")
	})

	it("should reject very long names", () => {
		const name = "a".repeat(100)
		const result = profileNameSchema.safeParse(name)
		expect(result.success).toBe(false)
	})
})

// =============================================================================
// INVALID PROFILE NAMES - FIRST CHARACTER
// =============================================================================

describe("profileNameSchema - first character validation", () => {
	it("should reject name starting with number", () => {
		const result = profileNameSchema.safeParse("123profile")
		expect(result.success).toBe(false)
		expect(result.error?.errors[0]?.message).toContain("start with a letter")
	})

	it("should reject name starting with hyphen", () => {
		const result = profileNameSchema.safeParse("-profile")
		expect(result.success).toBe(false)
	})

	it("should reject name starting with underscore", () => {
		const result = profileNameSchema.safeParse("_profile")
		expect(result.success).toBe(false)
	})

	it("should reject name starting with dot", () => {
		const result = profileNameSchema.safeParse(".profile")
		expect(result.success).toBe(false)
	})
})

// =============================================================================
// INVALID PROFILE NAMES - INVALID CHARACTERS
// =============================================================================

describe("profileNameSchema - invalid characters", () => {
	it("should reject name with space", () => {
		const result = profileNameSchema.safeParse("my profile")
		expect(result.success).toBe(false)
	})

	it("should reject name with slash", () => {
		const result = profileNameSchema.safeParse("my/profile")
		expect(result.success).toBe(false)
	})

	it("should reject name with backslash", () => {
		const result = profileNameSchema.safeParse("my\\profile")
		expect(result.success).toBe(false)
	})

	it("should reject name with colon", () => {
		const result = profileNameSchema.safeParse("my:profile")
		expect(result.success).toBe(false)
	})

	it("should reject name with asterisk", () => {
		const result = profileNameSchema.safeParse("my*profile")
		expect(result.success).toBe(false)
	})

	it("should reject name with question mark", () => {
		const result = profileNameSchema.safeParse("my?profile")
		expect(result.success).toBe(false)
	})

	it("should reject name with quotes", () => {
		const result = profileNameSchema.safeParse('my"profile')
		expect(result.success).toBe(false)
	})

	it("should reject name with angle brackets", () => {
		const result = profileNameSchema.safeParse("my<profile>")
		expect(result.success).toBe(false)
	})

	it("should reject name with pipe", () => {
		const result = profileNameSchema.safeParse("my|profile")
		expect(result.success).toBe(false)
	})

	it("should reject name with at sign", () => {
		const result = profileNameSchema.safeParse("my@profile")
		expect(result.success).toBe(false)
	})

	it("should reject name with hash", () => {
		const result = profileNameSchema.safeParse("my#profile")
		expect(result.success).toBe(false)
	})

	it("should reject name with parentheses", () => {
		const result = profileNameSchema.safeParse("my(profile)")
		expect(result.success).toBe(false)
	})
})

// =============================================================================
// PATH TRAVERSAL ATTACKS
// =============================================================================

describe("profileNameSchema - path traversal rejection", () => {
	it("should reject ../ pattern", () => {
		const result = profileNameSchema.safeParse("../../../etc/passwd")
		expect(result.success).toBe(false)
	})

	it("should reject simple ..", () => {
		const result = profileNameSchema.safeParse("..")
		expect(result.success).toBe(false)
	})

	it("should reject ../ at start", () => {
		const result = profileNameSchema.safeParse("../parent")
		expect(result.success).toBe(false)
	})

	it("should reject path with ..", () => {
		// This fails because / is not allowed, but also .. starts with .
		const result = profileNameSchema.safeParse("foo/../bar")
		expect(result.success).toBe(false)
	})

	it("should reject /etc/passwd style paths", () => {
		const result = profileNameSchema.safeParse("/etc/passwd")
		expect(result.success).toBe(false)
	})

	it("should reject Windows-style path traversal", () => {
		const result = profileNameSchema.safeParse("..\\..\\windows")
		expect(result.success).toBe(false)
	})

	it("should reject URL-encoded path traversal", () => {
		// %2e = . and %2f = /
		const result = profileNameSchema.safeParse("%2e%2e%2f")
		expect(result.success).toBe(false)
	})
})

// =============================================================================
// EDGE CASES
// =============================================================================

describe("profileNameSchema - edge cases", () => {
	it("should reject null", () => {
		const result = profileNameSchema.safeParse(null)
		expect(result.success).toBe(false)
	})

	it("should reject undefined", () => {
		const result = profileNameSchema.safeParse(undefined)
		expect(result.success).toBe(false)
	})

	it("should reject number", () => {
		const result = profileNameSchema.safeParse(123)
		expect(result.success).toBe(false)
	})

	it("should reject object", () => {
		const result = profileNameSchema.safeParse({ name: "test" })
		expect(result.success).toBe(false)
	})

	it("should reject array", () => {
		const result = profileNameSchema.safeParse(["test"])
		expect(result.success).toBe(false)
	})
})

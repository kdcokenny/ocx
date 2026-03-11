import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { expandEnvVars } from "../src/utils/env-expand"

describe("expandEnvVars", () => {
	const originalEnv = process.env

	beforeEach(() => {
		process.env = { ...originalEnv }
	})

	afterEach(() => {
		process.env = originalEnv
	})

	describe("basic expansion", () => {
		it("expands single ${VAR} pattern", () => {
			process.env.GITHUB_TOKEN = "abc123"
			const result = expandEnvVars("Bearer ${GITHUB_TOKEN}")
			expect(result).toBe("Bearer abc123")
		})

		it("expands multiple ${VAR} patterns", () => {
			process.env.USER = "alice"
			process.env.PASS = "secret"
			const result = expandEnvVars("${USER}:${PASS}")
			expect(result).toBe("alice:secret")
		})

		it("expands ${VAR} at start of string", () => {
			process.env.PREFIX = "hello"
			const result = expandEnvVars("${PREFIX} world")
			expect(result).toBe("hello world")
		})

		it("expands ${VAR} at end of string", () => {
			process.env.SUFFIX = "world"
			const result = expandEnvVars("hello ${SUFFIX}")
			expect(result).toBe("hello world")
		})

		it("expands ${VAR} as entire string", () => {
			process.env.VALUE = "complete"
			const result = expandEnvVars("${VALUE}")
			expect(result).toBe("complete")
		})
	})

	describe("passthrough (no expansion)", () => {
		it("returns string unchanged when no ${VAR} patterns", () => {
			const result = expandEnvVars("no vars here")
			expect(result).toBe("no vars here")
		})

		it("returns empty string unchanged", () => {
			const result = expandEnvVars("")
			expect(result).toBe("")
		})

		it("returns string with $ but no braces unchanged", () => {
			const result = expandEnvVars("price is $100")
			expect(result).toBe("price is $100")
		})

		it("returns string with ${ but no closing brace unchanged", () => {
			const result = expandEnvVars("incomplete ${VAR")
			expect(result).toBe("incomplete ${VAR")
		})
	})

	describe("escaped sequences", () => {
		it("converts \\${VAR} to literal ${VAR} (not expanded)", () => {
			process.env.VAR = "value"
			const result = expandEnvVars("\\${VAR}")
			expect(result).toBe("${VAR}")
		})

		it("escapes ${VAR} in middle of string", () => {
			process.env.VAR = "value"
			const result = expandEnvVars("prefix \\${VAR} suffix")
			expect(result).toBe("prefix ${VAR} suffix")
		})

		it("handles multiple escaped sequences", () => {
			process.env.A = "a_value"
			process.env.B = "b_value"
			const result = expandEnvVars("\\${A} and \\${B}")
			expect(result).toBe("${A} and ${B}")
		})

		it("mixes escaped and unescaped patterns", () => {
			process.env.EXPAND = "expanded"
			process.env.ESCAPE = "escaped"
			const result = expandEnvVars("${EXPAND} and \\${ESCAPE}")
			expect(result).toBe("expanded and ${ESCAPE}")
		})
	})

	describe("error handling", () => {
		it("throws error for missing env var", () => {
			delete process.env.MISSING_VAR
			expect(() => expandEnvVars("${MISSING_VAR}")).toThrow(
				"Environment variable MISSING_VAR is not set",
			)
		})

		it("throws error naming the specific missing variable", () => {
			delete process.env.GITHUB_TOKEN
			expect(() => expandEnvVars("Bearer ${GITHUB_TOKEN}")).toThrow(
				"Environment variable GITHUB_TOKEN is not set",
			)
		})

		it("throws error for first missing var in multiple patterns", () => {
			process.env.FIRST = "value"
			delete process.env.SECOND
			expect(() => expandEnvVars("${FIRST} ${SECOND}")).toThrow(
				"Environment variable SECOND is not set",
			)
		})

		it("throws error even if escaped var is missing (escaped vars don't need to exist)", () => {
			delete process.env.MISSING
			const result = expandEnvVars("\\${MISSING}")
			expect(result).toBe("${MISSING}")
		})
	})

	describe("variable name validation", () => {
		it("expands var names starting with underscore", () => {
			process.env._PRIVATE = "private_value"
			const result = expandEnvVars("${_PRIVATE}")
			expect(result).toBe("private_value")
		})

		it("expands var names with numbers", () => {
			process.env.VAR123 = "numeric"
			const result = expandEnvVars("${VAR123}")
			expect(result).toBe("numeric")
		})

		it("expands var names with underscores in middle", () => {
			process.env.MY_VAR_NAME = "complex"
			const result = expandEnvVars("${MY_VAR_NAME}")
			expect(result).toBe("complex")
		})

		it("does not expand invalid var names (starting with number)", () => {
			const result = expandEnvVars("${123VAR}")
			expect(result).toBe("${123VAR}")
		})

		it("does not expand invalid var names (with hyphens)", () => {
			const result = expandEnvVars("${MY-VAR}")
			expect(result).toBe("${MY-VAR}")
		})

		it("does not expand invalid var names (with dots)", () => {
			const result = expandEnvVars("${MY.VAR}")
			expect(result).toBe("${MY.VAR}")
		})
	})

	describe("edge cases", () => {
		it("handles empty env var value", () => {
			process.env.EMPTY = ""
			const result = expandEnvVars("prefix${EMPTY}suffix")
			expect(result).toBe("prefixsuffix")
		})

		it("handles env var with special characters", () => {
			process.env.SPECIAL = "!@#$%^&*()"
			const result = expandEnvVars("value: ${SPECIAL}")
			expect(result).toBe("value: !@#$%^&*()")
		})

		it("handles env var with newlines", () => {
			process.env.MULTILINE = "line1\nline2"
			const result = expandEnvVars("${MULTILINE}")
			expect(result).toBe("line1\nline2")
		})

		it("handles consecutive ${VAR} patterns", () => {
			process.env.A = "a"
			process.env.B = "b"
			const result = expandEnvVars("${A}${B}")
			expect(result).toBe("ab")
		})

		it("handles whitespace in string", () => {
			process.env.VAR = "value"
			const result = expandEnvVars("  ${VAR}  ")
			expect(result).toBe("  value  ")
		})

		it("handles very long env var value", () => {
			const longValue = "x".repeat(10000)
			process.env.LONG = longValue
			const result = expandEnvVars("${LONG}")
			expect(result).toBe(longValue)
		})

		it("handles many ${VAR} patterns", () => {
			process.env.V = "v"
			const result = expandEnvVars("${V}${V}${V}${V}${V}")
			expect(result).toBe("vvvvv")
		})
	})

	describe("real-world scenarios", () => {
		it("expands auth header with token", () => {
			process.env.GITHUB_TOKEN = "ghp_abc123xyz"
			const result = expandEnvVars("Authorization: Bearer ${GITHUB_TOKEN}")
			expect(result).toBe("Authorization: Bearer ghp_abc123xyz")
		})

		it("expands registry URL with credentials", () => {
			process.env.REGISTRY_USER = "user"
			process.env.REGISTRY_PASS = "pass"
			const result = expandEnvVars("https://${REGISTRY_USER}:${REGISTRY_PASS}@registry.example.com")
			expect(result).toBe("https://user:pass@registry.example.com")
		})

		it("expands config with mixed content", () => {
			process.env.API_KEY = "secret123"
			process.env.API_URL = "https://api.example.com"
			const result = expandEnvVars(
				'{"url":"${API_URL}","key":"${API_KEY}","literal":"\\${ESCAPED}"}',
			)
			expect(result).toBe(
				'{"url":"https://api.example.com","key":"secret123","literal":"${ESCAPED}"}',
			)
		})
	})
})

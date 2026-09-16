/**
 * Tests for the resolver module
 * Tests cycle detection, cross-registry resolution, topological sort, and error handling
 */

import { describe, expect, it } from "bun:test"
import { parseComponentRef } from "../src/registry/resolver"

describe("resolver", () => {
	describe("parseComponentRef", () => {
		it("should parse qualified component reference with namespace", () => {
			const result = parseComponentRef("kdco/researcher")
			expect(result).toEqual({ namespace: "kdco", component: "researcher" })
		})

		it("should parse qualified reference with hyphenated names", () => {
			const result = parseComponentRef("my-namespace/my-component")
			expect(result).toEqual({ namespace: "my-namespace", component: "my-component" })
		})

		it("should use default alias for bare component name", () => {
			const result = parseComponentRef("researcher", "kdco")
			expect(result).toEqual({ namespace: "kdco", component: "researcher" })
		})

		it("should throw ValidationError for bare name without default alias", () => {
			expect(() => parseComponentRef("researcher")).toThrow(
				"Component 'researcher' must include a registry alias",
			)
		})

		it("should prefer explicit alias over default", () => {
			const result = parseComponentRef("other/utils", "kdco")
			expect(result).toEqual({ namespace: "other", component: "utils" })
		})

		it("should reject multiple slashes in component ref", () => {
			// parseQualifiedComponent now rejects refs with more than one "/"
			expect(() => parseComponentRef("ns/comp/extra")).toThrow("Invalid component reference")
		})
	})
})

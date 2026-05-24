import { describe, expect, it } from "bun:test"
import { compareSemver, isValidSemver, parseVersion } from "../../src/utils/semver"

describe("semver utilities", () => {
	it("accepts release, prerelease, and build metadata versions", () => {
		expect(isValidSemver("1.2.3")).toBe(true)
		expect(isValidSemver("1.2.3-beta.1")).toBe(true)
		expect(isValidSemver("1.2.3+build.7")).toBe(true)
		expect(isValidSemver("1.2.3-beta.1+build.7")).toBe(true)
	})

	it("rejects versions with path traversal content", () => {
		const malicious = "2.0.0/../../../../../evil/repo/releases/download/v1.0.0"

		expect(isValidSemver(malicious)).toBe(false)
		expect(parseVersion(malicious)).toBeNull()
		expect(compareSemver(malicious, "1.0.0")).toBeNull()
	})

	it("rejects partial numeric parsing and malformed versions", () => {
		expect(parseVersion("1.2.3abc")).toBeNull()
		expect(parseVersion("1.2")).toBeNull()
		expect(parseVersion("01.2.3")).toBeNull()
		expect(parseVersion("v1.2.3")).toBeNull()
		expect(parseVersion(" 1.2.3")).toBeNull()
	})

	it("compares core version components after strict validation", () => {
		expect(compareSemver("1.2.4", "1.2.3")).toBe(1)
		expect(compareSemver("1.2.3-beta.1", "1.2.3")).toBe(0)
		expect(compareSemver("1.2.3+build.7", "1.2.3")).toBe(0)
	})
})

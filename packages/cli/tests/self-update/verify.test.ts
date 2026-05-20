/**
 * Tests for SHA256 verification utilities.
 *
 * Ported from memospot/Prisma OSS test patterns.
 */
import { describe, expect, it } from "bun:test"
import { parseSha256Sums } from "../../src/self-update/verify"
import { hashContent } from "../../src/utils/receipt"

// Valid 64-character SHA256 hashes for testing
const HASH_A = "abc123def456789012345678901234567890123456789012345678901234abcd"
const HASH_B = "def456789012345678901234567890123456789012345678901234567890abcd"
const HASH_UPPER = "ABC123DEF456789012345678901234567890123456789012345678901234ABCD"

describe("parseSha256Sums", () => {
	it("parses GNU format (two spaces)", () => {
		const content = `${HASH_A}  ocx-darwin-arm64\n`
		const map = parseSha256Sums(content)
		expect(map.get("ocx-darwin-arm64")).toBe(HASH_A)
	})

	it("parses BSD format (asterisk prefix)", () => {
		const content = `${HASH_A} *ocx-linux-x64\n`
		const map = parseSha256Sums(content)
		expect(map.get("ocx-linux-x64")).toBe(HASH_A)
	})

	it("handles multiple entries", () => {
		const content = `${HASH_A}  file1\n${HASH_B}  file2\n`
		const map = parseSha256Sums(content)
		expect(map.size).toBe(2)
		expect(map.get("file1")).toBe(HASH_A)
		expect(map.get("file2")).toBe(HASH_B)
	})

	it("ignores invalid lines", () => {
		const content = "not a valid checksum line\nabc123  too-short-hash\n"
		const map = parseSha256Sums(content)
		expect(map.size).toBe(0)
	})

	it("normalizes hash to lowercase", () => {
		const content = `${HASH_UPPER}  file.txt\n`
		const map = parseSha256Sums(content)
		expect(map.get("file.txt")).toBe(HASH_UPPER.toLowerCase())
	})
})

describe("hashContent", () => {
	it("hashes string content", () => {
		const hash = hashContent("hello world")
		expect(hash).toMatch(/^[a-f0-9]{64}$/)
	})

	it("produces consistent hashes", () => {
		const hash1 = hashContent("test data")
		const hash2 = hashContent("test data")
		expect(hash1).toBe(hash2)
	})

	it("produces different hashes for different content", () => {
		const hash1 = hashContent("content A")
		const hash2 = hashContent("content B")
		expect(hash1).not.toBe(hash2)
	})
})

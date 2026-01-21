import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findOcxConfig, findOcxLock } from "../src/schemas/config"
import { findOpencodeConfig } from "../src/updaters/update-opencode-config"

describe("config path discovery", () => {
	let testDir: string

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "config-paths-"))
	})

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true })
	})

	describe("findOcxConfig", () => {
		it("returns .opencode path when .opencode/ocx.jsonc exists", async () => {
			await mkdir(join(testDir, ".opencode"), { recursive: true })
			await writeFile(join(testDir, ".opencode", "ocx.jsonc"), "{}")

			const result = findOcxConfig(testDir)

			expect(result.exists).toBe(true)
			expect(result.path).toBe(join(testDir, ".opencode", "ocx.jsonc"))
		})

		it("returns root path when only root ocx.jsonc exists", async () => {
			await writeFile(join(testDir, "ocx.jsonc"), "{}")

			const result = findOcxConfig(testDir)

			expect(result.exists).toBe(true)
			expect(result.path).toBe(join(testDir, "ocx.jsonc"))
		})

		it("returns .opencode default when neither exists", () => {
			const result = findOcxConfig(testDir)

			expect(result.exists).toBe(false)
			expect(result.path).toBe(join(testDir, ".opencode", "ocx.jsonc"))
		})

		it("throws error when both locations have ocx.jsonc", async () => {
			await mkdir(join(testDir, ".opencode"), { recursive: true })
			await writeFile(join(testDir, ".opencode", "ocx.jsonc"), "{}")
			await writeFile(join(testDir, "ocx.jsonc"), "{}")

			expect(() => findOcxConfig(testDir)).toThrow(/both/)
		})
	})

	describe("findOcxLock", () => {
		it("returns .opencode path when .opencode/ocx.lock exists", async () => {
			await mkdir(join(testDir, ".opencode"), { recursive: true })
			await writeFile(join(testDir, ".opencode", "ocx.lock"), "{}")

			const result = findOcxLock(testDir)

			expect(result.exists).toBe(true)
			expect(result.path).toBe(join(testDir, ".opencode", "ocx.lock"))
		})

		it("returns root path when only root ocx.lock exists", async () => {
			await writeFile(join(testDir, "ocx.lock"), "{}")

			const result = findOcxLock(testDir)

			expect(result.exists).toBe(true)
			expect(result.path).toBe(join(testDir, "ocx.lock"))
		})

		it("returns .opencode default when neither exists", () => {
			const result = findOcxLock(testDir)

			expect(result.exists).toBe(false)
			expect(result.path).toBe(join(testDir, ".opencode", "ocx.lock"))
		})
	})

	describe("findOpencodeConfig", () => {
		it("returns .opencode/opencode.jsonc when it exists", async () => {
			await mkdir(join(testDir, ".opencode"), { recursive: true })
			await writeFile(join(testDir, ".opencode", "opencode.jsonc"), "{}")

			const result = findOpencodeConfig(testDir)

			expect(result.exists).toBe(true)
			expect(result.path).toBe(join(testDir, ".opencode", "opencode.jsonc"))
		})

		it("returns .opencode/opencode.json when .jsonc doesn't exist but .json does", async () => {
			await mkdir(join(testDir, ".opencode"), { recursive: true })
			await writeFile(join(testDir, ".opencode", "opencode.json"), "{}")

			const result = findOpencodeConfig(testDir)

			expect(result.exists).toBe(true)
			expect(result.path).toBe(join(testDir, ".opencode", "opencode.json"))
		})

		it("returns root opencode.jsonc when only root .jsonc exists", async () => {
			await writeFile(join(testDir, "opencode.jsonc"), "{}")

			const result = findOpencodeConfig(testDir)

			expect(result.exists).toBe(true)
			expect(result.path).toBe(join(testDir, "opencode.jsonc"))
		})

		it("returns root opencode.json when only root .json exists", async () => {
			await writeFile(join(testDir, "opencode.json"), "{}")

			const result = findOpencodeConfig(testDir)

			expect(result.exists).toBe(true)
			expect(result.path).toBe(join(testDir, "opencode.json"))
		})

		it("returns .opencode/opencode.jsonc default when neither exists", () => {
			const result = findOpencodeConfig(testDir)

			expect(result.exists).toBe(false)
			expect(result.path).toBe(join(testDir, ".opencode", "opencode.jsonc"))
		})
	})
})

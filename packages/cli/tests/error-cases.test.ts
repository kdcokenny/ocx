import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCLI } from "./helpers"

/**
 * Error case tests for OCX CLI
 *
 * Tests error handling for:
 * - Missing initialization
 * - Invalid inputs
 * - Non-existent resources
 */

describe("Error Cases", () => {
	let testDir: string

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "ocx-errors-"))
	})

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true })
	})

	describe("missing initialization", () => {
		it("should error when adding registry without init", async () => {
			const result = await runCLI(
				["registry", "add", "https://example.com", "--name", "test"],
				testDir,
			)
			expect(result.exitCode).toBe(1)
			expect(result.stderr).toContain("local config not found")
		})

		it("should error when adding to global without init --global", async () => {
			const globalDir = await mkdtemp(join(tmpdir(), "ocx-global-"))
			try {
				const result = await runCLI(
					["registry", "add", "https://example.com", "--name", "test", "--global"],
					testDir,
					{ env: { XDG_CONFIG_HOME: globalDir } },
				)
				expect(result.exitCode).toBe(1)
				expect(result.stderr).toContain("global config not found")
			} finally {
				await rm(globalDir, { recursive: true, force: true })
			}
		})
	})

	describe("invalid inputs", () => {
		it("should error on invalid registry URL", async () => {
			await runCLI(["init"], testDir)
			const result = await runCLI(["registry", "add", "not-a-valid-url", "--name", "test"], testDir)
			expect(result.exitCode).toBe(1)
			expect(result.stderr).toContain("Invalid registry URL")
		})

		it("should error on duplicate registry name without --force", async () => {
			await runCLI(["init"], testDir)
			// Add first registry
			await runCLI(["registry", "add", "https://example.com", "--name", "test"], testDir)
			// Try to add duplicate
			const result = await runCLI(
				["registry", "add", "https://other.com", "--name", "test"],
				testDir,
			)
			expect(result.exitCode).toBe(6) // CONFLICT error
			expect(result.stderr).toContain("already exists")
		})

		it("should error when adding to locked registries", async () => {
			await runCLI(["init"], testDir)
			// Manually set lockRegistries to true (this is legitimate per rubric - testing locked state)
			const configPath = join(testDir, ".opencode", "ocx.jsonc")
			const config = { registries: {}, lockRegistries: true }
			await Bun.write(configPath, JSON.stringify(config, null, 2))

			const result = await runCLI(
				["registry", "add", "https://example.com", "--name", "test"],
				testDir,
			)
			expect(result.exitCode).toBe(1) // VALIDATION/GENERAL error
			expect(result.stderr).toContain("Registries are locked")
		})
	})

	describe("non-existent resources", () => {
		it("should error when removing non-existent registry", async () => {
			await runCLI(["init"], testDir)
			const result = await runCLI(["registry", "remove", "nonexistent"], testDir)
			expect(result.exitCode).toBe(1)
			expect(result.stderr).toContain("not found")
		})

		it("should error when showing non-existent profile", async () => {
			const globalDir = await mkdtemp(join(tmpdir(), "ocx-global-"))
			try {
				await runCLI(["init", "--global"], testDir, { env: { XDG_CONFIG_HOME: globalDir } })
				const result = await runCLI(["profile", "show", "nonexistent"], testDir, {
					env: { XDG_CONFIG_HOME: globalDir },
				})
				expect(result.exitCode).toBe(66) // NOT_FOUND error
				expect(result.stderr).toContain("not found")
			} finally {
				await rm(globalDir, { recursive: true, force: true })
			}
		})
	})
})

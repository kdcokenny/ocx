/**
 * Config Edit Command Tests
 *
 * Tests for `ocx config edit` command including the new --profile flag.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir, runCLI } from "./helpers"

describe("ocx config edit", () => {
	let testDir: string
	let globalTestDir: string

	beforeEach(async () => {
		testDir = await createTempDir("config-edit-test")
		globalTestDir = await createTempDir("config-edit-global")
	})

	afterEach(async () => {
		await cleanupTempDir(testDir)
		await cleanupTempDir(globalTestDir)
	})

	describe("--profile flag", () => {
		it("should open correct profile config path", async () => {
			// Create profile with config
			const profileDir = join(globalTestDir, "ocx", "profiles", "test-profile")
			await mkdir(profileDir, { recursive: true })
			await Bun.write(join(profileDir, "ocx.jsonc"), "{}")

			const result = await runCLI(["config", "edit", "--profile", "test-profile"], testDir, {
				env: {
					XDG_CONFIG_HOME: globalTestDir,
					VISUAL: "",
					EDITOR: "echo",
				},
			})

			expect(result.stdout).toContain(join(profileDir, "ocx.jsonc"))
		})

		it("should error when profiles are not initialized", async () => {
			const result = await runCLI(["config", "edit", "--profile", "nonexistent"], testDir, {
				env: { XDG_CONFIG_HOME: globalTestDir },
			})

			expect(result.exitCode).not.toBe(0)
			expect(result.output).toContain("not found")
		})

		it("should error when profile does not exist", async () => {
			// Initialize profiles first
			const profilesDir = join(globalTestDir, "ocx", "profiles")
			await mkdir(profilesDir, { recursive: true })

			const result = await runCLI(["config", "edit", "--profile", "nonexistent"], testDir, {
				env: { XDG_CONFIG_HOME: globalTestDir },
			})

			expect(result.exitCode).not.toBe(0)
			expect(result.output).toContain("not found")
		})

		it("should error for invalid profile name (path traversal)", async () => {
			// Initialize profiles first
			const profilesDir = join(globalTestDir, "ocx", "profiles")
			await mkdir(profilesDir, { recursive: true })

			const result = await runCLI(["config", "edit", "--profile", ".."], testDir, {
				env: { XDG_CONFIG_HOME: globalTestDir },
			})

			expect(result.exitCode).not.toBe(0)
			expect(result.output).toContain("Profile name")
		})

		it("should error when using both --global and --profile", async () => {
			const result = await runCLI(["config", "edit", "--global", "--profile", "test"], testDir, {
				env: { XDG_CONFIG_HOME: globalTestDir },
			})

			expect(result.exitCode).not.toBe(0)
			expect(result.output).toContain("Choose one scope")
		})

		it("should require profile name argument", async () => {
			// Commander.js should fail when --profile is used without a name
			const result = await runCLI(["config", "edit", "--profile"], testDir, {
				env: { XDG_CONFIG_HOME: globalTestDir },
			})

			expect(result.exitCode).not.toBe(0)
			// Commander.js error message
			expect(result.output).toContain("argument missing")
		})
	})

	describe("existing functionality", () => {
		it("should edit explicitly selected project config", async () => {
			const localConfigDir = join(testDir, ".opencode")
			await mkdir(localConfigDir, { recursive: true })
			await Bun.write(join(localConfigDir, "ocx.jsonc"), "{}")

			const result = await runCLI(["config", "edit", "--project"], testDir, {
				env: { VISUAL: "", EDITOR: "echo" },
			})

			expect(result.stdout).toContain(join(localConfigDir, "ocx.jsonc"))
		})

		it("should edit global config with --global flag", async () => {
			const globalConfigDir = join(globalTestDir, "ocx")
			await mkdir(globalConfigDir, { recursive: true })
			await Bun.write(join(globalConfigDir, "ocx.jsonc"), "{}")

			const result = await runCLI(["config", "edit", "--global"], testDir, {
				env: {
					XDG_CONFIG_HOME: globalTestDir,
					VISUAL: "",
					EDITOR: "echo",
				},
			})

			expect(result.stdout).toContain(join(globalConfigDir, "ocx.jsonc"))
		})
	})
})

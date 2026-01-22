import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import { findOcxConfig, findOcxLock } from "../src/schemas/config"
import {
	findOpencodeConfig,
	updateOpencodeJsonConfig,
} from "../src/updaters/update-opencode-config"

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

	describe("updateOpencodeJsonConfig local projects", () => {
		let localDir: string

		beforeEach(async () => {
			localDir = await mkdtemp(join(tmpdir(), "local-project-"))
		})

		afterEach(async () => {
			await rm(localDir, { recursive: true, force: true })
		})

		it("updates existing config in .opencode/", async () => {
			// Setup: create existing config in .opencode/
			await mkdir(join(localDir, ".opencode"), { recursive: true })
			await Bun.write(
				join(localDir, ".opencode", "opencode.jsonc"),
				'{"$schema": "https://opencode.ai/config.json", "existing": true}',
			)

			const mcpServer = { type: "local" as const, enabled: true, command: "new-server" }
			const result = await updateOpencodeJsonConfig(localDir, { mcp: { added: mcpServer } })

			// Updates existing file
			expect(result.created).toBe(false)
			expect(result.changed).toBe(true)
			expect(result.path).toBe(join(localDir, ".opencode", "opencode.jsonc"))

			// Content was merged
			const content = await Bun.file(join(localDir, ".opencode", "opencode.jsonc")).text()
			const config = parseJsonc(content)
			expect(config.existing).toBe(true) // Original preserved
			expect(config.mcp?.added).toEqual(mcpServer) // New content added

			// No duplicate created at root
			expect(existsSync(join(localDir, "opencode.jsonc"))).toBe(false)
		})

		it("updates existing config at root (legacy location)", async () => {
			// Setup: create existing config at root (legacy location)
			await Bun.write(
				join(localDir, "opencode.jsonc"),
				'{"$schema": "https://opencode.ai/config.json", "legacy": true}',
			)

			const mcpServer = { type: "local" as const, enabled: true, command: "update-server" }
			const result = await updateOpencodeJsonConfig(localDir, { mcp: { updated: mcpServer } })

			// Updates the root file (respects legacy location)
			expect(result.created).toBe(false)
			expect(result.changed).toBe(true)
			expect(result.path).toBe(join(localDir, "opencode.jsonc"))

			// Content was merged
			const content = await Bun.file(join(localDir, "opencode.jsonc")).text()
			const config = parseJsonc(content)
			expect(config.legacy).toBe(true) // Original preserved
			expect(config.mcp?.updated).toEqual(mcpServer) // New content added

			// No .opencode/ directory created
			expect(existsSync(join(localDir, ".opencode"))).toBe(false)
		})
	})

	describe("global config path flattening", () => {
		let mockGlobalDir: string
		let originalEnv: string | undefined

		beforeEach(async () => {
			// Create a mock global config directory structure
			mockGlobalDir = await mkdtemp(join(tmpdir(), "opencode-global-"))
			// Point XDG_CONFIG_HOME to our temp dir so ~/.config/opencode becomes mockGlobalDir/opencode
			originalEnv = process.env.XDG_CONFIG_HOME
			process.env.XDG_CONFIG_HOME = mockGlobalDir
			// Create the "opencode" subdirectory
			await mkdir(join(mockGlobalDir, "opencode"), { recursive: true })
		})

		afterEach(async () => {
			// Restore original env
			if (originalEnv !== undefined) {
				process.env.XDG_CONFIG_HOME = originalEnv
			} else {
				delete process.env.XDG_CONFIG_HOME
			}
			await rm(mockGlobalDir, { recursive: true, force: true })
		})

		it("returns flattened path (no .opencode/) when cwd is global config dir", () => {
			const globalOpencode = join(mockGlobalDir, "opencode")
			const result = findOpencodeConfig(globalOpencode)

			expect(result.exists).toBe(false)
			// Should default to root, NOT .opencode/opencode.jsonc
			expect(result.path).toBe(join(globalOpencode, "opencode.jsonc"))
			expect(result.path).not.toContain(".opencode")
		})

		it("returns flattened path when cwd is a profile directory", async () => {
			const profileDir = join(mockGlobalDir, "opencode", "profiles", "test-profile")
			await mkdir(profileDir, { recursive: true })

			const result = findOpencodeConfig(profileDir)

			expect(result.exists).toBe(false)
			// Should default to profile root, NOT .opencode/opencode.jsonc
			expect(result.path).toBe(join(profileDir, "opencode.jsonc"))
			expect(result.path).not.toContain(".opencode")
		})

		it("finds existing config at profile root (flattened)", async () => {
			const profileDir = join(mockGlobalDir, "opencode", "profiles", "test-profile")
			await mkdir(profileDir, { recursive: true })
			await writeFile(join(profileDir, "opencode.jsonc"), "{}")

			const result = findOpencodeConfig(profileDir)

			expect(result.exists).toBe(true)
			expect(result.path).toBe(join(profileDir, "opencode.jsonc"))
		})

		it("does NOT flatten for paths outside global config dir", async () => {
			// Use the regular testDir which is in /tmp, not in mock global
			const outsideDir = await mkdtemp(join(tmpdir(), "local-project-"))

			try {
				const result = findOpencodeConfig(outsideDir)

				expect(result.exists).toBe(false)
				// Should default to .opencode/ for local projects
				expect(result.path).toBe(join(outsideDir, ".opencode", "opencode.jsonc"))
			} finally {
				await rm(outsideDir, { recursive: true, force: true })
			}
		})

		it("handles path prefix collisions correctly (opencode2 != opencode)", async () => {
			// Create a directory that starts with "opencode" but isn't the global config
			const collisionDir = join(mockGlobalDir, "opencode2")
			await mkdir(collisionDir, { recursive: true })

			const result = findOpencodeConfig(collisionDir)

			// Should NOT be treated as global config path
			expect(result.exists).toBe(false)
			expect(result.path).toBe(join(collisionDir, ".opencode", "opencode.jsonc"))
		})

		it("updateOpencodeJsonConfig creates config at profile root, not in .opencode/", async () => {
			const profileDir = join(mockGlobalDir, "opencode", "profiles", "test")
			await mkdir(profileDir, { recursive: true })

			const mcpServer = { type: "remote" as const, enabled: true, url: "https://test.example.com" }
			const result = await updateOpencodeJsonConfig(profileDir, { mcp: { test: mcpServer } })

			// Correct path returned
			expect(result.path).toBe(join(profileDir, "opencode.jsonc"))
			expect(result.created).toBe(true)
			expect(result.changed).toBe(true)

			// File actually exists with correct content
			const content = await Bun.file(join(profileDir, "opencode.jsonc")).text()
			const config = parseJsonc(content)
			expect(config.mcp?.test).toEqual(mcpServer)

			// Forbidden path does NOT exist
			expect(existsSync(join(profileDir, ".opencode", "opencode.jsonc"))).toBe(false)
		})

		it("updateOpencodeJsonConfig updates existing config at profile root", async () => {
			const profileDir = join(mockGlobalDir, "opencode", "profiles", "test")
			await mkdir(profileDir, { recursive: true })
			await Bun.write(
				join(profileDir, "opencode.jsonc"),
				'{"$schema": "https://opencode.ai/config.json"}',
			)

			const mcpServer = { type: "remote" as const, enabled: true, url: "https://added.example.com" }
			const result = await updateOpencodeJsonConfig(profileDir, { mcp: { added: mcpServer } })

			expect(result.created).toBe(false)
			expect(result.changed).toBe(true)
			expect(result.path).toBe(join(profileDir, "opencode.jsonc"))

			// Verify content was updated
			const content = await Bun.file(join(profileDir, "opencode.jsonc")).text()
			const config = parseJsonc(content)
			expect(config.mcp?.added).toEqual(mcpServer)

			// Still no .opencode/ created
			expect(existsSync(join(profileDir, ".opencode"))).toBe(false)
		})

		it("updateOpencodeJsonConfig creates config in .opencode/ for local projects", async () => {
			const localDir = await mkdtemp(join(tmpdir(), "local-project-"))

			try {
				const mcpServer = { type: "local" as const, enabled: true, command: "test-server" }
				const result = await updateOpencodeJsonConfig(localDir, { mcp: { local: mcpServer } })

				expect(result.path).toBe(join(localDir, ".opencode", "opencode.jsonc"))
				expect(result.created).toBe(true)

				// File exists in .opencode/
				expect(existsSync(join(localDir, ".opencode", "opencode.jsonc"))).toBe(true)

				// Root does NOT have config
				expect(existsSync(join(localDir, "opencode.jsonc"))).toBe(false)
			} finally {
				await rm(localDir, { recursive: true, force: true })
			}
		})

		it("updateOpencodeJsonConfig ignores legacy .opencode/ in profile dir", async () => {
			const profileDir = join(mockGlobalDir, "opencode", "profiles", "test")
			await mkdir(join(profileDir, ".opencode"), { recursive: true })
			await Bun.write(join(profileDir, ".opencode", "opencode.jsonc"), '{"legacy": true}')

			const mcpServer = { type: "remote" as const, enabled: true, url: "https://new.example.com" }
			const result = await updateOpencodeJsonConfig(profileDir, { mcp: { new: mcpServer } })

			// Creates at root, not legacy location
			expect(result.path).toBe(join(profileDir, "opencode.jsonc"))
			expect(result.created).toBe(true)

			// Root config has new content
			const rootContent = await Bun.file(join(profileDir, "opencode.jsonc")).text()
			expect(parseJsonc(rootContent).mcp?.new).toEqual(mcpServer)

			// Legacy file unchanged
			const legacyContent = await Bun.file(join(profileDir, ".opencode", "opencode.jsonc")).text()
			expect(parseJsonc(legacyContent).legacy).toBe(true)
		})
	})
})

/**
 * ConfigResolver Unit Tests
 *
 * Tests for profile resolution and config merging.
 * Uses the tmpdir fixture for isolated temporary directories.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ConfigResolver } from "../../src/config/resolver"
import { tmpdir } from "../fixture"

// =============================================================================
// PROFILE RESOLUTION TESTS
// =============================================================================

describe("ConfigResolver", () => {
	describe("profile resolution", () => {
		let originalXdgConfigHome: string | undefined
		let originalOcxProfile: string | undefined
		let xdgDir: string

		beforeEach(async () => {
			// Create isolated XDG directory
			xdgDir = path.join(os.tmpdir(), `ocx-test-xdg-${Math.random().toString(36).slice(2)}`)
			await fs.mkdir(xdgDir, { recursive: true })

			// Save and override XDG_CONFIG_HOME
			originalXdgConfigHome = process.env.XDG_CONFIG_HOME
			originalOcxProfile = process.env.OCX_PROFILE
			process.env.XDG_CONFIG_HOME = xdgDir
		})

		afterEach(async () => {
			// Restore environment
			if (originalXdgConfigHome === undefined) {
				delete process.env.XDG_CONFIG_HOME
			} else {
				process.env.XDG_CONFIG_HOME = originalXdgConfigHome
			}
			if (originalOcxProfile === undefined) {
				delete process.env.OCX_PROFILE
			} else {
				process.env.OCX_PROFILE = originalOcxProfile
			}
			// Cleanup XDG directory
			await fs.rm(xdgDir, { recursive: true, force: true })
		})

		it("resolves profile from explicit option (highest priority)", async () => {
			await using tmp = await tmpdir({
				git: true,
				profile: { name: "work", ocxConfig: { registries: {} } },
			})

			// Also create a "personal" profile
			const personalDir = path.join(xdgDir, "opencode", "profiles", "personal")
			await fs.mkdir(personalDir, { recursive: true })
			await Bun.write(path.join(personalDir, "ocx.jsonc"), JSON.stringify({ registries: {} }))

			// Set env to personal, but pass work as explicit option
			process.env.OCX_PROFILE = "personal"

			const resolver = await ConfigResolver.create(tmp.path, { profile: "work" })
			const config = resolver.resolve()

			expect(config.profileName).toBe("work") // NOT "personal"
		})

		it("resolves profile from OCX_PROFILE env when no explicit option", async () => {
			await using tmp = await tmpdir({
				git: true,
				profile: { name: "personal", ocxConfig: { registries: {} } },
			})

			// Also create default profile
			const defaultDir = path.join(xdgDir, "opencode", "profiles", "default")
			await fs.mkdir(defaultDir, { recursive: true })
			await Bun.write(path.join(defaultDir, "ocx.jsonc"), JSON.stringify({ registries: {} }))

			process.env.OCX_PROFILE = "personal"

			const resolver = await ConfigResolver.create(tmp.path)
			const config = resolver.resolve()

			expect(config.profileName).toBe("personal") // NOT "default"
		})

		it("falls back to 'default' profile when no option or env", async () => {
			await using tmp = await tmpdir({
				git: true,
				profile: { name: "default", ocxConfig: { registries: {} } },
			})

			// Also create another profile to prove we're not just picking first
			const workDir = path.join(xdgDir, "opencode", "profiles", "work")
			await fs.mkdir(workDir, { recursive: true })
			await Bun.write(path.join(workDir, "ocx.jsonc"), JSON.stringify({ registries: {} }))

			delete process.env.OCX_PROFILE

			const resolver = await ConfigResolver.create(tmp.path)
			const config = resolver.resolve()

			expect(config.profileName).toBe("default")
		})

		it("returns null profileName when no profiles exist", async () => {
			await using tmp = await tmpdir({ git: true })

			delete process.env.OCX_PROFILE

			const resolver = await ConfigResolver.create(tmp.path)
			const config = resolver.resolve()

			expect(config.profileName).toBeNull()
		})
	})

	// =============================================================================
	// CONFIG MERGING TESTS
	// =============================================================================

	describe("config merging", () => {
		let originalXdgConfigHome: string | undefined
		let originalOcxProfile: string | undefined
		let xdgDir: string

		beforeEach(async () => {
			xdgDir = path.join(os.tmpdir(), `ocx-test-xdg-${Math.random().toString(36).slice(2)}`)
			await fs.mkdir(xdgDir, { recursive: true })

			originalXdgConfigHome = process.env.XDG_CONFIG_HOME
			originalOcxProfile = process.env.OCX_PROFILE
			process.env.XDG_CONFIG_HOME = xdgDir
			delete process.env.OCX_PROFILE
		})

		afterEach(async () => {
			if (originalXdgConfigHome === undefined) {
				delete process.env.XDG_CONFIG_HOME
			} else {
				process.env.XDG_CONFIG_HOME = originalXdgConfigHome
			}
			if (originalOcxProfile === undefined) {
				delete process.env.OCX_PROFILE
			} else {
				process.env.OCX_PROFILE = originalOcxProfile
			}
			await fs.rm(xdgDir, { recursive: true, force: true })
		})

		it("deep merges nested objects (local overrides profile)", async () => {
			await using tmp = await tmpdir({
				git: true,
				profile: {
					name: "default",
					ocxConfig: { registries: {}, exclude: [], include: [] },
					opencodeConfig: {
						nested: { fromProfile: "yes", shared: "profile-value" },
						topLevel: "profile",
					},
				},
				opencodeConfig: {
					nested: { fromLocal: "yes", shared: "local-value" },
					topLevel: "local",
				},
			})

			const resolver = await ConfigResolver.create(tmp.path)
			const config = resolver.resolve()

			// Deep merge: all nested keys preserved, local wins on conflicts
			const nested = config.opencode.nested as Record<string, unknown>
			expect(nested.fromProfile).toBe("yes")
			expect(nested.fromLocal).toBe("yes")
			expect(nested.shared).toBe("local-value") // Local wins
			expect(config.opencode.topLevel).toBe("local") // Local wins
		})
	})
})

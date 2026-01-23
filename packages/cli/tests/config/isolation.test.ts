import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { ConfigResolver } from "../../src/config/resolver"
import { tmpdir } from "../fixture"

describe("registry isolation", () => {
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

	it("should use ONLY profile registries when profile is active", async () => {
		await using tmp = await tmpdir({
			git: true,
			profile: {
				name: "default",
				ocxConfig: {
					registries: {
						"profile-reg": { url: "https://profile.example.com" },
					},
					exclude: [], // Allow local loading - isolation should still work
					include: [],
				},
			},
			ocxConfig: {
				registries: {
					"local-reg": { url: "https://local.example.com" },
				},
			},
		})

		const resolver = await ConfigResolver.create(tmp.path)
		const config = resolver.resolve()

		// Profile is active
		expect(config.profileName).toBe("default")
		// ONLY profile registry is available
		expect(config.registries["profile-reg"]).toBeDefined()
		expect(config.registries["profile-reg"].url).toBe("https://profile.example.com")
		// Local registry is NOT available (isolation enforced)
		expect(config.registries["local-reg"]).toBeUndefined()
		// Verify exact count
		expect(Object.keys(config.registries)).toHaveLength(1)
	})

	it("should use ONLY local registries when no profile is active", async () => {
		// CRITICAL: Do NOT create any profile - don't use the profile option at all
		// This ensures ConfigResolver.create() doesn't auto-activate a default profile
		await using tmp = await tmpdir({
			git: true,
			// NO profile option - ensures profiles directory is not created
			ocxConfig: {
				registries: {
					"local-reg": { url: "https://local.example.com" },
				},
			},
		})

		const resolver = await ConfigResolver.create(tmp.path)
		const config = resolver.resolve()

		// No profile is active
		expect(config.profileName).toBeNull()
		// ONLY local registry is available
		expect(config.registries["local-reg"]).toBeDefined()
		expect(config.registries["local-reg"].url).toBe("https://local.example.com")
		// Verify exact count
		expect(Object.keys(config.registries)).toHaveLength(1)
	})

	it("should NOT merge registries across scopes", async () => {
		await using tmp = await tmpdir({
			git: true,
			profile: {
				name: "default",
				ocxConfig: {
					registries: {
						"profile-reg": { url: "https://profile.example.com" },
					},
					exclude: [],
					include: [],
				},
			},
			ocxConfig: {
				registries: {
					"local-reg": { url: "https://local.example.com" },
				},
			},
		})

		const resolver = await ConfigResolver.create(tmp.path)
		const config = resolver.resolve()

		// Exactly one registry (no merging occurred)
		expect(Object.keys(config.registries)).toHaveLength(1)
		// Profile registry present
		expect(config.registries["profile-reg"]).toBeDefined()
		// Local registry absent (would indicate merging bug)
		expect(config.registries["local-reg"]).toBeUndefined()
	})

	it("should still merge OpenCode config when profile is active", async () => {
		await using tmp = await tmpdir({
			git: true,
			profile: {
				name: "default",
				ocxConfig: {
					registries: {},
					exclude: [],
					include: [],
				},
				opencodeConfig: {
					profileSetting: true,
					shared: "profile-value",
				},
			},
			opencodeConfig: {
				localSetting: true,
				shared: "local-value",
			},
		})

		const resolver = await ConfigResolver.create(tmp.path)
		const config = resolver.resolve()

		// OpenCode config DOES merge (this behavior must not break)
		expect((config.opencode as Record<string, unknown>).profileSetting).toBe(true)
		expect((config.opencode as Record<string, unknown>).localSetting).toBe(true)
		// Local overrides profile for shared keys
		expect((config.opencode as Record<string, unknown>).shared).toBe("local-value")
	})

	it("should isolate registries in resolveWithOrigin() and not track local origins", async () => {
		await using tmp = await tmpdir({
			git: true,
			profile: {
				name: "default",
				ocxConfig: {
					registries: {
						"profile-reg": { url: "https://profile.example.com" },
					},
					exclude: [],
					include: [],
				},
			},
			ocxConfig: {
				registries: {
					"local-reg": { url: "https://local.example.com" },
				},
			},
		})

		const resolver = await ConfigResolver.create(tmp.path)
		const result = resolver.resolveWithOrigin()

		// Same isolation behavior via resolveWithOrigin()
		expect(result.registries["profile-reg"]).toBeDefined()
		expect(result.registries["local-reg"]).toBeUndefined()

		// Origin tracking only shows profile registry
		expect(result.origins.get("registries.profile-reg")).toBeDefined()
		// CRITICAL: No origin entry for local registry (proves isolation)
		expect(result.origins.get("registries.local-reg")).toBeUndefined()
	})
})

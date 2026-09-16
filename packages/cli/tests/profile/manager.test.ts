/**
 * ProfileManager Unit Tests
 *
 * Tests for the ProfileManager class covering:
 * - Initialization checks
 * - Profile CRUD operations
 * - Profile resolution (resolveProfile)
 * - Environment variable overrides
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ProfileManager } from "../../src/profile/manager"
import { getProfileDir, getProfilesDir } from "../../src/profile/paths"
import { ProfileExistsError, ProfileNotFoundError } from "../../src/utils/errors"

// =============================================================================
// HELPERS
// =============================================================================

async function createTempConfigDir(name: string): Promise<string> {
	const dir = join(import.meta.dir, "fixtures", `tmp-${name}-${Date.now()}`)
	await mkdir(dir, { recursive: true })
	return dir
}

async function cleanupTempDir(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true })
}

// =============================================================================
// INITIALIZATION TESTS
// =============================================================================

describe("ProfileManager.isInitialized", () => {
	let testDir: string
	const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

	beforeEach(async () => {
		testDir = await createTempConfigDir("profile-init-check")
		process.env.XDG_CONFIG_HOME = testDir
	})

	afterEach(async () => {
		if (originalXdgConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME
		} else {
			process.env.XDG_CONFIG_HOME = originalXdgConfigHome
		}
		await cleanupTempDir(testDir)
	})

	it("should return false when profiles directory does not exist", async () => {
		const manager = ProfileManager.create()

		const initialized = await manager.isInitialized()

		expect(initialized).toBe(false)
	})

	it("should return true when profiles directory exists", async () => {
		const profilesDir = getProfilesDir()
		await mkdir(profilesDir, { recursive: true })
		const manager = ProfileManager.create()

		const initialized = await manager.isInitialized()

		expect(initialized).toBe(true)
	})
})

// =============================================================================
// INITIALIZE TESTS
// =============================================================================

describe("ProfileManager.initialize", () => {
	let testDir: string
	const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

	beforeEach(async () => {
		testDir = await createTempConfigDir("profile-initialize")
		process.env.XDG_CONFIG_HOME = testDir
	})

	afterEach(async () => {
		if (originalXdgConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME
		} else {
			process.env.XDG_CONFIG_HOME = originalXdgConfigHome
		}
		await cleanupTempDir(testDir)
	})

	it("should create profiles directory", async () => {
		const manager = ProfileManager.create()

		await manager.initialize()

		const profilesDir = getProfilesDir()
		const stats = await stat(profilesDir)
		expect(stats.isDirectory()).toBe(true)
	})

	it("should create default profile", async () => {
		const manager = ProfileManager.create()

		await manager.initialize()

		const exists = await manager.exists("default")
		expect(exists).toBe(true)
	})

	it("should create ocx.jsonc with profile schema URL", async () => {
		const manager = ProfileManager.create()

		await manager.initialize()

		const profile = await manager.get("default")
		expect(profile.ocx).toBeDefined()
		expect(profile.ocx.registries).toBeDefined()
		expect(profile.ocx.$schema).toBe("https://ocx.kdco.dev/schemas/v3/profile.json")
	})
})

// =============================================================================
// LIST TESTS
// =============================================================================

describe("ProfileManager.list", () => {
	let testDir: string
	const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

	beforeEach(async () => {
		testDir = await createTempConfigDir("profile-list")
		process.env.XDG_CONFIG_HOME = testDir
	})

	afterEach(async () => {
		if (originalXdgConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME
		} else {
			process.env.XDG_CONFIG_HOME = originalXdgConfigHome
		}
		await cleanupTempDir(testDir)
	})

	it("should list no profiles when not initialized", async () => {
		const manager = ProfileManager.create()

		expect(await manager.list()).toEqual([])
	})

	it("should return all profile names sorted", async () => {
		const manager = ProfileManager.create()
		await manager.initialize()
		await manager.add("zebra")
		await manager.add("alpha")

		const profiles = await manager.list()

		expect(profiles).toEqual(["alpha", "default", "zebra"])
	})

	it("should not include hidden directories", async () => {
		const manager = ProfileManager.create()
		await manager.initialize()

		// Create a hidden directory
		const hiddenDir = join(getProfilesDir(), ".hidden")
		await mkdir(hiddenDir, { recursive: true })

		const profiles = await manager.list()

		expect(profiles).not.toContain(".hidden")
	})

	it("should exclude symlinks that resolve to directories", async () => {
		const manager = ProfileManager.create()
		await manager.initialize()
		await manager.add("zebra")

		const targetDir = join(testDir, "external-profiles", "alpha-link-target")
		await mkdir(targetDir, { recursive: true })
		await symlink(targetDir, join(getProfilesDir(), "alpha-link"))

		const profiles = await manager.list()

		expect(profiles).toEqual(["default", "zebra"])
	})

	it("should exclude broken symlinks", async () => {
		const manager = ProfileManager.create()
		await manager.initialize()

		await symlink(join(testDir, "missing-profile-target"), join(getProfilesDir(), "broken-link"))

		const profiles = await manager.list()

		expect(profiles).not.toContain("broken-link")
	})

	it("should exclude symlinks that resolve to regular files", async () => {
		const manager = ProfileManager.create()
		await manager.initialize()

		const targetFile = join(testDir, "not-a-profile")
		await writeFile(targetFile, "not a directory")
		await symlink(targetFile, join(getProfilesDir(), "file-link"))

		const profiles = await manager.list()

		expect(profiles).not.toContain("file-link")
	})

	it("should not include current symlink in list", async () => {
		const manager = ProfileManager.create()
		await manager.initialize()

		const profiles = await manager.list()

		expect(profiles).not.toContain("current")
	})
})

// =============================================================================
// EXISTS TESTS
// =============================================================================

describe("ProfileManager.exists", () => {
	let testDir: string
	const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

	beforeEach(async () => {
		testDir = await createTempConfigDir("profile-exists")
		process.env.XDG_CONFIG_HOME = testDir
	})

	afterEach(async () => {
		if (originalXdgConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME
		} else {
			process.env.XDG_CONFIG_HOME = originalXdgConfigHome
		}
		await cleanupTempDir(testDir)
	})

	it("should return true for existing profile", async () => {
		const manager = ProfileManager.create()
		await manager.initialize()

		const exists = await manager.exists("default")

		expect(exists).toBe(true)
	})

	it("should return false for non-existing profile", async () => {
		const manager = ProfileManager.create()
		await manager.initialize()

		const exists = await manager.exists("nonexistent")

		expect(exists).toBe(false)
	})
})

// =============================================================================
// GET TESTS
// =============================================================================

describe("ProfileManager.get", () => {
	let testDir: string
	const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

	beforeEach(async () => {
		testDir = await createTempConfigDir("profile-get")
		process.env.XDG_CONFIG_HOME = testDir
	})

	afterEach(async () => {
		if (originalXdgConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME
		} else {
			process.env.XDG_CONFIG_HOME = originalXdgConfigHome
		}
		await cleanupTempDir(testDir)
	})

	it("should load and validate profile", async () => {
		const manager = ProfileManager.create()
		await manager.initialize()

		const profile = await manager.get("default")

		expect(profile.name).toBe("default")
		expect(profile.ocx).toBeDefined()
		expect(profile.ocx.registries).toBeDefined()
	})

	it("should throw ProfileNotFoundError for missing profiles", async () => {
		const manager = ProfileManager.create()
		await manager.initialize()

		expect(manager.get("nonexistent")).rejects.toThrow(ProfileNotFoundError)
	})

	it("should detect hasAgents correctly when AGENTS.md exists", async () => {
		const manager = ProfileManager.create()
		await manager.initialize()

		// Create AGENTS.md in default profile
		const agentsPath = join(getProfileDir("default"), "AGENTS.md")
		await Bun.write(agentsPath, "# Test Agents")

		const profile = await manager.get("default")

		expect(profile.hasAgents).toBe(true)
	})

	it("should detect hasAgents correctly when AGENTS.md exists (created by default)", async () => {
		const manager = ProfileManager.create()
		await manager.initialize()

		const profile = await manager.get("default")

		// AGENTS.md is now created by default in new profiles
		expect(profile.hasAgents).toBe(true)
	})

	it("should load opencode.jsonc when present", async () => {
		const manager = ProfileManager.create()
		await manager.initialize()

		// Create opencode.jsonc in default profile
		const opencodePath = join(getProfileDir("default"), "opencode.jsonc")
		await Bun.write(opencodePath, JSON.stringify({ model: "test-model" }))

		const profile = await manager.get("default")

		expect(profile.opencode).toBeDefined()
		expect(profile.opencode?.model).toBe("test-model")
	})
})

// =============================================================================
// ADD TESTS
// =============================================================================

describe("ProfileManager.add", () => {
	let testDir: string
	const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

	beforeEach(async () => {
		testDir = await createTempConfigDir("profile-add")
		process.env.XDG_CONFIG_HOME = testDir
	})

	afterEach(async () => {
		if (originalXdgConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME
		} else {
			process.env.XDG_CONFIG_HOME = originalXdgConfigHome
		}
		await cleanupTempDir(testDir)
	})

	it("should create profile directory", async () => {
		const manager = ProfileManager.create()
		await manager.initialize()

		await manager.add("myprofile")

		const profileDir = getProfileDir("myprofile")
		const stats = await stat(profileDir)
		expect(stats.isDirectory()).toBe(true)
	})

	it("should create ocx.jsonc in new profile", async () => {
		const manager = ProfileManager.create()
		await manager.initialize()

		await manager.add("myprofile")

		const profile = await manager.get("myprofile")
		expect(profile.ocx).toBeDefined()
		expect(profile.ocx.$schema).toBeDefined()
	})

	it("should throw ProfileExistsError for duplicate names", async () => {
		const manager = ProfileManager.create()
		await manager.initialize()
		await manager.add("duplicate")

		expect(manager.add("duplicate")).rejects.toThrow(ProfileExistsError)
	})

	it("should throw InvalidProfileNameError for empty names", async () => {
		const manager = ProfileManager.create()
		await manager.initialize()

		expect(manager.add("")).rejects.toThrow()
	})

	it("should throw InvalidProfileNameError for names starting with number", async () => {
		const manager = ProfileManager.create()
		await manager.initialize()

		expect(manager.add("123profile")).rejects.toThrow()
	})

	it("should throw InvalidProfileNameError for names with path traversal", async () => {
		const manager = ProfileManager.create()
		await manager.initialize()

		expect(manager.add("../../../etc")).rejects.toThrow()
	})

	it("should throw InvalidProfileNameError for names with slashes", async () => {
		const manager = ProfileManager.create()
		await manager.initialize()

		expect(manager.add("a/b/c")).rejects.toThrow()
	})

	it("should accept valid names with dots, underscores, and hyphens", async () => {
		const manager = ProfileManager.create()
		await manager.initialize()

		await manager.add("my.profile")
		await manager.add("my_profile")
		await manager.add("my-profile")

		expect(await manager.exists("my.profile")).toBe(true)
		expect(await manager.exists("my_profile")).toBe(true)
		expect(await manager.exists("my-profile")).toBe(true)
	})
})

// =============================================================================
// REMOVE TESTS
// =============================================================================

describe("ProfileManager.remove", () => {
	let testDir: string
	const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

	beforeEach(async () => {
		testDir = await createTempConfigDir("profile-remove")
		process.env.XDG_CONFIG_HOME = testDir
	})

	afterEach(async () => {
		if (originalXdgConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME
		} else {
			process.env.XDG_CONFIG_HOME = originalXdgConfigHome
		}
		await cleanupTempDir(testDir)
	})

	it("should delete profile directory", async () => {
		const manager = ProfileManager.create()
		await manager.initialize()
		await manager.add("toremove")

		await manager.remove("toremove")

		const exists = await manager.exists("toremove")
		expect(exists).toBe(false)
	})

	it("should throw ProfileNotFoundError for non-existing profile", async () => {
		const manager = ProfileManager.create()
		await manager.initialize()

		expect(manager.remove("nonexistent")).rejects.toThrow(ProfileNotFoundError)
	})

	it("should prevent deleting the selected default", async () => {
		const manager = ProfileManager.create()
		await manager.initialize()

		// Only default exists, can't delete it
		expect(manager.remove("default")).rejects.toThrow(/is the default profile/)
	})

	it("should allow deleting when multiple profiles exist", async () => {
		const manager = ProfileManager.create()
		await manager.initialize()
		await manager.add("other")

		// A non-default profile can be removed.
		await manager.remove("other")

		const exists = await manager.exists("other")
		expect(exists).toBe(false)
	})
})

// =============================================================================
// RESOLVE PROFILE TESTS
// =============================================================================

describe("ProfileManager.resolveProfile", () => {
	let testDir: string
	const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
	const originalOcxProfile = process.env.OCX_PROFILE

	beforeEach(async () => {
		testDir = await createTempConfigDir("profile-resolve")
		process.env.XDG_CONFIG_HOME = testDir
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
		await cleanupTempDir(testDir)
	})

	it("should return 'default' when no override or env var", async () => {
		const manager = ProfileManager.create()
		await manager.initialize()

		const profile = await manager.resolveProfile()

		expect(profile).toBe("default")
	})

	it("should respect OCX_PROFILE env var", async () => {
		const manager = ProfileManager.create()
		await manager.initialize()
		await manager.add("envprofile")

		process.env.OCX_PROFILE = "envprofile"

		const profile = await manager.resolveProfile()

		expect(profile).toBe("envprofile")
	})

	it("should throw ProfileNotFoundError if OCX_PROFILE refers to non-existing profile", async () => {
		const manager = ProfileManager.create()
		await manager.initialize()

		process.env.OCX_PROFILE = "nonexistent"

		expect(manager.resolveProfile()).rejects.toThrow(ProfileNotFoundError)
	})

	it("should use override parameter over env var", async () => {
		const manager = ProfileManager.create()
		await manager.initialize()
		await manager.add("override")
		await manager.add("envval")

		process.env.OCX_PROFILE = "envval"

		const profile = await manager.resolveProfile("override")

		expect(profile).toBe("override")
	})

	it("should throw ProfileNotFoundError if override refers to non-existing profile", async () => {
		const manager = ProfileManager.create()
		await manager.initialize()

		expect(manager.resolveProfile("nonexistent")).rejects.toThrow(ProfileNotFoundError)
	})

	it("should use override over default when no env var set", async () => {
		const manager = ProfileManager.create()
		await manager.initialize()
		await manager.add("myprofile")

		const profile = await manager.resolveProfile("myprofile")

		expect(profile).toBe("myprofile")
	})
})

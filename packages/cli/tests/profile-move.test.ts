/**
 * Profile Move Command Tests
 *
 * Tests for the profile move (rename) command.
 * Verifies atomic rename, validation, and edge cases.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir, runCLI } from "./helpers"

// Sentinel values - unique componentPath per profile to prove correct selection
const SENTINEL_FOO = "components/foo-12345"
const SENTINEL_BAR = "components/bar-67890"
const SENTINEL_DEFAULT = "components/default-ABCDE"

// Snapshot only the keys we touch
const ENV_KEYS = ["XDG_CONFIG_HOME", "OCX_PROFILE"] as const
let envSnapshot: Map<string, string | undefined>
let testDir: string

beforeEach(async () => {
	// Snapshot env state
	envSnapshot = new Map(ENV_KEYS.map((k) => [k, process.env[k]]))

	testDir = await createTempDir("profile-move")
	process.env.XDG_CONFIG_HOME = testDir
	delete process.env.OCX_PROFILE

	// Create fixture structure
	const configDir = join(testDir, "opencode")
	await mkdir(join(configDir, "profiles", "default"), { recursive: true })
	await mkdir(join(configDir, "profiles", "foo"), { recursive: true })

	// Global config
	await Bun.write(join(configDir, "ocx.jsonc"), JSON.stringify({ registries: {} }, null, 2))

	// Profile configs with UNIQUE componentPath values as sentinels
	await Bun.write(
		join(configDir, "profiles", "default", "ocx.jsonc"),
		JSON.stringify({ componentPath: SENTINEL_DEFAULT }, null, 2),
	)
	await Bun.write(
		join(configDir, "profiles", "foo", "ocx.jsonc"),
		JSON.stringify({ componentPath: SENTINEL_FOO }, null, 2),
	)
})

afterEach(async () => {
	// Restore env: delete if was unset, otherwise restore value
	for (const [key, value] of envSnapshot) {
		if (value === undefined) {
			delete process.env[key]
		} else {
			process.env[key] = value
		}
	}
	await cleanupTempDir(testDir)
})

// =============================================================================
// Profile Move Tests
// =============================================================================

describe("ocx profile move", () => {
	it("should move profile successfully", async () => {
		const configDir = join(testDir, "opencode")
		const oldDir = join(configDir, "profiles", "foo")
		const newDir = join(configDir, "profiles", "bar")

		// Precondition: source exists, target doesn't
		expect(existsSync(oldDir)).toBe(true)
		expect(existsSync(newDir)).toBe(false)

		const { exitCode, output } = await runCLI(["profile", "move", "foo", "bar"], testDir)

		expect(exitCode).toBe(0)
		expect(output).toContain("Moved")
		expect(output).toContain("foo")
		expect(output).toContain("bar")

		// Postcondition: old gone, new exists
		expect(existsSync(oldDir)).toBe(false)
		expect(existsSync(newDir)).toBe(true)

		// Content preserved (check sentinel value)
		const configFile = Bun.file(join(newDir, "ocx.jsonc"))
		const content = await configFile.text()
		expect(content).toContain(SENTINEL_FOO)
	})

	it("should fail with invalid old name containing path traversal", async () => {
		const { exitCode, output } = await runCLI(["profile", "move", "../evil", "bar"], testDir)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("Invalid profile name")
	})

	it("should fail with invalid new name containing path separator", async () => {
		const { exitCode, output } = await runCLI(["profile", "move", "foo", "bad/path"], testDir)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("Invalid profile name")
	})

	it("should fail when source profile not found", async () => {
		const { exitCode, output } = await runCLI(["profile", "move", "nonexistent", "bar"], testDir)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("not found")
	})

	it("should fail when target profile already exists", async () => {
		// Create target profile
		const configDir = join(testDir, "opencode")
		await mkdir(join(configDir, "profiles", "bar"), { recursive: true })
		await Bun.write(
			join(configDir, "profiles", "bar", "ocx.jsonc"),
			JSON.stringify({ componentPath: SENTINEL_BAR }, null, 2),
		)

		const { exitCode, output } = await runCLI(["profile", "move", "foo", "bar"], testDir)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("already exists")
		expect(output).toContain("Remove it first")

		// Both profiles should still exist
		expect(existsSync(join(configDir, "profiles", "foo"))).toBe(true)
		expect(existsSync(join(configDir, "profiles", "bar"))).toBe(true)
	})

	it("should work with mv alias", async () => {
		const configDir = join(testDir, "opencode")
		const oldDir = join(configDir, "profiles", "foo")
		const newDir = join(configDir, "profiles", "renamed")

		// Precondition: source exists
		expect(existsSync(oldDir)).toBe(true)

		const { exitCode, output } = await runCLI(["p", "mv", "foo", "renamed"], testDir)

		expect(exitCode).toBe(0)
		expect(output).toContain("Moved")

		// Postcondition: old gone, new exists
		expect(existsSync(oldDir)).toBe(false)
		expect(existsSync(newDir)).toBe(true)
	})

	it("should handle self-move as no-op", async () => {
		const configDir = join(testDir, "opencode")
		const profileDir = join(configDir, "profiles", "foo")

		// Precondition: profile exists
		expect(existsSync(profileDir)).toBe(true)

		const { exitCode, output } = await runCLI(["profile", "move", "foo", "foo"], testDir)

		expect(exitCode).toBe(0)
		// Should still output success message
		expect(output).toContain("Moved")

		// Profile should still exist
		expect(existsSync(profileDir)).toBe(true)

		// Content preserved
		const configFile = Bun.file(join(profileDir, "ocx.jsonc"))
		const content = await configFile.text()
		expect(content).toContain(SENTINEL_FOO)
	})

	it("should allow moving the default profile", async () => {
		const configDir = join(testDir, "opencode")
		const oldDir = join(configDir, "profiles", "default")
		const newDir = join(configDir, "profiles", "primary")

		// Precondition: default exists
		expect(existsSync(oldDir)).toBe(true)

		const { exitCode, output } = await runCLI(["profile", "move", "default", "primary"], testDir)

		expect(exitCode).toBe(0)
		expect(output).toContain("Moved")
		expect(output).toContain("default")
		expect(output).toContain("primary")

		// Postcondition: old gone, new exists
		expect(existsSync(oldDir)).toBe(false)
		expect(existsSync(newDir)).toBe(true)

		// Content preserved (check sentinel value)
		const configFile = Bun.file(join(newDir, "ocx.jsonc"))
		const content = await configFile.text()
		expect(content).toContain(SENTINEL_DEFAULT)
	})

	it("should warn when moving active profile", async () => {
		const configDir = join(testDir, "opencode")
		const newDir = join(configDir, "profiles", "bar")

		const { exitCode, output } = await runCLI(["profile", "move", "foo", "bar"], testDir, {
			env: { OCX_PROFILE: "foo" },
		})

		expect(exitCode).toBe(0)
		expect(output).toContain("Moved")
		// Should warn about updating env var
		expect(output).toContain("OCX_PROFILE")
		expect(output).toContain("bar")

		// Move still succeeded
		expect(existsSync(newDir)).toBe(true)
	})
})

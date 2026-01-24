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

// Exact content strings for byte-equal verification
const FOO_CONTENT = '{ "componentPath": "SENTINEL_FOO" }'
const BAR_CONTENT = '{ "componentPath": "SENTINEL_BAR" }'
const DEFAULT_CONTENT = '{ "componentPath": "SENTINEL_DEFAULT" }'

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

	// Profile configs with EXACT content for byte-equal verification
	await Bun.write(join(configDir, "profiles", "default", "ocx.jsonc"), DEFAULT_CONTENT)
	await Bun.write(join(configDir, "profiles", "foo", "ocx.jsonc"), FOO_CONTENT)
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

		// Exact exit code assertion
		expect(exitCode).toBe(0)
		expect(output).toContain("Moved")
		expect(output).toContain("foo")
		expect(output).toContain("bar")

		// Negative assertion: no warning when not moving active profile
		expect(output).not.toContain("Warning")
		expect(output).not.toContain("warn")
		expect(output).not.toContain("OCX_PROFILE")

		// Atomicity assertions: old gone AND new exists
		expect(existsSync(oldDir)).toBe(false)
		expect(existsSync(newDir)).toBe(true)

		// Byte-equal content verification
		const newContent = await Bun.file(join(newDir, "ocx.jsonc")).text()
		expect(newContent).toBe(FOO_CONTENT)
	})

	it("should fail with invalid old name containing path traversal", async () => {
		const { exitCode, output } = await runCLI(["profile", "move", "../evil", "bar"], testDir)

		// Invalid name = validation error = exit 1
		expect(exitCode).toBe(1)
		expect(output).toContain('Invalid profile name "../evil"')
	})

	it("should fail with invalid new name containing path separator", async () => {
		const { exitCode, output } = await runCLI(["profile", "move", "foo", "bad/path"], testDir)

		// Invalid name = validation error = exit 1
		expect(exitCode).toBe(1)
		expect(output).toContain('Invalid profile name "bad/path"')
	})

	it("should fail when source profile not found", async () => {
		const { exitCode, output } = await runCLI(["profile", "move", "nonexistent", "bar"], testDir)

		// Not found = exit 66
		expect(exitCode).toBe(66)
		expect(output).toContain('Profile "nonexistent" not found')
	})

	it("should fail when target profile already exists", async () => {
		// Create target profile with known content
		const configDir = join(testDir, "opencode")
		const fooDir = join(configDir, "profiles", "foo")
		const barDir = join(configDir, "profiles", "bar")
		await mkdir(barDir, { recursive: true })
		await Bun.write(join(barDir, "ocx.jsonc"), BAR_CONTENT)

		const { exitCode, output } = await runCLI(["profile", "move", "foo", "bar"], testDir)

		// Conflict = exit 6
		expect(exitCode).toBe(6)
		expect(output).toContain(
			`Cannot move: profile "bar" already exists. Remove it first with 'ocx p rm bar'.`,
		)

		// Atomicity: BOTH dirs still exist with UNCHANGED content
		expect(existsSync(fooDir)).toBe(true)
		expect(existsSync(barDir)).toBe(true)
		expect(await Bun.file(join(fooDir, "ocx.jsonc")).text()).toBe(FOO_CONTENT)
		expect(await Bun.file(join(barDir, "ocx.jsonc")).text()).toBe(BAR_CONTENT)
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

	it("should handle self-move as no-op when profile exists", async () => {
		const configDir = join(testDir, "opencode")
		const profileDir = join(configDir, "profiles", "foo")

		// Precondition: profile exists
		expect(existsSync(profileDir)).toBe(true)

		const { exitCode, output } = await runCLI(["profile", "move", "foo", "foo"], testDir)

		// Exact exit code: success
		expect(exitCode).toBe(0)
		// Should still output success message
		expect(output).toContain("Moved")

		// Profile should still exist
		expect(existsSync(profileDir)).toBe(true)

		// Byte-equal content preserved
		const content = await Bun.file(join(profileDir, "ocx.jsonc")).text()
		expect(content).toBe(FOO_CONTENT)
	})

	it("should fail self-move when profile does not exist", async () => {
		const { exitCode, output } = await runCLI(
			["profile", "move", "nonexistent", "nonexistent"],
			testDir,
		)

		// Not found = exit 66 (source checked before self-move optimization)
		expect(exitCode).toBe(66)
		expect(output).toContain('Profile "nonexistent" not found')
	})

	it("should allow moving the default profile", async () => {
		const configDir = join(testDir, "opencode")
		const oldDir = join(configDir, "profiles", "default")
		const newDir = join(configDir, "profiles", "primary")

		// Precondition: default exists
		expect(existsSync(oldDir)).toBe(true)

		const { exitCode, output } = await runCLI(["profile", "move", "default", "primary"], testDir)

		// Exact exit code
		expect(exitCode).toBe(0)
		expect(output).toContain("Moved")
		expect(output).toContain("default")
		expect(output).toContain("primary")

		// Atomicity: old gone AND new exists
		expect(existsSync(oldDir)).toBe(false)
		expect(existsSync(newDir)).toBe(true)

		// Byte-equal content verification
		const newContent = await Bun.file(join(newDir, "ocx.jsonc")).text()
		expect(newContent).toBe(DEFAULT_CONTENT)
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

	// =========================================================================
	// Boundary Conditions
	// =========================================================================

	describe("boundary conditions", () => {
		// Path traversal - old name
		it("should reject path traversal in old name (../)", async () => {
			const { exitCode, output } = await runCLI(["profile", "move", "../evil", "bar"], testDir)
			expect(exitCode).toBe(1)
			expect(output).toContain('Invalid profile name "../evil"')
		})

		it("should reject dotdot as old name", async () => {
			const { exitCode, output } = await runCLI(["profile", "move", "..", "bar"], testDir)
			expect(exitCode).toBe(1)
			expect(output).toContain('Invalid profile name ".."')
		})

		it("should reject dot as old name", async () => {
			const { exitCode, output } = await runCLI(["profile", "move", ".", "bar"], testDir)
			expect(exitCode).toBe(1)
			expect(output).toContain('Invalid profile name "."')
		})

		it("should reject forward slash in name", async () => {
			const { exitCode, output } = await runCLI(["profile", "move", "a/b", "bar"], testDir)
			expect(exitCode).toBe(1)
			expect(output).toContain('Invalid profile name "a/b"')
		})

		it("should reject backslash in name", async () => {
			const { exitCode, output } = await runCLI(["profile", "move", "a\\b", "bar"], testDir)
			expect(exitCode).toBe(1)
			expect(output).toContain("Invalid profile name")
		})

		// Name length boundaries
		it("should accept minimum length name (1 char)", async () => {
			// Create source profile first
			const configDir = join(testDir, "opencode")
			const profileDir = join(configDir, "profiles", "x")
			await mkdir(profileDir, { recursive: true })
			await Bun.write(join(profileDir, "ocx.jsonc"), "{}")

			const { exitCode } = await runCLI(["profile", "move", "x", "y"], testDir)
			expect(exitCode).toBe(0)
		})

		it("should accept maximum length name (32 chars)", async () => {
			const longName = "a".repeat(32)
			const configDir = join(testDir, "opencode")
			const profileDir = join(configDir, "profiles", "src")
			await mkdir(profileDir, { recursive: true })
			await Bun.write(join(profileDir, "ocx.jsonc"), "{}")

			const { exitCode } = await runCLI(["profile", "move", "src", longName], testDir)
			expect(exitCode).toBe(0)
		})

		it("should reject name over 32 chars", async () => {
			const tooLong = "a".repeat(33)
			const { exitCode, output } = await runCLI(["profile", "move", "foo", tooLong], testDir)
			expect(exitCode).toBe(1)
			expect(output).toContain("Invalid profile name")
		})

		// Special characters
		it("should accept allowed special chars (dots, underscores, hyphens)", async () => {
			const configDir = join(testDir, "opencode")
			const profileDir = join(configDir, "profiles", "src")
			await mkdir(profileDir, { recursive: true })
			await Bun.write(join(profileDir, "ocx.jsonc"), "{}")

			const { exitCode } = await runCLI(["profile", "move", "src", "a.b_c-d"], testDir)
			expect(exitCode).toBe(0)
		})

		it("should reject name starting with number", async () => {
			const { exitCode, output } = await runCLI(["profile", "move", "foo", "1abc"], testDir)
			expect(exitCode).toBe(1)
			expect(output).toContain("Invalid profile name")
		})

		it("should reject name with space", async () => {
			const { exitCode, output } = await runCLI(["profile", "move", "foo", "a b"], testDir)
			expect(exitCode).toBe(1)
			expect(output).toContain("Invalid profile name")
		})
	})
})

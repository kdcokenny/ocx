/**
 * Ghost Migrate Command Tests
 *
 * Tests for the temporary ghost mode migration command.
 * This test file will be removed in the next minor version.
 *
 * @note These tests mutate process.env.XDG_CONFIG_HOME and must run serially
 * within this file. Bun runs tests within a file serially by default.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { getProfilesDir } from "../src/profile/paths"
import { cleanupTempDir, runCLI } from "./helpers"

// =============================================================================
// HELPERS
// =============================================================================

async function createTempConfigDir(name: string): Promise<string> {
	const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
	const dir = join(import.meta.dir, "fixtures", `tmp-${name}-${uniqueId}`)
	await mkdir(dir, { recursive: true })
	return dir
}

/**
 * Create a profile directory with specified files
 */
function createProfile(profilesDir: string, name: string, files: Record<string, string>): void {
	const profileDir = join(profilesDir, name)
	mkdirSync(profileDir, { recursive: true })
	for (const [fileName, content] of Object.entries(files)) {
		writeFileSync(join(profileDir, fileName), content)
	}
}

/**
 * Run the ghost migrate CLI command
 */
async function runGhostMigrate(
	testDir: string,
	args: string[] = [],
): Promise<{ exitCode: number; output: string }> {
	// Create a temp working directory for the CLI to run in
	const workDir = join(testDir, "workdir")
	await mkdir(workDir, { recursive: true })

	const result = await runCLI(["ghost", "migrate", ...args], workDir)
	return {
		exitCode: result.exitCode,
		output: result.output,
	}
}

// =============================================================================
// SUCCESSFUL MIGRATION TESTS
// =============================================================================

describe("ghost migrate - successful migrations", () => {
	let testDir: string
	const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

	beforeEach(async () => {
		testDir = await createTempConfigDir("ghost-migrate-success")
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

	it("should migrate ghost.jsonc to ocx.jsonc in a single profile", async () => {
		const profilesDir = getProfilesDir()
		const ghostContent = '{ "bin": "/usr/local/bin/opencode" }'
		createProfile(profilesDir, "default", { "ghost.jsonc": ghostContent })

		const { exitCode, output } = await runGhostMigrate(testDir)

		expect(exitCode).toBe(0)
		expect(output).toContain("default")
		expect(output).toContain("ghost.jsonc")
		expect(output).toContain("ocx.jsonc")

		// Verify files
		const profileDir = join(profilesDir, "default")
		expect(existsSync(join(profileDir, "ocx.jsonc"))).toBe(true)
		expect(existsSync(join(profileDir, "ghost.jsonc"))).toBe(false)

		// Verify content preserved
		const migratedContent = readFileSync(join(profileDir, "ocx.jsonc"), "utf-8")
		expect(migratedContent).toBe(ghostContent)
	})

	it("should migrate multiple profiles", async () => {
		const profilesDir = getProfilesDir()
		createProfile(profilesDir, "default", { "ghost.jsonc": '{ "bin": "opencode" }' })
		createProfile(profilesDir, "work", { "ghost.jsonc": '{ "bin": "work-opencode" }' })
		createProfile(profilesDir, "personal", { "ghost.jsonc": '{ "bin": "personal-opencode" }' })

		const { exitCode, output } = await runGhostMigrate(testDir)

		expect(exitCode).toBe(0)
		expect(output).toContain("default")
		expect(output).toContain("work")
		expect(output).toContain("personal")

		// Verify all profiles migrated
		for (const name of ["default", "work", "personal"]) {
			const profileDir = join(profilesDir, name)
			expect(existsSync(join(profileDir, "ocx.jsonc"))).toBe(true)
			expect(existsSync(join(profileDir, "ghost.jsonc"))).toBe(false)
		}

		// Verify content preserved for each profile
		const expectedContents: Record<string, string> = {
			default: '{ "bin": "opencode" }',
			work: '{ "bin": "work-opencode" }',
			personal: '{ "bin": "personal-opencode" }',
		}
		for (const [name, expectedContent] of Object.entries(expectedContents)) {
			const content = readFileSync(join(profilesDir, name, "ocx.jsonc"), "utf-8")
			expect(content).toBe(expectedContent)
		}
	})

	it("should report migration complete on success", async () => {
		const profilesDir = getProfilesDir()
		createProfile(profilesDir, "default", { "ghost.jsonc": "{}" })

		const { exitCode, output } = await runGhostMigrate(testDir)

		expect(exitCode).toBe(0)
		expect(output).toContain("Migration complete")

		// Verify migration actually happened
		const profileDir = join(profilesDir, "default")
		expect(existsSync(join(profileDir, "ocx.jsonc"))).toBe(true)
		expect(existsSync(join(profileDir, "ghost.jsonc"))).toBe(false)
	})
})

// =============================================================================
// DRY-RUN TESTS
// =============================================================================

describe("ghost migrate --dry-run", () => {
	let testDir: string
	const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

	beforeEach(async () => {
		testDir = await createTempConfigDir("ghost-migrate-dryrun")
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

	it("should show planned actions without making changes", async () => {
		const profilesDir = getProfilesDir()
		const ghostContent = '{ "bin": "opencode" }'
		createProfile(profilesDir, "default", { "ghost.jsonc": ghostContent })

		const { exitCode, output } = await runGhostMigrate(testDir, ["--dry-run"])

		expect(exitCode).toBe(0)
		expect(output).toContain("[DRY-RUN]")
		expect(output).toContain("default")
		expect(output).toContain("ghost.jsonc")
		expect(output).toContain("ocx.jsonc")

		// Verify files unchanged
		const profileDir = join(profilesDir, "default")
		expect(existsSync(join(profileDir, "ghost.jsonc"))).toBe(true)
		expect(existsSync(join(profileDir, "ocx.jsonc"))).toBe(false)

		// Verify no backup file was created (dry-run should not create any files)
		expect(existsSync(join(profileDir, "ghost.jsonc.bak"))).toBe(false)

		// Verify ghost.jsonc content was unchanged
		expect(readFileSync(join(profileDir, "ghost.jsonc"), "utf-8")).toBe(ghostContent)
	})

	it("should not output 'Migration complete' in dry-run mode", async () => {
		const profilesDir = getProfilesDir()
		createProfile(profilesDir, "default", { "ghost.jsonc": "{}" })

		const { exitCode, output } = await runGhostMigrate(testDir, ["--dry-run"])

		expect(exitCode).toBe(0)
		expect(output).not.toContain("Migration complete")

		// Verify files unchanged
		const profileDir = join(profilesDir, "default")
		expect(existsSync(join(profileDir, "ghost.jsonc"))).toBe(true)
		expect(existsSync(join(profileDir, "ocx.jsonc"))).toBe(false)

		// Verify ghost.jsonc content unchanged
		expect(readFileSync(join(profileDir, "ghost.jsonc"), "utf-8")).toBe("{}")
		// Verify no backup file created
		expect(existsSync(join(profileDir, "ghost.jsonc.bak"))).toBe(false)
	})
})

// =============================================================================
// CONFLICT HANDLING TESTS
// =============================================================================

describe("ghost migrate - conflict handling", () => {
	let testDir: string
	const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

	beforeEach(async () => {
		testDir = await createTempConfigDir("ghost-migrate-conflict")
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

	it("should skip and warn when ocx.jsonc already exists (exit 0)", async () => {
		const profilesDir = getProfilesDir()
		const ghostContent = '{ "bin": "ghost-bin" }'
		const ocxContent = '{ "bin": "ocx-bin" }'
		createProfile(profilesDir, "default", {
			"ghost.jsonc": ghostContent,
			"ocx.jsonc": ocxContent,
		})

		const { exitCode, output } = await runGhostMigrate(testDir)

		// Should succeed (exit 0) but warn about skip
		expect(exitCode).toBe(0)
		expect(output).toContain("skipped")
		expect(output).toContain("default")
		expect(output).toContain("ocx.jsonc already exists")

		// Verify files unchanged
		const profileDir = join(profilesDir, "default")
		expect(existsSync(join(profileDir, "ghost.jsonc"))).toBe(true)
		expect(existsSync(join(profileDir, "ocx.jsonc"))).toBe(true)
		expect(readFileSync(join(profileDir, "ghost.jsonc"), "utf-8")).toBe(ghostContent)
		expect(readFileSync(join(profileDir, "ocx.jsonc"), "utf-8")).toBe(ocxContent)

		// Verify no backup file was created
		expect(existsSync(join(profileDir, "ghost.jsonc.bak"))).toBe(false)
	})

	it("should leave ghost.jsonc unchanged when ocx.jsonc already exists", async () => {
		const profilesDir = getProfilesDir()
		const ghostContent = '{ "bin": "ghost-bin" }'
		const ocxContent = '{ "bin": "ocx-bin" }'
		createProfile(profilesDir, "default", {
			"ghost.jsonc": ghostContent,
			"ocx.jsonc": ocxContent,
		})

		const result = await runGhostMigrate(testDir)

		expect(result.exitCode).toBe(0)

		// Verify both files still exist with original content
		const profileDir = join(profilesDir, "default")
		expect(existsSync(join(profileDir, "ghost.jsonc"))).toBe(true)
		expect(existsSync(join(profileDir, "ocx.jsonc"))).toBe(true)

		const finalGhostContent = readFileSync(join(profileDir, "ghost.jsonc"), "utf-8")
		const finalOcxContent = readFileSync(join(profileDir, "ocx.jsonc"), "utf-8")
		expect(finalGhostContent).toBe(ghostContent)
		expect(finalOcxContent).toBe(ocxContent)

		// Verify no backup file was created
		expect(existsSync(join(profileDir, "ghost.jsonc.bak"))).toBe(false)
	})

	it("should migrate some profiles and skip others with conflicts", async () => {
		const profilesDir = getProfilesDir()
		createProfile(profilesDir, "clean", { "ghost.jsonc": '{ "bin": "clean" }' })
		createProfile(profilesDir, "conflict", {
			"ghost.jsonc": '{ "bin": "conflict-ghost" }',
			"ocx.jsonc": '{ "bin": "conflict-ocx" }',
		})

		const { exitCode, output } = await runGhostMigrate(testDir)

		expect(exitCode).toBe(0)

		// Clean profile should be migrated
		const cleanDir = join(profilesDir, "clean")
		expect(existsSync(join(cleanDir, "ocx.jsonc"))).toBe(true)
		expect(existsSync(join(cleanDir, "ghost.jsonc"))).toBe(false)

		// Verify migrated content is correct
		expect(readFileSync(join(cleanDir, "ocx.jsonc"), "utf-8")).toBe('{ "bin": "clean" }')

		// Conflict profile should be skipped
		const conflictDir = join(profilesDir, "conflict")
		expect(existsSync(join(conflictDir, "ghost.jsonc"))).toBe(true)
		expect(existsSync(join(conflictDir, "ocx.jsonc"))).toBe(true)

		// Output should show both
		expect(output).toContain("clean")
		expect(output).toContain("conflict")
		expect(output).toContain("skipped")

		// Verify conflict profile contents unchanged
		expect(readFileSync(join(conflictDir, "ghost.jsonc"), "utf-8")).toBe(
			'{ "bin": "conflict-ghost" }',
		)
		expect(readFileSync(join(conflictDir, "ocx.jsonc"), "utf-8")).toBe('{ "bin": "conflict-ocx" }')

		// Verify no backup files remain in either profile
		expect(existsSync(join(cleanDir, "ghost.jsonc.bak"))).toBe(false)
		expect(existsSync(join(conflictDir, "ghost.jsonc.bak"))).toBe(false)
	})
})

// =============================================================================
// SYMLINK HANDLING TESTS
// =============================================================================

describe("ghost migrate - symlink handling", () => {
	let testDir: string
	const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

	beforeEach(async () => {
		testDir = await createTempConfigDir("ghost-migrate-symlink")
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

	it("should delete profiles/current symlink", async () => {
		const profilesDir = getProfilesDir()
		createProfile(profilesDir, "default", { "ghost.jsonc": "{}" })

		// Create symlink to default profile
		const currentPath = join(profilesDir, "current")
		const defaultPath = join(profilesDir, "default")
		symlinkSync(defaultPath, currentPath)

		// Verify symlink exists
		expect(existsSync(currentPath)).toBe(true)
		expect(lstatSync(currentPath).isSymbolicLink()).toBe(true)

		const { exitCode, output } = await runGhostMigrate(testDir)

		expect(exitCode).toBe(0)
		expect(output).toContain("current")

		// Symlink should be deleted - use lstatSync to properly detect deleted symlinks
		let symlinkStillExists = true
		try {
			lstatSync(currentPath)
		} catch (e: unknown) {
			if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") {
				symlinkStillExists = false
			} else {
				throw e // Rethrow non-ENOENT errors
			}
		}
		expect(symlinkStillExists).toBe(false)
	})

	it("should skip when profiles/current is a directory (not symlink)", async () => {
		const profilesDir = getProfilesDir()
		createProfile(profilesDir, "default", { "ghost.jsonc": "{}" })

		// Create 'current' as a directory with a marker file
		const currentPath = join(profilesDir, "current")
		mkdirSync(currentPath, { recursive: true })
		writeFileSync(join(currentPath, "marker.txt"), "directory-marker-content")

		const { exitCode, output } = await runGhostMigrate(testDir)

		expect(exitCode).toBe(0)
		expect(output).toContain("skipped")
		expect(output).toContain("directory")

		// Directory should still exist
		expect(existsSync(currentPath)).toBe(true)
		expect(lstatSync(currentPath).isDirectory()).toBe(true)

		// Verify marker file unchanged
		expect(readFileSync(join(currentPath, "marker.txt"), "utf-8")).toBe("directory-marker-content")

		// Verify migration still proceeded for the profile
		const defaultDir = join(profilesDir, "default")
		expect(existsSync(join(defaultDir, "ocx.jsonc"))).toBe(true)
		expect(existsSync(join(defaultDir, "ghost.jsonc"))).toBe(false)
		expect(readFileSync(join(defaultDir, "ocx.jsonc"), "utf-8")).toBe("{}")
	})

	it("should skip when profiles/current is a file (not symlink)", async () => {
		const profilesDir = getProfilesDir()
		createProfile(profilesDir, "default", { "ghost.jsonc": "{}" })

		// Create 'current' as a regular file
		const currentPath = join(profilesDir, "current")
		writeFileSync(currentPath, "this is a regular file")

		const { exitCode, output } = await runGhostMigrate(testDir)

		expect(exitCode).toBe(0)
		expect(output).toContain("skipped")
		expect(output).toContain("file")

		// File should still exist
		expect(existsSync(currentPath)).toBe(true)
		expect(lstatSync(currentPath).isFile()).toBe(true)

		// Verify content unchanged
		expect(readFileSync(currentPath, "utf-8")).toBe("this is a regular file")

		// Verify migration still proceeded for the profile
		const defaultDir = join(profilesDir, "default")
		expect(existsSync(join(defaultDir, "ocx.jsonc"))).toBe(true)
		expect(existsSync(join(defaultDir, "ghost.jsonc"))).toBe(false)
		expect(readFileSync(join(defaultDir, "ocx.jsonc"), "utf-8")).toBe("{}")
	})
})

// =============================================================================
// IDEMPOTENCY TESTS
// =============================================================================

describe("ghost migrate - idempotency", () => {
	let testDir: string
	const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

	beforeEach(async () => {
		testDir = await createTempConfigDir("ghost-migrate-idempotent")
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

	it("should report 'nothing to migrate' on second run", async () => {
		const profilesDir = getProfilesDir()
		createProfile(profilesDir, "default", { "ghost.jsonc": "{}" })

		// First run
		const firstRun = await runGhostMigrate(testDir)
		expect(firstRun.exitCode).toBe(0)
		expect(firstRun.output).toContain("Migration complete")

		// Verify first run actually migrated
		const profileDir = join(profilesDir, "default")
		expect(existsSync(join(profileDir, "ocx.jsonc"))).toBe(true)
		expect(existsSync(join(profileDir, "ghost.jsonc"))).toBe(false)

		// Second run
		const secondRun = await runGhostMigrate(testDir)
		expect(secondRun.exitCode).toBe(0)
		expect(secondRun.output).toContain("Nothing to migrate")

		// Verify ocx.jsonc still exists after second run
		expect(existsSync(join(profileDir, "ocx.jsonc"))).toBe(true)
		expect(existsSync(join(profileDir, "ghost.jsonc"))).toBe(false)
	})

	it("should preserve ocx.jsonc content on second run", async () => {
		const profilesDir = getProfilesDir()
		const originalContent = '{ "bin": "my-opencode", "registries": [] }'
		createProfile(profilesDir, "default", { "ghost.jsonc": originalContent })

		// First run
		await runGhostMigrate(testDir)

		// Second run
		await runGhostMigrate(testDir)

		// Verify content unchanged
		const profileDir = join(profilesDir, "default")
		const finalContent = readFileSync(join(profileDir, "ocx.jsonc"), "utf-8")
		expect(finalContent).toBe(originalContent)

		// Verify ghost.jsonc stayed deleted
		expect(existsSync(join(profileDir, "ghost.jsonc"))).toBe(false)
	})
})

// =============================================================================
// NO-OP TESTS
// =============================================================================

describe("ghost migrate - no-op scenarios", () => {
	let testDir: string
	const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

	beforeEach(async () => {
		testDir = await createTempConfigDir("ghost-migrate-noop")
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

	it("should report nothing to migrate when profiles directory does not exist", async () => {
		// Don't create profiles directory at all
		const { exitCode, output } = await runGhostMigrate(testDir)

		expect(exitCode).toBe(0)
		expect(output).toContain("Nothing to migrate")

		// Verify profiles directory was not created
		expect(existsSync(getProfilesDir())).toBe(false)
	})

	it("should report nothing to migrate when profiles directory is empty", async () => {
		const profilesDir = getProfilesDir()
		mkdirSync(profilesDir, { recursive: true })

		const { exitCode, output } = await runGhostMigrate(testDir)

		expect(exitCode).toBe(0)
		expect(output).toContain("Nothing to migrate")

		// Verify no new files/directories created in profiles dir
		const entries = readdirSync(profilesDir)
		expect(entries.length).toBe(0)
	})

	it("should report nothing to migrate when profiles only have ocx.jsonc", async () => {
		const profilesDir = getProfilesDir()
		createProfile(profilesDir, "default", { "ocx.jsonc": "{}" })
		createProfile(profilesDir, "work", { "ocx.jsonc": "{}" })

		const { exitCode, output } = await runGhostMigrate(testDir)

		expect(exitCode).toBe(0)
		expect(output).toContain("Nothing to migrate")

		// Verify no new ocx.jsonc files were created (existing ones should remain)
		for (const name of ["default", "work"]) {
			expect(existsSync(join(profilesDir, name, "ocx.jsonc"))).toBe(true)
		}

		// Also verify no ghost.jsonc.bak files were created
		for (const name of ["default", "work"]) {
			expect(existsSync(join(profilesDir, name, "ghost.jsonc.bak"))).toBe(false)
		}
	})

	it("should report nothing to migrate when profiles have other files but no ghost.jsonc", async () => {
		const profilesDir = getProfilesDir()
		createProfile(profilesDir, "default", {
			"AGENTS.md": "# Agents",
			"opencode.jsonc": "{}",
		})

		const { exitCode, output } = await runGhostMigrate(testDir)

		expect(exitCode).toBe(0)
		expect(output).toContain("Nothing to migrate")

		// Verify no ocx.jsonc files were created
		expect(existsSync(join(profilesDir, "default", "ocx.jsonc"))).toBe(false)

		// Also verify no ghost.jsonc.bak files were created
		expect(existsSync(join(profilesDir, "default", "ghost.jsonc.bak"))).toBe(false)

		// Verify existing files were preserved unchanged
		expect(readFileSync(join(profilesDir, "default", "AGENTS.md"), "utf-8")).toBe("# Agents")
		expect(readFileSync(join(profilesDir, "default", "opencode.jsonc"), "utf-8")).toBe("{}")
	})
})

// =============================================================================
// BACKUP AND ROLLBACK TESTS
// =============================================================================

describe("ghost migrate - backup and rollback", () => {
	let testDir: string
	const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

	beforeEach(async () => {
		testDir = await createTempConfigDir("ghost-migrate-backup")
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

	it("should skip profile when ghost.jsonc.bak already exists", async () => {
		const profilesDir = getProfilesDir()
		createProfile(profilesDir, "default", {
			"ghost.jsonc": '{ "bin": "test" }',
			"ghost.jsonc.bak": '{ "bin": "old-backup" }',
		})

		const { exitCode, output } = await runGhostMigrate(testDir)

		expect(exitCode).toBe(0)
		expect(output).toContain("skipped")
		expect(output).toContain("backup") // Verify skip is due to backup conflict

		// Verify files unchanged - ghost.jsonc should still exist, ocx.jsonc should NOT be created
		const profileDir = join(profilesDir, "default")
		expect(existsSync(join(profileDir, "ghost.jsonc"))).toBe(true)
		expect(existsSync(join(profileDir, "ghost.jsonc.bak"))).toBe(true)
		expect(existsSync(join(profileDir, "ocx.jsonc"))).toBe(false)

		// Verify content unchanged
		expect(readFileSync(join(profileDir, "ghost.jsonc"), "utf-8")).toBe('{ "bin": "test" }')
		expect(readFileSync(join(profileDir, "ghost.jsonc.bak"), "utf-8")).toBe(
			'{ "bin": "old-backup" }',
		)
	})

	it("should remove backup files after successful migration", async () => {
		const profilesDir = getProfilesDir()
		const originalContent = '{ "bin": "test" }'
		createProfile(profilesDir, "default", { "ghost.jsonc": originalContent })

		await runGhostMigrate(testDir)

		const profileDir = join(profilesDir, "default")
		// ocx.jsonc should exist with correct content
		expect(existsSync(join(profileDir, "ocx.jsonc"))).toBe(true)
		expect(readFileSync(join(profileDir, "ocx.jsonc"), "utf-8")).toBe(originalContent)
		// ghost.jsonc should be gone
		expect(existsSync(join(profileDir, "ghost.jsonc"))).toBe(false)
		// NO backup file should remain
		expect(existsSync(join(profileDir, "ghost.jsonc.bak"))).toBe(false)
	})

	it("should delete symlink even when no profiles need migration", async () => {
		const profilesDir = getProfilesDir()
		// Create profile with only ocx.jsonc (already migrated)
		createProfile(profilesDir, "default", { "ocx.jsonc": '{ "bin": "already-migrated" }' })

		// Create the legacy symlink
		const currentPath = join(profilesDir, "current")
		symlinkSync(join(profilesDir, "default"), currentPath)

		// Verify symlink exists before
		expect(lstatSync(currentPath).isSymbolicLink()).toBe(true)

		const { exitCode, output } = await runGhostMigrate(testDir)

		expect(exitCode).toBe(0)
		// Note: When symlink is deleted but no profiles need migration,
		// output should mention the symlink removal but not "Nothing to migrate"
		// since an action was taken
		expect(output).toContain("current")

		// Verify symlink deleted using lstatSync (not existsSync which follows symlinks)
		let symlinkStillExists = true
		try {
			lstatSync(currentPath)
		} catch (e: unknown) {
			if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") {
				symlinkStillExists = false
			} else {
				throw e
			}
		}
		expect(symlinkStillExists).toBe(false)

		// Verify the existing profile was unchanged
		expect(existsSync(join(profilesDir, "default", "ocx.jsonc"))).toBe(true)
		expect(readFileSync(join(profilesDir, "default", "ocx.jsonc"), "utf-8")).toBe(
			'{ "bin": "already-migrated" }',
		)
		// Verify no ghost.jsonc or backup files were created
		expect(existsSync(join(profilesDir, "default", "ghost.jsonc"))).toBe(false)
		expect(existsSync(join(profilesDir, "default", "ghost.jsonc.bak"))).toBe(false)
	})
})

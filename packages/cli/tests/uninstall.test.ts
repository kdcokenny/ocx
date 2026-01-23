/**
 * Tests for the `ocx uninstall` command.
 * Verifies safe removal of OCX configuration files.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, symlinkSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir, runCLI } from "./helpers"

// =============================================================================
// TEST UTILITIES
// =============================================================================

/**
 * Create a mock global config directory structure.
 * Respects XDG_CONFIG_HOME pattern used by the CLI.
 */
async function createMockGlobalConfig(xdgConfigHome: string): Promise<{
	configDir: string
	profilesDir: string
	ocxConfig: string
}> {
	const configDir = join(xdgConfigHome, "opencode")
	const profilesDir = join(configDir, "profiles")
	const defaultProfile = join(profilesDir, "default")
	const ocxConfig = join(configDir, "ocx.jsonc")

	// Create directory structure
	await mkdir(defaultProfile, { recursive: true })

	// Create files
	await writeFile(ocxConfig, '{\n\t"$schema": "https://ocx.kdco.dev/schemas/ocx.json"\n}')
	await writeFile(join(defaultProfile, "ocx.jsonc"), '{\n\t"registries": {}\n}')
	await writeFile(join(defaultProfile, "opencode.jsonc"), "{}")
	await writeFile(join(defaultProfile, "AGENTS.md"), "# Profile Instructions\n")

	return { configDir, profilesDir, ocxConfig }
}

/**
 * Create a mock local config directory structure.
 * Creates .opencode/ directory with config files.
 */
async function createMockLocalConfig(projectDir: string): Promise<{
	configDir: string
	ocxConfig: string
	legacyOcxConfig: string
	legacyOcxLock: string
}> {
	const configDir = join(projectDir, ".opencode")
	const ocxConfig = join(configDir, "ocx.jsonc")
	const legacyOcxConfig = join(projectDir, "ocx.jsonc")
	const legacyOcxLock = join(projectDir, "ocx.lock")

	// Create directory structure
	await mkdir(configDir, { recursive: true })

	// Create files
	await writeFile(ocxConfig, '{\n\t"registries": {}\n}')
	await writeFile(join(configDir, "opencode.jsonc"), "{}")
	await writeFile(legacyOcxConfig, '// Legacy root-level config\n{\n\t"registries": {}\n}')
	await writeFile(legacyOcxLock, "# Lock file\n")

	return { configDir, ocxConfig, legacyOcxConfig, legacyOcxLock }
}

// =============================================================================
// FLAG PARSING TESTS
// =============================================================================

describe("uninstall: flag parsing", () => {
	let testDir: string

	beforeEach(async () => {
		testDir = await createTempDir("uninstall-flags")
	})

	afterEach(async () => {
		await cleanupTempDir(testDir)
	})

	it("defaults to global scope when no flags provided", async () => {
		await createMockGlobalConfig(testDir)

		const { exitCode, output } = await runCLI(["uninstall", "--dry-run"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		expect(exitCode).toBe(0)
		// Should mention global paths (under XDG_CONFIG_HOME/opencode/)
		expect(output).toContain("opencode")
		expect(output).toContain("profiles")
	})

	it("uses local scope with --local flag", async () => {
		await createMockLocalConfig(testDir)

		const { exitCode, output } = await runCLI(["uninstall", "--local", "--dry-run"], testDir)

		expect(exitCode).toBe(0)
		// Should mention local paths (.opencode/)
		expect(output).toContain(".opencode")
	})

	it("uses both scopes with --all flag", async () => {
		await createMockGlobalConfig(testDir)
		await createMockLocalConfig(testDir)

		const { exitCode, output } = await runCLI(["uninstall", "--all", "--dry-run"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		expect(exitCode).toBe(0)
		// Should mention both global and local paths
		expect(output).toContain("opencode")
		expect(output).toContain(".opencode")
	})

	it("fails with validation error when --local and --all are both set", async () => {
		const { exitCode, output } = await runCLI(["uninstall", "--local", "--all"], testDir)

		expect(exitCode).toBe(2) // VALIDATION_ERROR
		expect(output).toContain("Cannot use --local and --all together")
	})
})

// =============================================================================
// DRY RUN MODE TESTS
// =============================================================================

describe("uninstall: dry run mode", () => {
	let testDir: string

	beforeEach(async () => {
		testDir = await createTempDir("uninstall-dry-run")
	})

	afterEach(async () => {
		await cleanupTempDir(testDir)
	})

	it("shows what would be deleted with --dry-run", async () => {
		await createMockGlobalConfig(testDir)

		const { exitCode, output } = await runCLI(["uninstall", "--dry-run"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		expect(exitCode).toBe(0)
		expect(output).toContain("Would remove")
		// Should list the targets
		expect(output).toContain("profiles")
		expect(output).toContain("ocx.jsonc")
	})

	it("does not delete anything with --dry-run", async () => {
		const { configDir, profilesDir, ocxConfig } = await createMockGlobalConfig(testDir)

		// Verify files exist before
		expect(existsSync(profilesDir)).toBe(true)
		expect(existsSync(ocxConfig)).toBe(true)

		const { exitCode } = await runCLI(["uninstall", "--dry-run"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		expect(exitCode).toBe(0)

		// Files should still exist after dry run
		expect(existsSync(profilesDir)).toBe(true)
		expect(existsSync(ocxConfig)).toBe(true)
		expect(existsSync(configDir)).toBe(true)
	})

	it("reports nothing to remove when no config exists", async () => {
		// Empty testDir - no configs
		const { exitCode, output } = await runCLI(["uninstall", "--dry-run"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		expect(exitCode).toBe(0)
		expect(output).toContain("Nothing to remove")
	})
})

// =============================================================================
// GLOBAL UNINSTALL TESTS
// =============================================================================

describe("uninstall: global scope", () => {
	let testDir: string

	beforeEach(async () => {
		testDir = await createTempDir("uninstall-global")
	})

	afterEach(async () => {
		await cleanupTempDir(testDir)
	})

	it("removes profiles/ directory", async () => {
		const { profilesDir } = await createMockGlobalConfig(testDir)
		expect(existsSync(profilesDir)).toBe(true)

		const { exitCode } = await runCLI(["uninstall"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		expect(exitCode).toBe(0)
		expect(existsSync(profilesDir)).toBe(false)
	})

	it("removes ocx.jsonc file", async () => {
		const { ocxConfig } = await createMockGlobalConfig(testDir)
		expect(existsSync(ocxConfig)).toBe(true)

		const { exitCode } = await runCLI(["uninstall"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		expect(exitCode).toBe(0)
		expect(existsSync(ocxConfig)).toBe(false)
	})

	it("removes root directory only if empty", async () => {
		const { configDir } = await createMockGlobalConfig(testDir)
		expect(existsSync(configDir)).toBe(true)

		const { exitCode } = await runCLI(["uninstall"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		expect(exitCode).toBe(0)
		// Root directory should be removed since it's now empty
		expect(existsSync(configDir)).toBe(false)
	})

	it("leaves root directory if non-OCX files present", async () => {
		const { configDir, profilesDir, ocxConfig } = await createMockGlobalConfig(testDir)

		// Add a non-OCX file to the config directory
		const extraFile = join(configDir, "opencode.jsonc")
		await writeFile(extraFile, '{"model": "claude"}')

		// Verify OCX files exist before uninstall
		expect(existsSync(profilesDir)).toBe(true)
		expect(existsSync(ocxConfig)).toBe(true)

		const { exitCode, output } = await runCLI(["uninstall"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		expect(exitCode).toBe(0)

		// OCX files should be removed
		expect(existsSync(profilesDir)).toBe(false)
		expect(existsSync(ocxConfig)).toBe(false)

		// Root directory should remain (it has opencode.jsonc which is not OCX)
		expect(existsSync(configDir)).toBe(true)
		expect(existsSync(extraFile)).toBe(true)
		// Output should indicate the directory was skipped
		expect(output).toContain("not empty")
	})
})

// =============================================================================
// LOCAL UNINSTALL TESTS
// =============================================================================

describe("uninstall: local scope", () => {
	let testDir: string

	beforeEach(async () => {
		testDir = await createTempDir("uninstall-local")
	})

	afterEach(async () => {
		await cleanupTempDir(testDir)
	})

	it("removes .opencode/ directory", async () => {
		const { configDir } = await createMockLocalConfig(testDir)
		expect(existsSync(configDir)).toBe(true)

		const { exitCode } = await runCLI(["uninstall", "--local"], testDir)

		expect(exitCode).toBe(0)
		expect(existsSync(configDir)).toBe(false)
	})

	it("removes root-level ocx.jsonc if exists", async () => {
		const { legacyOcxConfig } = await createMockLocalConfig(testDir)
		expect(existsSync(legacyOcxConfig)).toBe(true)

		const { exitCode } = await runCLI(["uninstall", "--local"], testDir)

		expect(exitCode).toBe(0)
		expect(existsSync(legacyOcxConfig)).toBe(false)
	})

	it("removes root-level ocx.lock if exists", async () => {
		const { legacyOcxLock } = await createMockLocalConfig(testDir)
		expect(existsSync(legacyOcxLock)).toBe(true)

		const { exitCode } = await runCLI(["uninstall", "--local"], testDir)

		expect(exitCode).toBe(0)
		expect(existsSync(legacyOcxLock)).toBe(false)
	})

	it("removes all local targets together", async () => {
		const { configDir, legacyOcxConfig, legacyOcxLock } = await createMockLocalConfig(testDir)

		// All should exist before
		expect(existsSync(configDir)).toBe(true)
		expect(existsSync(legacyOcxConfig)).toBe(true)
		expect(existsSync(legacyOcxLock)).toBe(true)

		const { exitCode } = await runCLI(["uninstall", "--local"], testDir)

		expect(exitCode).toBe(0)

		// All should be gone after
		expect(existsSync(configDir)).toBe(false)
		expect(existsSync(legacyOcxConfig)).toBe(false)
		expect(existsSync(legacyOcxLock)).toBe(false)
	})
})

// =============================================================================
// MISSING PATHS TESTS
// =============================================================================

describe("uninstall: missing paths", () => {
	let testDir: string

	beforeEach(async () => {
		testDir = await createTempDir("uninstall-missing")
	})

	afterEach(async () => {
		await cleanupTempDir(testDir)
	})

	it("succeeds as no-op when global root does not exist", async () => {
		// No global config created - XDG_CONFIG_HOME/opencode doesn't exist
		const { exitCode, output } = await runCLI(["uninstall"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		expect(exitCode).toBe(0)
		expect(output).toContain("Nothing to remove")
	})

	it("succeeds as no-op when local root does not exist", async () => {
		// Create a .git directory to stop the upward search
		// Otherwise findLocalConfigDir() will find the repo's .opencode/
		await mkdir(join(testDir, ".git"), { recursive: true })

		const { exitCode, output } = await runCLI(["uninstall", "--local"], testDir)

		expect(exitCode).toBe(0)
		expect(output).toContain("Nothing to remove")
	})

	it("silently skips missing individual targets", async () => {
		// Create global config but only with ocx.jsonc (no profiles/)
		const configDir = join(testDir, "opencode")
		await mkdir(configDir, { recursive: true })
		const ocxConfig = join(configDir, "ocx.jsonc")
		await writeFile(ocxConfig, "{}")

		const { exitCode } = await runCLI(["uninstall"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		expect(exitCode).toBe(0)
		// Should succeed and remove what exists
		expect(existsSync(ocxConfig)).toBe(false)
	})

	it("handles mixed existing and missing local files", async () => {
		// Create only .opencode/, no legacy files
		const configDir = join(testDir, ".opencode")
		await mkdir(configDir, { recursive: true })
		await writeFile(join(configDir, "ocx.jsonc"), "{}")

		const { exitCode } = await runCLI(["uninstall", "--local"], testDir)

		expect(exitCode).toBe(0)
		expect(existsSync(configDir)).toBe(false)
	})
})

// =============================================================================
// SAFETY CHECKS TESTS
// =============================================================================

describe("uninstall: safety checks", () => {
	let testDir: string

	beforeEach(async () => {
		testDir = await createTempDir("uninstall-safety")
	})

	afterEach(async () => {
		await cleanupTempDir(testDir)
	})

	it("treats symlink root as no-op (global)", async () => {
		// Create a real directory elsewhere
		const realDir = join(testDir, "real-config")
		await mkdir(realDir, { recursive: true })
		await writeFile(join(realDir, "ocx.jsonc"), "{}")

		// Create XDG_CONFIG_HOME/opencode as a symlink to the real directory
		const xdgConfigHome = join(testDir, "xdg")
		await mkdir(xdgConfigHome, { recursive: true })
		const symlinkPath = join(xdgConfigHome, "opencode")
		symlinkSync(realDir, symlinkPath)

		const { exitCode, output } = await runCLI(["uninstall"], testDir, {
			env: { XDG_CONFIG_HOME: xdgConfigHome },
		})

		// Should report nothing to remove since symlink root is rejected
		// (validateRootDirectory returns false for symlinks)
		expect(exitCode).toBe(0)
		expect(output).toContain("Nothing to remove")
		// The symlink and real directory should remain untouched
		expect(existsSync(symlinkPath)).toBe(true)
		expect(existsSync(realDir)).toBe(true)
	})

	it("treats file root as no-op (global)", async () => {
		// Create XDG_CONFIG_HOME/opencode as a file (not directory)
		const xdgConfigHome = join(testDir, "xdg")
		await mkdir(xdgConfigHome, { recursive: true })
		const filePath = join(xdgConfigHome, "opencode")
		await writeFile(filePath, "not a directory")

		const { exitCode, output } = await runCLI(["uninstall"], testDir, {
			env: { XDG_CONFIG_HOME: xdgConfigHome },
		})

		// Should report nothing to remove since file root is rejected
		expect(exitCode).toBe(0)
		expect(output).toContain("Nothing to remove")
		// The file should remain untouched
		expect(existsSync(filePath)).toBe(true)
	})

	it("removes .opencode symlink without affecting target directory", async () => {
		// Create a real .opencode directory elsewhere
		const realDir = join(testDir, "real-opencode")
		await mkdir(realDir, { recursive: true })
		await writeFile(join(realDir, "ocx.jsonc"), "{}")

		// Create .opencode as a symlink in the project directory
		const projectDir = join(testDir, "project")
		await mkdir(projectDir, { recursive: true })
		const symlinkPath = join(projectDir, ".opencode")
		symlinkSync(realDir, symlinkPath)

		const { exitCode } = await runCLI(["uninstall", "--local"], projectDir)

		// For local uninstall, the root is the parent of .opencode/
		// So this should still work since the parent is a real directory
		// The .opencode symlink is a TARGET, which is handled by kind detection
		expect(exitCode).toBe(0)
		// The symlink should be removed (unlinked)
		expect(existsSync(symlinkPath)).toBe(false)
		// But the real directory should remain
		expect(existsSync(realDir)).toBe(true)
	})
})

// =============================================================================
// SYMLINK HANDLING TESTS
// =============================================================================

describe("uninstall: symlink handling", () => {
	let testDir: string

	beforeEach(async () => {
		testDir = await createTempDir("uninstall-symlinks")
	})

	afterEach(async () => {
		await cleanupTempDir(testDir)
	})

	it("deletes symlink inside root without following it", async () => {
		// Create a real directory outside the config
		const outsideDir = join(testDir, "outside")
		await mkdir(outsideDir, { recursive: true })
		await writeFile(join(outsideDir, "important.txt"), "DO NOT DELETE")

		// Create global config with profiles as a symlink
		const configDir = join(testDir, "opencode")
		await mkdir(configDir, { recursive: true })
		await writeFile(join(configDir, "ocx.jsonc"), "{}")

		// Create profiles as a symlink pointing outside
		const profilesSymlink = join(configDir, "profiles")
		symlinkSync(outsideDir, profilesSymlink)

		const { exitCode } = await runCLI(["uninstall"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		expect(exitCode).toBe(0)

		// The symlink should be removed
		expect(existsSync(profilesSymlink)).toBe(false)

		// The target directory outside should NOT be affected
		expect(existsSync(outsideDir)).toBe(true)
		expect(existsSync(join(outsideDir, "important.txt"))).toBe(true)
	})

	it("removes symlink as target without affecting symlink target contents", async () => {
		// Create a sensitive directory that should never be touched
		const sensitiveDir = join(testDir, "sensitive-data")
		await mkdir(sensitiveDir, { recursive: true })
		await writeFile(join(sensitiveDir, "secrets.txt"), "TOP SECRET")

		// Create local config
		const { configDir } = await createMockLocalConfig(testDir)

		// Add a symlink inside .opencode pointing to sensitive data
		const symlinkPath = join(configDir, "linked-secrets")
		symlinkSync(sensitiveDir, symlinkPath)

		const { exitCode } = await runCLI(["uninstall", "--local"], testDir)

		expect(exitCode).toBe(0)

		// .opencode should be removed (including the symlink)
		expect(existsSync(configDir)).toBe(false)

		// Sensitive directory should remain completely intact
		expect(existsSync(sensitiveDir)).toBe(true)
		const contents = await readFile(join(sensitiveDir, "secrets.txt"), "utf-8")
		expect(contents).toBe("TOP SECRET")
	})

	it("handles nested symlinks correctly", async () => {
		// Create external target directories
		const external1 = join(testDir, "external1")
		const external2 = join(testDir, "external2")
		await mkdir(external1, { recursive: true })
		await mkdir(external2, { recursive: true })
		await writeFile(join(external1, "file1.txt"), "content1")
		await writeFile(join(external2, "file2.txt"), "content2")

		// Create global config
		const configDir = join(testDir, "opencode")
		const profilesDir = join(configDir, "profiles")
		const defaultProfile = join(profilesDir, "default")
		await mkdir(defaultProfile, { recursive: true })
		await writeFile(join(configDir, "ocx.jsonc"), "{}")
		await writeFile(join(defaultProfile, "ocx.jsonc"), "{}")

		// Add symlinks inside profile
		symlinkSync(external1, join(defaultProfile, "link1"))
		symlinkSync(external2, join(defaultProfile, "link2"))

		const { exitCode } = await runCLI(["uninstall"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		expect(exitCode).toBe(0)

		// Config should be removed
		expect(existsSync(configDir)).toBe(false)

		// External directories should remain intact
		expect(existsSync(external1)).toBe(true)
		expect(existsSync(external2)).toBe(true)
		expect(await readFile(join(external1, "file1.txt"), "utf-8")).toBe("content1")
		expect(await readFile(join(external2, "file2.txt"), "utf-8")).toBe("content2")
	})
})

// =============================================================================
// ALL SCOPE (--all) TESTS
// =============================================================================

describe("uninstall: --all scope", () => {
	let testDir: string

	beforeEach(async () => {
		testDir = await createTempDir("uninstall-all")
	})

	afterEach(async () => {
		await cleanupTempDir(testDir)
	})

	it("removes both global and local configs with --all", async () => {
		// Create both global and local configs
		const { profilesDir, ocxConfig: globalOcx } = await createMockGlobalConfig(testDir)
		const {
			configDir: localDir,
			legacyOcxConfig,
			legacyOcxLock,
		} = await createMockLocalConfig(testDir)

		// Verify all exist before
		expect(existsSync(profilesDir)).toBe(true)
		expect(existsSync(globalOcx)).toBe(true)
		expect(existsSync(localDir)).toBe(true)
		expect(existsSync(legacyOcxConfig)).toBe(true)
		expect(existsSync(legacyOcxLock)).toBe(true)

		const { exitCode, output } = await runCLI(["uninstall", "--all"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		expect(exitCode).toBe(0)
		expect(output).toContain("Successfully removed")

		// All should be gone
		expect(existsSync(profilesDir)).toBe(false)
		expect(existsSync(globalOcx)).toBe(false)
		expect(existsSync(localDir)).toBe(false)
		expect(existsSync(legacyOcxConfig)).toBe(false)
		expect(existsSync(legacyOcxLock)).toBe(false)
	})

	it("works when only global config exists with --all", async () => {
		const { profilesDir, ocxConfig } = await createMockGlobalConfig(testDir)

		const { exitCode } = await runCLI(["uninstall", "--all"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		expect(exitCode).toBe(0)
		expect(existsSync(profilesDir)).toBe(false)
		expect(existsSync(ocxConfig)).toBe(false)
	})

	it("works when only local config exists with --all", async () => {
		const { configDir, legacyOcxConfig, legacyOcxLock } = await createMockLocalConfig(testDir)

		const { exitCode } = await runCLI(["uninstall", "--all"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		expect(exitCode).toBe(0)
		expect(existsSync(configDir)).toBe(false)
		expect(existsSync(legacyOcxConfig)).toBe(false)
		expect(existsSync(legacyOcxLock)).toBe(false)
	})
})

// =============================================================================
// SUCCESS OUTPUT TESTS
// =============================================================================

describe("uninstall: output messages", () => {
	let testDir: string

	beforeEach(async () => {
		testDir = await createTempDir("uninstall-output")
	})

	afterEach(async () => {
		await cleanupTempDir(testDir)
	})

	it("reports successful removal with item count", async () => {
		await createMockGlobalConfig(testDir)

		const { exitCode, output } = await runCLI(["uninstall"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		expect(exitCode).toBe(0)
		expect(output).toMatch(/Successfully removed \d+ items?/)
	})

	it("lists items to be removed in output", async () => {
		await createMockGlobalConfig(testDir)

		const { exitCode, output } = await runCLI(["uninstall"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		expect(exitCode).toBe(0)
		expect(output).toContain("Removing")
	})

	it("shows readable display paths in output", async () => {
		// This test verifies display paths are generated correctly
		await createMockGlobalConfig(testDir)

		const { exitCode, output } = await runCLI(["uninstall", "--dry-run"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		expect(exitCode).toBe(0)
		// Should show "Would remove X items:" with readable paths
		expect(output).toContain("Would remove")
		// Should contain opencode path references
		expect(output).toContain("opencode")
		expect(output).toContain("profiles")
	})
})

/**
 * Self Uninstall Command Tests
 *
 * Comprehensive tests for `ocx self uninstall` command covering:
 * - Dry-run mode
 * - Config removal
 * - Missing paths handling
 * - Safety checks (symlink detection)
 * - Symlink handling during removal
 * - Output message verification
 * - Package-managed install detection
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { logger } from "../src/utils/logger.js"
import { cleanupTempDir, createTempDir, runCLI, runCLIIsolated } from "./helpers"

let selfUninstallImportCounter = 0

async function importSelfUninstallCommandModule() {
	const cacheBuster = selfUninstallImportCounter++
	return import(`../src/commands/self/uninstall.js?test=${cacheBuster}`)
}

// =============================================================================
// Test Setup Helpers
// =============================================================================

/**
 * Create a mock global config structure in a temp directory.
 * @param testDir - Base temp directory (will be used as XDG_CONFIG_HOME)
 * @returns Paths to created items
 */
function createMockGlobalConfig(testDir: string): {
	root: string
	profilesDir: string
	defaultProfile: string
	ocxConfig: string
} {
	const root = join(testDir, "ocx")
	const profilesDir = join(root, "profiles")
	const defaultProfile = join(profilesDir, "default")
	const ocxConfig = join(root, "ocx.jsonc")

	mkdirSync(defaultProfile, { recursive: true })
	writeFileSync(ocxConfig, JSON.stringify({ registries: {} }, null, 2))
	writeFileSync(
		join(defaultProfile, "ocx.jsonc"),
		JSON.stringify({ componentPath: "test" }, null, 2),
	)
	writeFileSync(join(defaultProfile, "opencode.jsonc"), JSON.stringify({}, null, 2))
	writeFileSync(join(defaultProfile, "AGENTS.md"), "# Test Agent\n")

	return { root, profilesDir, defaultProfile, ocxConfig }
}

// =============================================================================
// Dry-run Mode Tests
// =============================================================================

describe("ocx self uninstall --dry-run", () => {
	let testDir: string

	beforeEach(async () => {
		testDir = await createTempDir("uninstall-dry-run")
	})

	afterEach(async () => {
		await cleanupTempDir(testDir)
	})

	it("shows what would be removed without making changes", async () => {
		const { root, profilesDir, ocxConfig } = createMockGlobalConfig(testDir)

		const { exitCode, stdout } = await runCLI(["self", "uninstall", "--dry-run"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		expect(exitCode).toBe(0)
		expect(stdout).toContain("DRY RUN")
		expect(stdout).toContain("Would remove")

		// Files should still exist
		expect(existsSync(root)).toBe(true)
		expect(existsSync(profilesDir)).toBe(true)
		expect(existsSync(ocxConfig)).toBe(true)
	})

	it("lists profiles/ directory in output", async () => {
		createMockGlobalConfig(testDir)

		const { exitCode, stdout } = await runCLI(["self", "uninstall", "--dry-run"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		expect(exitCode).toBe(0)
		expect(stdout).toContain("profiles")
		expect(stdout).toContain("kind: directory")
	})

	it("lists ocx.jsonc file in output", async () => {
		createMockGlobalConfig(testDir)

		const { exitCode, stdout } = await runCLI(["self", "uninstall", "--dry-run"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		expect(exitCode).toBe(0)
		expect(stdout).toContain("ocx.jsonc")
		expect(stdout).toContain("kind: file")
	})

	it("exits with code 0", async () => {
		createMockGlobalConfig(testDir)

		const { exitCode } = await runCLI(["self", "uninstall", "--dry-run"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		expect(exitCode).toBe(0)
	})

	it("shows root directory removal note (if empty)", async () => {
		createMockGlobalConfig(testDir)

		const { exitCode, stdout } = await runCLIIsolated(["self", "uninstall", "--dry-run"], testDir)

		expect(exitCode).toBe(0)
		// Root is shown with "deleteIfEmpty: true" note
		expect(stdout).toContain("ocx")
		expect(stdout).toContain("deleteIfEmpty: true")
	})
})

// =============================================================================
// Config Uninstall Tests
// =============================================================================

describe("ocx self uninstall (config removal)", () => {
	let testDir: string

	beforeEach(async () => {
		testDir = await createTempDir("uninstall-config")
	})

	afterEach(async () => {
		await cleanupTempDir(testDir)
	})

	it("removes profiles/ directory", async () => {
		const { profilesDir } = createMockGlobalConfig(testDir)

		// Precondition
		expect(existsSync(profilesDir)).toBe(true)

		const { output } = await runCLI(["self", "uninstall"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		// Postcondition
		expect(existsSync(profilesDir)).toBe(false)
		expect(output).toContain("Removed")
		expect(output).toContain("profiles")
	})

	it("removes ocx.jsonc file", async () => {
		const { ocxConfig } = createMockGlobalConfig(testDir)

		// Precondition
		expect(existsSync(ocxConfig)).toBe(true)

		const { output } = await runCLI(["self", "uninstall"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		// Postcondition
		expect(existsSync(ocxConfig)).toBe(false)
		expect(output).toContain("Removed")
		expect(output).toContain("ocx.jsonc")
	})

	it("removes root directory when empty after cleanup", async () => {
		const { root } = createMockGlobalConfig(testDir)

		// Precondition
		expect(existsSync(root)).toBe(true)

		await runCLI(["self", "uninstall"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		// Root should be removed since it's empty after removing profiles/ and ocx.jsonc
		expect(existsSync(root)).toBe(false)
	})

	it("leaves root directory if unexpected files exist", async () => {
		const { root } = createMockGlobalConfig(testDir)

		// Add an unexpected file
		const unexpectedFile = join(root, "unexpected.txt")
		writeFileSync(unexpectedFile, "do not delete me")

		// Precondition
		expect(existsSync(root)).toBe(true)
		expect(existsSync(unexpectedFile)).toBe(true)

		const { output } = await runCLI(["self", "uninstall"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		// Root should remain because it's not empty
		expect(existsSync(root)).toBe(true)
		expect(existsSync(unexpectedFile)).toBe(true)
		expect(output).toContain("not empty")
	})

	it("leaves unexpected files untouched", async () => {
		const { root, profilesDir, ocxConfig } = createMockGlobalConfig(testDir)

		// Add unexpected files in various locations
		const unexpectedInRoot = join(root, "custom-settings.json")
		writeFileSync(unexpectedInRoot, JSON.stringify({ custom: true }))

		await runCLIIsolated(["self", "uninstall"], testDir)

		// Known OCX items should be removed
		expect(existsSync(profilesDir)).toBe(false)
		expect(existsSync(ocxConfig)).toBe(false)

		// Unexpected files remain
		expect(existsSync(unexpectedInRoot)).toBe(true)
	})
})

// =============================================================================
// Missing Paths Tests
// =============================================================================

describe("ocx self uninstall (missing paths)", () => {
	let testDir: string

	beforeEach(async () => {
		testDir = await createTempDir("uninstall-missing")
	})

	afterEach(async () => {
		await cleanupTempDir(testDir)
	})

	it("exits 0 with 'Nothing to remove' when no global config exists", async () => {
		// Don't create any config structure

		const { exitCode, output } = await runCLIIsolated(["self", "uninstall"], testDir, {
			XDG_CONFIG_HOME: testDir,
		})

		expect(exitCode).toBe(0)
		expect(output).toContain("Nothing to remove")
	})

	it("handles partially missing files gracefully (only profiles/)", async () => {
		const root = join(testDir, "ocx")
		const profilesDir = join(root, "profiles", "default")
		mkdirSync(profilesDir, { recursive: true })
		writeFileSync(join(profilesDir, "ocx.jsonc"), "{}")
		// Note: no ocx.jsonc at root level

		const { exitCode, output } = await runCLIIsolated(["self", "uninstall"], testDir, {
			XDG_CONFIG_HOME: testDir,
		})

		expect(exitCode).toBe(0)
		expect(output).toContain("Removed")
		expect(existsSync(profilesDir)).toBe(false)
	})

	it("handles partially missing files gracefully (only ocx.jsonc)", async () => {
		const root = join(testDir, "ocx")
		mkdirSync(root, { recursive: true })
		const ocxConfig = join(root, "ocx.jsonc")
		writeFileSync(ocxConfig, JSON.stringify({ registries: {} }))
		// Note: no profiles/ directory

		const { exitCode, output } = await runCLIIsolated(["self", "uninstall"], testDir, {
			XDG_CONFIG_HOME: testDir,
		})

		expect(exitCode).toBe(0)
		expect(output).toContain("Removed")
		expect(existsSync(ocxConfig)).toBe(false)
	})

	it("exits 0 and removes empty root directory", async () => {
		const root = join(testDir, "ocx")
		mkdirSync(root, { recursive: true })
		// Empty root - nothing inside

		// Precondition
		expect(existsSync(root)).toBe(true)

		const { exitCode, output } = await runCLIIsolated(["self", "uninstall"], testDir, {
			XDG_CONFIG_HOME: testDir,
		})

		expect(exitCode).toBe(0)
		// Empty root is still a target - gets removed
		expect(output).toContain("Removed")
		expect(existsSync(root)).toBe(false)
	})
})

// =============================================================================
// Safety Check Tests
// =============================================================================

describe("ocx self uninstall (safety checks)", () => {
	let testDir: string

	beforeEach(async () => {
		testDir = await createTempDir("uninstall-safety")
	})

	afterEach(async () => {
		await cleanupTempDir(testDir)
	})

	it("rejects symlink as root directory and exits with code 2", async () => {
		// Create real config directory elsewhere
		const realConfigDir = join(testDir, "real-ocx")
		mkdirSync(realConfigDir, { recursive: true })
		writeFileSync(join(realConfigDir, "ocx.jsonc"), "{}")

		// Create symlink where config root would be
		const symlinkRoot = join(testDir, "ocx")
		symlinkSync(realConfigDir, symlinkRoot)

		const { exitCode, output } = await runCLI(["self", "uninstall"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		expect(exitCode).toBe(2)
		expect(output).toContain("Safety error")
		expect(output).toContain("symlink")

		// Real directory should be untouched
		expect(existsSync(realConfigDir)).toBe(true)
		expect(existsSync(join(realConfigDir, "ocx.jsonc"))).toBe(true)
	})

	it("rejects symlink root in dry-run mode too", async () => {
		// Create real config directory elsewhere
		const realConfigDir = join(testDir, "real-ocx")
		mkdirSync(realConfigDir, { recursive: true })
		writeFileSync(join(realConfigDir, "ocx.jsonc"), "{}")

		// Create symlink where config root would be
		const symlinkRoot = join(testDir, "ocx")
		symlinkSync(realConfigDir, symlinkRoot)

		const { exitCode, output } = await runCLI(["self", "uninstall", "--dry-run"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		expect(exitCode).toBe(2)
		expect(output).toContain("Safety error")
	})
})

// =============================================================================
// Symlink Handling Tests
// =============================================================================

describe("ocx self uninstall (symlink handling)", () => {
	let testDir: string

	beforeEach(async () => {
		testDir = await createTempDir("uninstall-symlinks")
	})

	afterEach(async () => {
		await cleanupTempDir(testDir)
	})

	it("unlinks symlinks without following them", async () => {
		const { profilesDir } = createMockGlobalConfig(testDir)

		// Create a symlink target outside config
		const externalTarget = join(testDir, "external-data")
		mkdirSync(externalTarget, { recursive: true })
		const externalFile = join(externalTarget, "important.txt")
		writeFileSync(externalFile, "do not delete")

		// Create a symlink inside profiles pointing to external target
		const symlinkPath = join(profilesDir, "external-link")
		symlinkSync(externalTarget, symlinkPath)

		// Precondition
		expect(existsSync(externalTarget)).toBe(true)
		expect(existsSync(externalFile)).toBe(true)

		await runCLI(["self", "uninstall"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		// Symlink target should be preserved
		expect(existsSync(externalTarget)).toBe(true)
		expect(existsSync(externalFile)).toBe(true)

		// The symlink itself should be gone (along with profiles/)
		expect(existsSync(profilesDir)).toBe(false)
	})

	it("does not delete symlink targets", async () => {
		const { root } = createMockGlobalConfig(testDir)

		// Create external directory with valuable data
		const externalDir = join(testDir, "valuable-data")
		mkdirSync(externalDir, { recursive: true })
		writeFileSync(join(externalDir, "critical.txt"), "critical data")

		// Replace ocx.jsonc with a symlink (edge case)
		const ocxConfig = join(root, "ocx.jsonc")
		await rm(ocxConfig) // Remove real file
		const externalConfig = join(externalDir, "real-config.jsonc")
		writeFileSync(externalConfig, JSON.stringify({ external: true }))
		symlinkSync(externalConfig, ocxConfig)

		await runCLI(["self", "uninstall"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		// External data should be preserved
		expect(existsSync(externalDir)).toBe(true)
		expect(existsSync(externalConfig)).toBe(true)
		expect(existsSync(join(externalDir, "critical.txt"))).toBe(true)
	})
})

// =============================================================================
// Output Message Tests
// =============================================================================

describe("ocx self uninstall (output messages)", () => {
	let testDir: string

	beforeEach(async () => {
		testDir = await createTempDir("uninstall-messages")
	})

	afterEach(async () => {
		await cleanupTempDir(testDir)
	})

	it("verifies 'Nothing to remove' message format", async () => {
		const { exitCode, output } = await runCLIIsolated(["self", "uninstall"], testDir, {
			XDG_CONFIG_HOME: testDir,
		})

		expect(exitCode).toBe(0)
		expect(output).toContain("Nothing to remove")
		expect(output).toContain("not installed")
	})

	it("verifies success message format for removed files", async () => {
		createMockGlobalConfig(testDir)

		const { exitCode, output } = await runCLIIsolated(["self", "uninstall"], testDir, {
			XDG_CONFIG_HOME: testDir,
		})

		expect(exitCode).toBe(0)
		// Check for success indicators
		expect(output).toContain("Removed")
	})

	it("verifies skip message format for non-empty root", async () => {
		const { root } = createMockGlobalConfig(testDir)

		// Add unexpected file to keep root non-empty
		writeFileSync(join(root, "keep-me.txt"), "sentinel")

		const { output } = await runCLI(["self", "uninstall"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		expect(output).toContain("not empty")
		expect(output).toContain("Kept")
	})

	it("includes tildified paths in output", async () => {
		createMockGlobalConfig(testDir)

		const { output } = await runCLI(["self", "uninstall", "--dry-run"], testDir, {
			env: { XDG_CONFIG_HOME: testDir },
		})

		// In test environment XDG_CONFIG_HOME is set to testDir,
		// so paths won't have ~ but should be present
		expect(output).toContain("ocx")
		expect(output).toContain("profiles")
	})
})

// =============================================================================
// Package-Managed Installation Tests
// =============================================================================

describe("ocx self uninstall (package-managed)", () => {
	let testDir: string

	beforeEach(async () => {
		testDir = await createTempDir("uninstall-pkg-managed")
	})

	afterEach(async () => {
		await cleanupTempDir(testDir)
	})

	it("shows package manager removal command in dry-run", async () => {
		const { profilesDir, ocxConfig } = createMockGlobalConfig(testDir)

		const { exitCode, output } = await runCLIIsolated(["self", "uninstall", "--dry-run"], testDir, {
			npm_config_user_agent: "pnpm/8.0.0 node/v20.0.0",
		})

		expect(exitCode).toBe(0)
		expect(output).toContain("pnpm")
		expect(output).toContain("remove")
		// Dry-run should NOT remove anything
		expect(existsSync(profilesDir)).toBe(true)
		expect(existsSync(ocxConfig)).toBe(true)
	})

	it("prints removal instructions for package-managed installs", async () => {
		const { profilesDir, ocxConfig } = createMockGlobalConfig(testDir)

		const { exitCode, output } = await runCLIIsolated(["self", "uninstall"], testDir, {
			npm_config_user_agent: "npm/9.0.0 node/v20.0.0 darwin arm64",
		})

		expect(exitCode).toBe(1)
		expect(output).toContain("npm")
		expect(output).toContain("uninstall")
		// Config files should still be removed
		expect(existsSync(profilesDir)).toBe(false)
		expect(existsSync(ocxConfig)).toBe(false)
	})

	it("still removes config files even when package-managed", async () => {
		const { profilesDir, ocxConfig } = createMockGlobalConfig(testDir)

		// Preconditions
		expect(existsSync(profilesDir)).toBe(true)
		expect(existsSync(ocxConfig)).toBe(true)

		await runCLIIsolated(["self", "uninstall"], testDir, {
			npm_config_user_agent: "npm/9.0.0 node/v20.0.0",
		})

		// Config files should be removed regardless of install method
		expect(existsSync(profilesDir)).toBe(false)
		expect(existsSync(ocxConfig)).toBe(false)
	})

	describe("package manager command output", () => {
		const packageManagers = [
			{ method: "npm", userAgent: "npm/9.0.0 node/v20.0.0", command: "npm uninstall -g" },
			{ method: "pnpm", userAgent: "pnpm/8.0.0 node/v20.0.0", command: "pnpm remove -g" },
			{ method: "bun", userAgent: "bun/1.0.0", command: "bun remove -g" },
			{ method: "yarn", userAgent: "yarn/1.22.0 node/v20.0.0", command: "yarn global remove" },
		]

		for (const { method, userAgent, command } of packageManagers) {
			it(`prints correct uninstall command for ${method}`, async () => {
				createMockGlobalConfig(testDir)

				const { exitCode, output } = await runCLIIsolated(["self", "uninstall"], testDir, {
					npm_config_user_agent: userAgent,
				})

				expect(exitCode).toBe(1)
				expect(output).toContain(command)
			})
		}
	})
})

// =============================================================================
// Exit Code Tests
// =============================================================================

describe("ocx self uninstall (exit codes)", () => {
	let testDir: string

	beforeEach(async () => {
		testDir = await createTempDir("uninstall-exit-codes")
	})

	afterEach(async () => {
		await cleanupTempDir(testDir)
	})

	it("exits 0 on successful config removal (curl install)", async () => {
		createMockGlobalConfig(testDir)

		const { exitCode } = await runCLIIsolated(["self", "uninstall"], testDir)
		// runCLIIsolated defaults npm_config_user_agent to "" (curl)

		expect(exitCode).toBe(0)
	})

	it("exits 1 on config removal when package-managed", async () => {
		createMockGlobalConfig(testDir)

		const { exitCode, output } = await runCLIIsolated(["self", "uninstall"], testDir, {
			npm_config_user_agent: "npm/9.0.0 node/v20.0.0",
		})

		expect(exitCode).toBe(1)
		expect(output).toContain("npm")
	})

	it("exits 0 when nothing to remove", async () => {
		const { exitCode } = await runCLIIsolated(["self", "uninstall"], testDir)

		expect(exitCode).toBe(0)
	})

	it("exits 2 on safety error (symlink root)", async () => {
		const realDir = join(testDir, "real")
		mkdirSync(realDir, { recursive: true })
		symlinkSync(realDir, join(testDir, "ocx"))

		const { exitCode } = await runCLIIsolated(["self", "uninstall"], testDir)

		expect(exitCode).toBe(2)
	})

	it("exits 0 in dry-run mode with existing config", async () => {
		createMockGlobalConfig(testDir)

		const { exitCode } = await runCLIIsolated(["self", "uninstall", "--dry-run"], testDir)

		expect(exitCode).toBe(0)
	})
})

// =============================================================================
// Idempotency Tests
// =============================================================================

describe("ocx self uninstall (idempotency)", () => {
	let testDir: string

	beforeEach(async () => {
		testDir = await createTempDir("uninstall-idempotent")
	})

	afterEach(async () => {
		await cleanupTempDir(testDir)
	})

	it("can be run multiple times safely", async () => {
		createMockGlobalConfig(testDir)

		// First run - removes config (curl install)
		const result1 = await runCLIIsolated(["self", "uninstall"], testDir)
		expect(result1.exitCode).toBe(0)

		// Second run - nothing to remove
		const result2 = await runCLIIsolated(["self", "uninstall"], testDir)
		expect(result2.exitCode).toBe(0)
		expect(result2.output).toContain("Nothing to remove")

		// Third run - still safe
		const result3 = await runCLIIsolated(["self", "uninstall"], testDir)
		expect(result3.exitCode).toBe(0)
	})

	it("isolation prevents env leakage from host", async () => {
		createMockGlobalConfig(testDir)

		// Even if host has npm_config_user_agent set, isolated mode ignores it
		// runCLIIsolated defaults npm_config_user_agent to "" (curl behavior)
		const { exitCode } = await runCLIIsolated(["self", "uninstall"], testDir)

		// Should exit 0 (curl behavior), proving isolation works
		expect(exitCode).toBe(0)
	})
})

describe("ocx self uninstall --json win32 output hygiene", () => {
	let testDir: string

	afterEach(async () => {
		mock.restore()
		if (testDir) {
			await cleanupTempDir(testDir)
		}
	})

	it("does not emit human logger output on win32 JSON path", async () => {
		testDir = await createTempDir("uninstall-json-win32")
		createMockGlobalConfig(testDir)

		const consoleLogSpy = spyOn(console, "log").mockImplementation(() => {})
		const loggerInfoSpy = spyOn(logger, "info").mockImplementation(() => {})

		const originalPlatform = process.platform
		const originalXdg = process.env.XDG_CONFIG_HOME
		const originalNpmUserAgent = process.env.npm_config_user_agent
		Object.defineProperty(process, "platform", { value: "win32" })
		process.env.XDG_CONFIG_HOME = testDir
		process.env.npm_config_user_agent = ""

		const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`EXIT:${code ?? 0}`)
		}) as (...args: [number?]) => never)

		try {
			const { runUninstall } = await importSelfUninstallCommandModule()
			await expect(runUninstall({ json: true })).rejects.toThrow("EXIT:0")
		} finally {
			exitSpy.mockRestore()
			Object.defineProperty(process, "platform", { value: originalPlatform })
			if (originalXdg === undefined) {
				delete process.env.XDG_CONFIG_HOME
			} else {
				process.env.XDG_CONFIG_HOME = originalXdg
			}
			if (originalNpmUserAgent === undefined) {
				delete process.env.npm_config_user_agent
			} else {
				process.env.npm_config_user_agent = originalNpmUserAgent
			}
		}

		expect(loggerInfoSpy).not.toHaveBeenCalled()
		expect(consoleLogSpy).toHaveBeenCalledTimes(1)

		const jsonCalls = consoleLogSpy.mock.calls as Array<[unknown]>
		const payloadRaw = jsonCalls[0]?.[0]
		const payload =
			typeof payloadRaw === "string"
				? (JSON.parse(payloadRaw) as { success?: boolean })
				: ((payloadRaw ?? {}) as { success?: boolean })
		expect(payload.success).toBe(true)
	})
})

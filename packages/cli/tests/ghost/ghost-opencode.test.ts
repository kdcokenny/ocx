/**
 * Ghost OpenCode Passthrough Tests
 *
 * Tests for the `ocx ghost opencode` command:
 * - Sets OPENCODE_CONFIG_CONTENT env var correctly
 * - Passes all arguments through to opencode
 *
 * Note: These tests use a mock script instead of the real opencode binary
 * to verify environment variable passing and argument forwarding.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { getGhostConfigPath, getGhostOpencodeConfigPath } from "../../src/ghost/config.js"
import { getProfileGhostConfig } from "../../src/profile/paths.js"

// =============================================================================
// HELPERS
// =============================================================================

interface CLIResult {
	stdout: string
	stderr: string
	output: string
	exitCode: number
}

async function createTempConfigDir(name: string): Promise<string> {
	const dir = join(import.meta.dir, "fixtures", `tmp-${name}-${Date.now()}`)
	await mkdir(dir, { recursive: true })
	return dir
}

async function cleanupTempDir(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true })
}

async function runGhostCLI(
	args: string[],
	env: Record<string, string> = {},
	cwd?: string,
): Promise<CLIResult> {
	const indexPath = join(import.meta.dir, "..", "..", "src/index.ts")

	const proc = Bun.spawn(["bun", "run", indexPath, "ghost", ...args], {
		env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...env },
		stdout: "pipe",
		stderr: "pipe",
		...(cwd && { cwd }),
	})

	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	])

	const exitCode = await proc.exited

	return {
		stdout,
		stderr,
		output: stdout + stderr,
		exitCode,
	}
}

/**
 * Create a mock opencode script that outputs its environment and arguments.
 * This allows us to verify the correct env vars and args are passed.
 */
async function createMockOpencode(dir: string): Promise<string> {
	const scriptPath = join(dir, "opencode")
	const script = `#!/bin/bash
# Output the OPENCODE_CONFIG_CONTENT env var as JSON
echo "OPENCODE_CONFIG_CONTENT=$OPENCODE_CONFIG_CONTENT"
echo "ARGS=$@"
exit 0
`
	await Bun.write(scriptPath, script)
	await Bun.spawn(["chmod", "+x", scriptPath]).exited
	return dir
}

// =============================================================================
// TESTS
// =============================================================================

describe("ocx ghost opencode", () => {
	let testDir: string
	let mockBinDir: string
	let projectDir: string // Clean project directory for running tests
	const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

	beforeEach(async () => {
		testDir = await createTempConfigDir("ghost-opencode")
		mockBinDir = await createTempConfigDir("mock-bin")
		// Create a clean project directory for tests to run from (avoids file limit issues)
		projectDir = await createTempConfigDir("ghost-project")
		await Bun.write(join(projectDir, "example.txt"), "test content")
		await createMockOpencode(mockBinDir)
		// Initialize ghost config
		await runGhostCLI(["init"], { XDG_CONFIG_HOME: testDir })
		process.env.XDG_CONFIG_HOME = testDir
	})

	afterEach(async () => {
		if (originalXdgConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME
		} else {
			process.env.XDG_CONFIG_HOME = originalXdgConfigHome
		}
		await cleanupTempDir(testDir)
		await cleanupTempDir(mockBinDir)
		await cleanupTempDir(projectDir)
	})

	it("should fail if ghost mode is not initialized", async () => {
		const freshDir = await createTempConfigDir("ghost-opencode-fresh")

		const { exitCode, output } = await runGhostCLI(["opencode"], {
			XDG_CONFIG_HOME: freshDir,
			PATH: `${mockBinDir}:${process.env.PATH}`,
		})

		expect(exitCode).not.toBe(0)
		expect(output).toContain("not initialized")

		await cleanupTempDir(freshDir)
	})

	it("should warn when opencode config is empty", async () => {
		// Write ghost.jsonc (required for ghost mode to be initialized)
		const configPath = getGhostConfigPath()
		await Bun.write(configPath, '{"registries": {}}')
		// Remove opencode.jsonc if it exists (created by ghost init in beforeEach)
		const opencodeConfigPath = getGhostOpencodeConfigPath()
		await rm(opencodeConfigPath, { force: true })

		const { output } = await runGhostCLI(["opencode"], {
			XDG_CONFIG_HOME: testDir,
			PATH: `${mockBinDir}:${process.env.PATH}`,
		})

		expect(output).toContain("opencode.jsonc")
	})

	it("should set OPENCODE_CONFIG_CONTENT env var correctly", async () => {
		// Write ghost.jsonc (required for ghost mode to be initialized)
		const configPath = getGhostConfigPath()
		await Bun.write(configPath, '{"registries": {}}')

		// Write opencode.jsonc with settings
		const opencodeConfigPath = getGhostOpencodeConfigPath()
		const opencodeConfig = {
			model: "anthropic/claude-sonnet-4-20250514",
			theme: "dark",
		}
		await Bun.write(opencodeConfigPath, JSON.stringify(opencodeConfig))

		const { output } = await runGhostCLI(
			["opencode"],
			{
				XDG_CONFIG_HOME: testDir,
				PATH: `${mockBinDir}:${process.env.PATH}`,
			},
			projectDir,
		)

		// The mock script outputs OPENCODE_CONFIG_CONTENT
		expect(output).toContain("OPENCODE_CONFIG_CONTENT=")

		// Extract the JSON from the output
		const match = output.match(/OPENCODE_CONFIG_CONTENT=(.+)/)
		if (match) {
			const configContent = JSON.parse(match[1])
			expect(configContent.model).toBe("anthropic/claude-sonnet-4-20250514")
			expect(configContent.theme).toBe("dark")
		}
	})

	it("should pass all arguments through to opencode", async () => {
		// Write ghost.jsonc (required for ghost mode)
		const configPath = getGhostConfigPath()
		await Bun.write(configPath, '{"registries": {}}')

		// Write opencode.jsonc
		const opencodeConfigPath = getGhostOpencodeConfigPath()
		await Bun.write(opencodeConfigPath, '{"model": "test"}')

		// Use arguments that won't be intercepted by Commander
		const { output } = await runGhostCLI(
			["opencode", "--custom-flag", "arg1", "arg2"],
			{
				XDG_CONFIG_HOME: testDir,
				PATH: `${mockBinDir}:${process.env.PATH}`,
			},
			projectDir,
		)

		// The mock script outputs the args
		expect(output).toContain("ARGS=--custom-flag arg1 arg2")
	})

	it("should handle complex arguments with spaces", async () => {
		// Write ghost.jsonc (required for ghost mode)
		const configPath = getGhostConfigPath()
		await Bun.write(configPath, '{"registries": {}}')

		// Write empty opencode.jsonc
		const opencodeConfigPath = getGhostOpencodeConfigPath()
		await Bun.write(opencodeConfigPath, "{}")

		const { output } = await runGhostCLI(
			["opencode", "--message", "hello world"],
			{
				XDG_CONFIG_HOME: testDir,
				PATH: `${mockBinDir}:${process.env.PATH}`,
			},
			projectDir,
		)

		expect(output).toContain("--message")
		expect(output).toContain("hello world")
	})

	it("should accept --no-rename flag without error", async () => {
		// Write ghost.jsonc (required for ghost mode)
		const configPath = getGhostConfigPath()
		await Bun.write(configPath, '{"registries": {}}')

		// Write empty opencode.jsonc
		const opencodeConfigPath = getGhostOpencodeConfigPath()
		await Bun.write(opencodeConfigPath, "{}")

		const { stderr } = await runGhostCLI(
			["opencode", "--no-rename"],
			{
				XDG_CONFIG_HOME: testDir,
				PATH: `${mockBinDir}:${process.env.PATH}`,
			},
			projectDir,
		)

		// The command should parse the flag without error
		// It will still run because we have a mock opencode binary, but the flag should be recognized
		expect(stderr).not.toContain("unknown option")
		expect(stderr).not.toContain("--no-rename")
	})

	it("should fail when file count exceeds maxFiles limit", async () => {
		// Write ghost.jsonc with a very low maxFiles limit
		const configPath = getProfileGhostConfig("default")
		await Bun.write(
			configPath,
			JSON.stringify({
				registries: {},
				maxFiles: 3, // Very low limit
			}),
		)

		// Write opencode.jsonc
		const opencodeConfigPath = getGhostOpencodeConfigPath()
		await Bun.write(opencodeConfigPath, '{"model": "test"}')

		// Create a project directory with many files to exceed the limit
		const projectDir = join(testDir, "test-project")
		await mkdir(projectDir, { recursive: true })
		for (let i = 0; i < 10; i++) {
			await Bun.write(join(projectDir, `file${i}.txt`), `content${i}`)
		}

		// Run from the project directory with many files
		const { exitCode, output } = await runGhostCLI(
			["opencode"],
			{
				XDG_CONFIG_HOME: testDir,
				PATH: `${mockBinDir}:${process.env.PATH}`,
			},
			projectDir,
		)

		// Should fail with file limit error (exit code 74 = BSD sysexits FILE_LIMIT)
		expect(exitCode).toBe(74)
		expect(output).toContain("File limit exceeded")
		expect(output).toContain("maxFiles")
	})
})

// =============================================================================
// UNIT TESTS FOR loadGhostOpencodeConfig
// =============================================================================

describe("loadGhostOpencodeConfig (unit)", () => {
	// These are already covered in ghost-config.test.ts but included here
	// for completeness of the opencode passthrough module tests

	let testDir: string
	const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

	beforeEach(async () => {
		testDir = await createTempConfigDir("ghost-opencode-unit")
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

	it("should load opencode config from separate file", async () => {
		const { loadGhostOpencodeConfig, getGhostOpencodeConfigPath } = await import(
			"../../src/ghost/config.js"
		)
		const { mkdir } = await import("node:fs/promises")
		const { dirname } = await import("node:path")

		const configPath = getGhostOpencodeConfigPath()
		await mkdir(dirname(configPath), { recursive: true })

		const opencodeConfig = {
			model: "gpt-4",
			customKey: "customValue",
		}
		await Bun.write(configPath, JSON.stringify(opencodeConfig))

		const result = await loadGhostOpencodeConfig()

		expect(result).toEqual({
			model: "gpt-4",
			customKey: "customValue",
		})
	})

	it("should return empty object when file doesn't exist", async () => {
		const { loadGhostOpencodeConfig } = await import("../../src/ghost/config.js")

		const result = await loadGhostOpencodeConfig()

		expect(result).toEqual({})
	})
})

import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { parse } from "jsonc-parser"

export interface CLIResult {
	stdout: string
	stderr: string
	output: string
	exitCode: number
}

export interface RunCLIOptions {
	/** Custom environment variables to merge with defaults */
	env?: Record<string, string | undefined>
	/** Use isolated environment (allowlist-only, requires XDG_CONFIG_HOME in env) */
	isolated?: boolean
}

/**
 * Creates an isolated environment for deterministic testing.
 * Uses ALLOWLIST approach - only passes through essential env vars.
 * FAILS FAST if XDG_CONFIG_HOME is not provided.
 */
export function createIsolatedEnv(
	testDir: string,
	overrides: Record<string, string | undefined> = {},
): Record<string, string> {
	// CRITICAL: Fail fast if XDG_CONFIG_HOME not set
	if (!overrides.XDG_CONFIG_HOME) {
		throw new Error(
			"XDG_CONFIG_HOME is required in isolated mode to prevent targeting real user config",
		)
	}

	// Build environment with only defined values
	// Pass through bun-related paths to avoid version manager issues
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		TMPDIR: process.env.TMPDIR ?? "/tmp",
		HOME: process.env.HOME ?? testDir, // Keep real HOME for bun version management
		TERM: "dumb",
		NO_COLOR: "1",
		FORCE_COLOR: "0",
		npm_config_user_agent: "", // Force curl detection by default
		// Bun version manager support - pass through if set
		...(process.env.BUN_INSTALL && { BUN_INSTALL: process.env.BUN_INSTALL }),
		...(process.env.BUNV_DIR && { BUNV_DIR: process.env.BUNV_DIR }),
	}

	// Apply overrides, filtering out undefined values
	for (const [key, value] of Object.entries(overrides)) {
		if (value !== undefined) {
			env[key] = value
		}
	}

	return env
}

/**
 * Run the CLI with the given arguments.
 * Uses Bun.spawn with explicit argument array for reliable parsing.
 */
export async function runCLI(
	args: string[],
	cwd: string,
	options?: RunCLIOptions,
): Promise<CLIResult> {
	const indexPath = join(import.meta.dir, "..", "src/index.ts")

	// Ensure cwd exists
	await mkdir(cwd, { recursive: true })

	// Build environment based on isolation mode
	const env = options?.isolated
		? createIsolatedEnv(cwd, options.env ?? {})
		: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...options?.env }

	// Use Bun.spawn with explicit argument array (not shell string interpolation)
	const proc = Bun.spawn(["bun", "run", indexPath, ...args], {
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
	})

	// Read stdout and stderr in parallel
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
 * Create a temporary directory for tests.
 */
export async function createTempDir(name: string): Promise<string> {
	const dir = join(import.meta.dir, "fixtures", `tmp-${name}-${Date.now()}`)
	await mkdir(dir, { recursive: true })
	return dir
}

/**
 * Clean up a temporary directory.
 */
export async function cleanupTempDir(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true })
}

/**
 * Parse JSONC content (JSON with comments).
 */
export function parseJsonc(content: string): unknown {
	return parse(content)
}

/**
 * Convenience wrapper for runCLI with isolation enabled.
 * Automatically sets XDG_CONFIG_HOME to testDir if not provided.
 */
export async function runCLIIsolated(
	args: string[],
	testDir: string,
	env: Record<string, string | undefined> = {},
): Promise<CLIResult> {
	return runCLI(args, testDir, {
		isolated: true,
		env: {
			XDG_CONFIG_HOME: testDir,
			...env,
		},
	})
}

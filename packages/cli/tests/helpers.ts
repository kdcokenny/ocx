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

	// Use Bun.spawn with explicit argument array (not shell string interpolation)
	const proc = Bun.spawn(["bun", "run", indexPath, ...args], {
		cwd,
		env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...options?.env },
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

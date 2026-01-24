import { expect, type Mock, spyOn } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { parse } from "jsonc-parser"

// Type for fetch mock
type FetchMock = Mock<typeof fetch>

let fetchMock: FetchMock | null = null

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

// =============================================================================
// Network Mocking Helpers
// =============================================================================

/**
 * Mock fetch to reject with an error (simulates DNS failure, connection refused, etc.)
 */
export function mockFetchError(error: Error): FetchMock {
	fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(error) as FetchMock
	return fetchMock
}

/**
 * Mock fetch to return a specific HTTP status code
 */
export function mockFetchStatus(status: number, statusText?: string, body?: string): FetchMock {
	fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(body ?? statusText ?? "", { status, statusText: statusText ?? "" }),
	) as FetchMock
	return fetchMock
}

/**
 * Mock fetch to return malformed JSON
 */
export function mockFetchMalformedJson(): FetchMock {
	fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
		new Response("not valid json {{{", {
			status: 200,
			headers: { "content-type": "application/json" },
		}),
	) as FetchMock
	return fetchMock
}

/**
 * Mock fetch to simulate a timeout (never resolves within reasonable time)
 */
export function mockFetchTimeout(delayMs: number = 30000): FetchMock {
	fetchMock = spyOn(globalThis, "fetch").mockImplementation(
		() => new Promise((resolve) => setTimeout(() => resolve(new Response("")), delayMs)),
	) as FetchMock
	return fetchMock
}

/**
 * Restore the original fetch function. Call in afterEach.
 */
export function restoreFetch(): void {
	fetchMock?.mockRestore()
	fetchMock = null
}

// =============================================================================
// Error Assertion Helpers
// =============================================================================

export interface ExpectOCXErrorOptions {
	exitCode: number
	code?: string
	messagePattern?: RegExp
}

/**
 * Assert CLI result is an error with expected exit code and optional message pattern.
 * Validates stderr contains expected content and stdout is empty.
 */
export function expectOCXError(result: CLIResult, options: ExpectOCXErrorOptions): void {
	expect(result.exitCode).toBe(options.exitCode)

	if (options.code) {
		expect(result.stderr.toLowerCase()).toContain(options.code.toLowerCase())
	}

	if (options.messagePattern) {
		expect(result.stderr).toMatch(options.messagePattern)
	}

	// Errors should go to stderr, not stdout (unless --json mode)
	if (!result.stdout.startsWith("{")) {
		expect(result.stdout.trim()).toBe("")
	}
}

export interface JsonErrorOutput {
	success: false
	error: {
		code: string
		message: string
		details?: Record<string, unknown>
	}
	exitCode: number
	meta: {
		timestamp: string
	}
}

export interface ExpectJsonErrorOptions {
	code: string
	exitCode: number
	details?: Record<string, unknown>
	messagePattern?: RegExp
}

/**
 * Parse and validate JSON error output from CLI.
 * Returns the parsed output for additional assertions.
 */
export function expectJsonError(output: string, options: ExpectJsonErrorOptions): JsonErrorOutput {
	let parsed: JsonErrorOutput
	try {
		parsed = JSON.parse(output) as JsonErrorOutput
	} catch {
		throw new Error(`Failed to parse JSON error output: ${output}`)
	}

	expect(parsed.success).toBe(false)
	expect(parsed.error.code).toBe(options.code)
	expect(parsed.exitCode).toBe(options.exitCode)

	// Validate timestamp is ISO 8601
	expect(parsed.meta.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)

	if (options.messagePattern) {
		expect(parsed.error.message).toMatch(options.messagePattern)
	}

	if (options.details) {
		expect(parsed.error.details).toMatchObject(options.details)
	}

	return parsed
}

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
	/** Use isolated environment (allowlist-only, requires XDG_CONFIG_HOME in env) */
	isolated?: boolean
	/** Timeout in milliseconds (default: 10000) */
	timeout?: number
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
		XDG_CACHE_HOME: join(testDir, "cache"),
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
	const timeout = options?.timeout ?? 10000 // 10s default

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
	const outputPromise = Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	])

	// Race between process exit and timeout
	let exitCode: number
	let timedOut = false

	try {
		exitCode = await Promise.race([
			proc.exited,
			new Promise<never>((_, reject) =>
				setTimeout(() => {
					timedOut = true
					proc.kill()
					reject(new Error(`CLI timeout after ${timeout}ms`))
				}, timeout),
			),
		])
	} catch (error) {
		if (timedOut) {
			// Return a result indicating timeout rather than throwing
			const [stdout, stderr] = await outputPromise.catch(() => ["", ""])
			return {
				stdout,
				stderr,
				output: `${stdout + stderr}\n[TIMEOUT after ${timeout}ms]`,
				exitCode: 124, // Standard timeout exit code
			}
		}
		throw error
	}

	const [stdout, stderr] = await outputPromise

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

export type StrictJsonPayload = Record<string, unknown>
type StrictJsonChannel = "stdout" | "stderr"

function resolveStrictJsonChannel(result: CLIResult): {
	channel: StrictJsonChannel
	output: string
} {
	const hasStdout = result.stdout.trim().length > 0
	const hasStderr = result.stderr.trim().length > 0

	if (hasStdout && hasStderr) {
		throw new Error(
			`strict JSON policy violation: expected exactly one output channel, but both stdout and stderr have content.\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n--------------`,
		)
	}

	if (!hasStdout && !hasStderr) {
		throw new Error(
			"strict JSON policy violation: expected JSON output on stdout or stderr, but both channels are empty.",
		)
	}

	if (hasStdout) {
		return { channel: "stdout", output: result.stdout }
	}

	return { channel: "stderr", output: result.stderr }
}

/**
 * Assert output channel is exactly one valid JSON document.
 * Rejects empty output and any human prefix/suffix text.
 */
export function expectStrictJsonStdout(
	output: string,
	channel: StrictJsonChannel = "stdout",
): StrictJsonPayload {
	const trimmed = output.trim()
	expect(trimmed.length).toBeGreaterThan(0)

	let parsed: unknown
	try {
		parsed = JSON.parse(trimmed)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(
			`${channel} must be exactly one valid JSON document. Parse failed: ${message}\n--- ${channel} ---\n${output}\n--------------`,
		)
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${channel} JSON must be an object. Received: ${JSON.stringify(parsed)}`)
	}

	return parsed as StrictJsonPayload
}

/**
 * Strict JSON success contract:
 * - exitCode = 0
 * - exactly one output channel contains JSON (stdout or stderr)
 * - payload includes success: true
 */
export function expectStrictJsonSuccess(result: CLIResult): StrictJsonPayload {
	expect(result.exitCode).toBe(0)

	const { channel, output } = resolveStrictJsonChannel(result)
	const payload = expectStrictJsonStdout(output, channel)
	expect((payload as { success?: unknown }).success).toBe(true)
	return payload
}

/**
 * Strict JSON failure contract:
 * - exitCode is non-zero
 * - exactly one output channel contains JSON (stdout or stderr)
 * - payload includes success: false and either:
 *   - an error object (code + message), or
 *   - blockers[] with at least one structured blocker (code + message + path)
 */
export function expectStrictJsonFailure(result: CLIResult): StrictJsonPayload {
	expect(result.exitCode).not.toBe(0)

	const { channel, output } = resolveStrictJsonChannel(result)
	const payload = expectStrictJsonStdout(output, channel)
	expect((payload as { success?: unknown }).success).toBe(false)

	const expectNonBlankString = (value: unknown): string => {
		expect(typeof value).toBe("string")
		const typedValue = value as string
		expect(typedValue.trim().length).toBeGreaterThan(0)
		return typedValue
	}

	let validatedFailureShape = false

	const errorPayload = (payload as { error?: unknown }).error
	if (errorPayload !== undefined) {
		expect(typeof errorPayload).toBe("object")
		expect(errorPayload).not.toBeNull()

		const typedError = errorPayload as { code?: unknown; message?: unknown }
		expectNonBlankString(typedError.code)
		expectNonBlankString(typedError.message)
		validatedFailureShape = true
	}

	const blockers = (payload as { blockers?: unknown }).blockers
	if (blockers !== undefined) {
		expect(Array.isArray(blockers)).toBe(true)
		const blockerList = blockers as unknown[]
		expect(blockerList.length).toBeGreaterThan(0)

		for (const blocker of blockerList) {
			expect(typeof blocker).toBe("object")
			expect(blocker).not.toBeNull()
			const typedBlocker = blocker as { code?: unknown; message?: unknown; path?: unknown }
			expectNonBlankString(typedBlocker.code)
			expectNonBlankString(typedBlocker.message)
			expectNonBlankString(typedBlocker.path)
		}

		validatedFailureShape = true
	}

	if (!validatedFailureShape) {
		throw new Error(
			"strict JSON failure payload must include a non-empty error object or blockers array.",
		)
	}

	return payload
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

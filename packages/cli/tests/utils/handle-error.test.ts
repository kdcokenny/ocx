/**
 * Error Handler Tests
 *
 * Tests for the error handling utilities, specifically wrapAction.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { z } from "zod"
import { BuildRegistryError } from "../../src/lib/build-registry"
import {
	EXIT_CODES,
	IntegrityError,
	InvalidProfileNameError,
	NetworkError,
	OCXError,
	ProfileExistsError,
	ProfileNotFoundError,
	RegistryExistsError,
} from "../../src/utils/errors"
import { handleError, wrapAction } from "../../src/utils/handle-error"

// =============================================================================
// wrapAction Tests
// =============================================================================

describe("wrapAction", () => {
	let consoleErrorSpy: ReturnType<typeof spyOn>
	let processExitSpy: ReturnType<typeof spyOn>

	beforeEach(() => {
		// Mock console.error to prevent test noise
		consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {})
		// Mock process.exit to prevent test termination
		processExitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit called")
		})
	})

	afterEach(() => {
		consoleErrorSpy.mockRestore()
		processExitSpy.mockRestore()
	})

	it("calls the wrapped action with arguments", async () => {
		const action = mock((..._args: unknown[]) => Promise.resolve())
		const wrapped = wrapAction(action)

		await wrapped("arg1", "arg2")

		expect(action).toHaveBeenCalledWith("arg1", "arg2")
	})

	it("calls the wrapped action with multiple arguments of different types", async () => {
		const action = mock((_str: string, _num: number, _obj: { key: string }) => Promise.resolve())
		const wrapped = wrapAction(action)

		await wrapped("test", 42, { key: "value" })

		expect(action).toHaveBeenCalledWith("test", 42, { key: "value" })
	})

	it("returns undefined for successful actions", async () => {
		const action = mock(() => Promise.resolve())
		const wrapped = wrapAction(action)

		const result = await wrapped()

		expect(result).toBeUndefined()
	})

	it("handles sync actions that return void", async () => {
		const action = mock(() => {
			// Sync action that returns void
		})
		const wrapped = wrapAction(action)

		const result = await wrapped()

		expect(result).toBeUndefined()
		expect(action).toHaveBeenCalled()
	})

	it("catches errors and calls handleError", async () => {
		const error = new Error("Test error")
		const action = mock(() => Promise.reject(error))
		const wrapped = wrapAction(action)

		// wrapAction calls handleError which calls process.exit
		// Our mock throws, so we expect that
		await expect(wrapped()).rejects.toThrow("process.exit called")

		// Verify error handling was triggered
		expect(consoleErrorSpy).toHaveBeenCalled()
	})

	it("catches sync errors and calls handleError", async () => {
		const action = mock(() => {
			throw new Error("Sync error")
		})
		const wrapped = wrapAction(action)

		// wrapAction calls handleError which calls process.exit
		await expect(wrapped()).rejects.toThrow("process.exit called")

		// Verify error handling was triggered
		expect(consoleErrorSpy).toHaveBeenCalled()
	})

	it("preserves the async nature of the wrapped action", async () => {
		let resolved = false
		const action = mock(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10))
			resolved = true
		})
		const wrapped = wrapAction(action)

		const promise = wrapped()
		expect(resolved).toBe(false)

		await promise
		expect(resolved).toBe(true)
	})

	it("works with no arguments", async () => {
		const action = mock(() => Promise.resolve())
		const wrapped = wrapAction(action)

		await wrapped()

		expect(action).toHaveBeenCalledWith()
	})
})

// =============================================================================
// handleError JSON Output Tests
// =============================================================================

describe("handleError JSON output", () => {
	let consoleLogSpy: ReturnType<typeof spyOn>
	let processExitSpy: ReturnType<typeof spyOn>
	let capturedOutput: string | null = null
	let capturedExitCode: number | null = null

	beforeEach(() => {
		capturedOutput = null
		capturedExitCode = null

		// Capture console.log output for JSON mode
		consoleLogSpy = spyOn(console, "log").mockImplementation((output: string) => {
			capturedOutput = output
		})

		// Capture exit code and prevent actual exit
		processExitSpy = spyOn(process, "exit").mockImplementation((code?: number) => {
			capturedExitCode = code ?? 0
			throw new Error("process.exit called")
		})
	})

	afterEach(() => {
		consoleLogSpy.mockRestore()
		processExitSpy.mockRestore()
	})

	function parseJsonOutput(): {
		success: boolean
		error: { code: string; message: string; details?: Record<string, unknown> }
		exitCode: number
		meta: { timestamp: string }
	} {
		if (!capturedOutput) throw new Error("No output captured")
		return JSON.parse(capturedOutput)
	}

	describe("RegistryExistsError", () => {
		it("formats with all details", () => {
			const error = new RegistryExistsError(
				"my-registry",
				"https://old.example.com",
				"https://new.example.com",
				"global config",
			)

			try {
				handleError(error, { json: true })
			} catch {
				// Expected process.exit
			}

			const output = parseJsonOutput()
			expect(output.success).toBe(false)
			expect(output.error.code).toBe("CONFLICT")
			expect(output.error.details).toEqual({
				registryName: "my-registry",
				existingUrl: "https://old.example.com",
				newUrl: "https://new.example.com",
				targetLabel: "global config",
			})
			expect(output.exitCode).toBe(EXIT_CODES.CONFLICT)
			expect(capturedExitCode).toBe(EXIT_CODES.CONFLICT)
		})

		it("formats without optional targetLabel", () => {
			const error = new RegistryExistsError(
				"my-registry",
				"https://old.example.com",
				"https://new.example.com",
			)

			try {
				handleError(error, { json: true })
			} catch {
				// Expected
			}

			const output = parseJsonOutput()
			expect(output.error.details).toEqual({
				registryName: "my-registry",
				existingUrl: "https://old.example.com",
				newUrl: "https://new.example.com",
			})
			expect(output.error.details).not.toHaveProperty("targetLabel")
		})
	})

	describe("IntegrityError", () => {
		it("formats with component, expected, and found", () => {
			const error = new IntegrityError("button", "abc123", "def456")

			try {
				handleError(error, { json: true })
			} catch {
				// Expected
			}

			const output = parseJsonOutput()
			expect(output.success).toBe(false)
			expect(output.error.code).toBe("INTEGRITY_ERROR")
			expect(output.error.details).toEqual({
				component: "button",
				expected: "abc123",
				found: "def456",
			})
			expect(output.exitCode).toBe(EXIT_CODES.INTEGRITY)
		})
	})

	describe("NetworkError", () => {
		it("formats with all HTTP error details", () => {
			const error = new NetworkError("Failed to fetch", {
				url: "https://example.com/api",
				status: 500,
				statusText: "Internal Server Error",
			})

			try {
				handleError(error, { json: true })
			} catch {
				// Expected
			}

			const output = parseJsonOutput()
			expect(output.success).toBe(false)
			expect(output.error.code).toBe("NETWORK_ERROR")
			expect(output.error.details).toEqual({
				url: "https://example.com/api",
				status: 500,
				statusText: "Internal Server Error",
			})
			expect(output.exitCode).toBe(EXIT_CODES.NETWORK)
		})

		it("formats with only url (network failure)", () => {
			const error = new NetworkError("Connection refused", {
				url: "https://example.com/api",
			})

			try {
				handleError(error, { json: true })
			} catch {
				// Expected
			}

			const output = parseJsonOutput()
			expect(output.error.details).toEqual({
				url: "https://example.com/api",
			})
		})

		it("formats without details when no options provided", () => {
			const error = new NetworkError("Generic network error")

			try {
				handleError(error, { json: true })
			} catch {
				// Expected
			}

			const output = parseJsonOutput()
			expect(output.error.code).toBe("NETWORK_ERROR")
			expect(output.error.details).toBeUndefined()
		})
	})

	describe("ProfileNotFoundError", () => {
		it("formats with profile name", () => {
			const error = new ProfileNotFoundError("work")

			try {
				handleError(error, { json: true })
			} catch {
				// Expected
			}

			const output = parseJsonOutput()
			expect(output.success).toBe(false)
			expect(output.error.code).toBe("NOT_FOUND")
			expect(output.error.details).toEqual({
				profile: "work",
			})
			expect(output.exitCode).toBe(EXIT_CODES.NOT_FOUND)
		})
	})

	describe("ProfileExistsError", () => {
		it("formats with profile name", () => {
			const error = new ProfileExistsError("default")

			try {
				handleError(error, { json: true })
			} catch {
				// Expected
			}

			const output = parseJsonOutput()
			expect(output.success).toBe(false)
			expect(output.error.code).toBe("CONFLICT")
			expect(output.error.details).toEqual({
				profile: "default",
			})
			expect(output.exitCode).toBe(EXIT_CODES.CONFLICT)
		})
	})

	describe("InvalidProfileNameError", () => {
		it("formats with profile and reason", () => {
			const error = new InvalidProfileNameError("../evil", "contains path traversal")

			try {
				handleError(error, { json: true })
			} catch {
				// Expected
			}

			const output = parseJsonOutput()
			expect(output.success).toBe(false)
			expect(output.error.code).toBe("VALIDATION_ERROR")
			expect(output.error.details).toEqual({
				profile: "../evil",
				reason: "contains path traversal",
			})
			expect(output.exitCode).toBe(EXIT_CODES.GENERAL)
		})
	})

	describe("BuildRegistryError", () => {
		it("formats with error list", () => {
			const error = new BuildRegistryError("Build failed with 2 errors", [
				"button: Source file not found",
				"card: Invalid manifest",
			])

			try {
				handleError(error, { json: true })
			} catch {
				// Expected
			}

			const output = parseJsonOutput()
			expect(output.success).toBe(false)
			expect(output.error.code).toBe("BUILD_ERROR")
			expect(output.error.details).toEqual({
				errors: ["button: Source file not found", "card: Invalid manifest"],
			})
			expect(output.exitCode).toBe(EXIT_CODES.GENERAL)
		})

		it("formats with empty error list", () => {
			const error = new BuildRegistryError("Build failed")

			try {
				handleError(error, { json: true })
			} catch {
				// Expected
			}

			const output = parseJsonOutput()
			expect(output.error.details).toEqual({
				errors: [],
			})
		})
	})

	describe("ZodError", () => {
		it("formats with issue details", () => {
			const schema = z.object({
				name: z.string(),
				version: z.number(),
			})

			let error: z.ZodError | null = null
			try {
				schema.parse({ name: 123, version: "bad" })
			} catch (e) {
				error = e as z.ZodError
			}

			try {
				handleError(error, { json: true })
			} catch {
				// Expected
			}

			const output = parseJsonOutput()
			expect(output.success).toBe(false)
			expect(output.error.code).toBe("VALIDATION_ERROR")
			expect(output.error.details?.issues).toBeDefined()
			expect(Array.isArray(output.error.details?.issues)).toBe(true)

			const issues = output.error.details?.issues as Array<{
				path: string
				message: string
				code: string
			}>
			expect(issues.length).toBe(2)
			expect(issues[0]).toHaveProperty("path")
			expect(issues[0]).toHaveProperty("message")
			expect(issues[0]).toHaveProperty("code")
			expect(output.exitCode).toBe(EXIT_CODES.CONFIG)
		})
	})

	describe("Generic OCXError", () => {
		it("formats without details", () => {
			const error = new OCXError("Something went wrong", "CONFIG_ERROR", EXIT_CODES.CONFIG)

			try {
				handleError(error, { json: true })
			} catch {
				// Expected
			}

			const output = parseJsonOutput()
			expect(output.success).toBe(false)
			expect(output.error.code).toBe("CONFIG_ERROR")
			expect(output.error.message).toBe("Something went wrong")
			expect(output.error.details).toBeUndefined()
			expect(output.exitCode).toBe(EXIT_CODES.CONFIG)
		})
	})

	describe("Unknown errors", () => {
		it("formats standard Error", () => {
			const error = new Error("Unexpected failure")

			try {
				handleError(error, { json: true })
			} catch {
				// Expected
			}

			const output = parseJsonOutput()
			expect(output.success).toBe(false)
			expect(output.error.code).toBe("UNKNOWN_ERROR")
			expect(output.error.message).toBe("Unexpected failure")
			expect(output.exitCode).toBe(EXIT_CODES.GENERAL)
		})

		it("formats non-Error values", () => {
			try {
				handleError("string error", { json: true })
			} catch {
				// Expected
			}

			const output = parseJsonOutput()
			expect(output.error.code).toBe("UNKNOWN_ERROR")
			expect(output.error.message).toBe("An unknown error occurred")
		})
	})

	describe("meta field", () => {
		it("includes valid ISO timestamp", () => {
			const error = new OCXError("Test", "CONFIG_ERROR")

			try {
				handleError(error, { json: true })
			} catch {
				// Expected
			}

			const output = parseJsonOutput()
			expect(output.meta).toBeDefined()
			expect(output.meta.timestamp).toBeDefined()

			// Verify it's a valid ISO date string
			const parsed = new Date(output.meta.timestamp)
			expect(parsed.toISOString()).toBe(output.meta.timestamp)
		})
	})
})

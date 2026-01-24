/**
 * Error handler for CLI commands
 * Converts errors to user-friendly output with proper exit codes
 */

import { ZodError } from "zod"

import { BuildRegistryError } from "../lib/build-registry"
import {
	EXIT_CODES,
	IntegrityError,
	InvalidProfileNameError,
	NetworkError,
	OCXError,
	ProfileExistsError,
	ProfileNotFoundError,
	RegistryExistsError,
} from "./errors"
import { logger } from "./logger"

export interface HandleErrorOptions {
	json?: boolean
}

/**
 * Handle errors consistently across all commands
 * Fail-fast: exit immediately with appropriate code
 */
export function handleError(error: unknown, options: HandleErrorOptions = {}): never {
	// JSON mode: structured output
	if (options.json) {
		const output = formatErrorAsJson(error)
		console.log(JSON.stringify(output, null, 2))
		process.exit(output.exitCode)
	}

	// OCX errors: known errors with codes
	if (error instanceof OCXError) {
		logger.error(error.message)
		process.exit(error.exitCode)
	}

	// Zod validation errors: format nicely
	if (error instanceof ZodError) {
		logger.error("Validation failed:")
		for (const issue of error.issues) {
			const path = issue.path.join(".")
			logger.error(`  ${path}: ${issue.message}`)
		}
		process.exit(EXIT_CODES.CONFIG)
	}

	// Unknown errors
	if (error instanceof Error) {
		logger.error(error.message)
		if (process.env.DEBUG) {
			console.error(error.stack)
		}
	} else {
		logger.error("An unknown error occurred")
	}

	process.exit(EXIT_CODES.GENERAL)
}

interface JsonErrorOutput {
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

/**
 * Wraps a command action with consistent error handling.
 * Use this to wrap async command handlers in Commander actions.
 *
 * @example
 * program
 *   .command("add")
 *   .action(wrapAction(async (options) => {
 *     // command implementation
 *   }))
 */
export function wrapAction<T extends unknown[]>(
	action: (...args: T) => void | Promise<void>,
): (...args: T) => Promise<void> {
	return async (...args: T) => {
		try {
			await action(...args)
		} catch (error) {
			handleError(error)
		}
	}
}

function formatErrorAsJson(error: unknown): JsonErrorOutput {
	if (error instanceof RegistryExistsError) {
		return {
			success: false,
			error: {
				code: error.code,
				message: error.message,
				details: {
					registryName: error.registryName,
					existingUrl: error.existingUrl,
					newUrl: error.newUrl,
					...(error.targetLabel && { targetLabel: error.targetLabel }),
				},
			},
			exitCode: error.exitCode,
			meta: {
				timestamp: new Date().toISOString(),
			},
		}
	}

	if (error instanceof IntegrityError) {
		return {
			success: false,
			error: {
				code: error.code,
				message: error.message,
				details: {
					component: error.component,
					expected: error.expected,
					found: error.found,
				},
			},
			exitCode: error.exitCode,
			meta: {
				timestamp: new Date().toISOString(),
			},
		}
	}

	if (error instanceof NetworkError) {
		const details: Record<string, unknown> = {}
		if (error.url) details.url = error.url
		if (error.status !== undefined) details.status = error.status
		if (error.statusText) details.statusText = error.statusText

		return {
			success: false,
			error: {
				code: error.code,
				message: error.message,
				...(Object.keys(details).length > 0 && { details }),
			},
			exitCode: error.exitCode,
			meta: {
				timestamp: new Date().toISOString(),
			},
		}
	}

	if (error instanceof ProfileNotFoundError) {
		return {
			success: false,
			error: {
				code: error.code,
				message: error.message,
				details: {
					profile: error.profile,
				},
			},
			exitCode: error.exitCode,
			meta: {
				timestamp: new Date().toISOString(),
			},
		}
	}

	if (error instanceof ProfileExistsError) {
		return {
			success: false,
			error: {
				code: error.code,
				message: error.message,
				details: {
					profile: error.profile,
				},
			},
			exitCode: error.exitCode,
			meta: {
				timestamp: new Date().toISOString(),
			},
		}
	}

	if (error instanceof InvalidProfileNameError) {
		return {
			success: false,
			error: {
				code: error.code,
				message: error.message,
				details: {
					profile: error.profile,
					reason: error.reason,
				},
			},
			exitCode: error.exitCode,
			meta: {
				timestamp: new Date().toISOString(),
			},
		}
	}

	if (error instanceof BuildRegistryError) {
		return {
			success: false,
			error: {
				code: "BUILD_ERROR",
				message: error.message,
				details: {
					errors: error.errors,
				},
			},
			exitCode: EXIT_CODES.GENERAL,
			meta: {
				timestamp: new Date().toISOString(),
			},
		}
	}

	if (error instanceof OCXError) {
		return {
			success: false,
			error: {
				code: error.code,
				message: error.message,
			},
			exitCode: error.exitCode,
			meta: {
				timestamp: new Date().toISOString(),
			},
		}
	}

	if (error instanceof ZodError) {
		return {
			success: false,
			error: {
				code: "VALIDATION_ERROR",
				message: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
				details: {
					issues: error.issues.map((i) => ({
						path: i.path.join("."),
						message: i.message,
						code: i.code,
					})),
				},
			},
			exitCode: EXIT_CODES.CONFIG,
			meta: {
				timestamp: new Date().toISOString(),
			},
		}
	}

	return {
		success: false,
		error: {
			code: "UNKNOWN_ERROR",
			message: error instanceof Error ? error.message : "An unknown error occurred",
		},
		exitCode: EXIT_CODES.GENERAL,
		meta: {
			timestamp: new Date().toISOString(),
		},
	}
}

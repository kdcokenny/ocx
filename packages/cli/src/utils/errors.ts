/**
 * Custom error classes with error codes
 * Following fail-fast philosophy - clear, actionable errors
 */

export type ErrorCode =
	| "NOT_FOUND"
	| "NETWORK_ERROR"
	| "CONFIG_ERROR"
	| "VALIDATION_ERROR"
	| "CONFLICT"
	| "PERMISSION_ERROR"
	| "INTEGRITY_ERROR"
	| "UPDATE_ERROR"
	| "FILE_LIMIT"

export const EXIT_CODES = {
	SUCCESS: 0,
	GENERAL: 1,
	NOT_FOUND: 66,
	NETWORK: 69,
	CONFIG: 78,
	INTEGRITY: 1, // Exit code for integrity failures
	FILE_LIMIT: 74, // BSD sysexits "data too large"
} as const

export class OCXError extends Error {
	constructor(
		message: string,
		public readonly code: ErrorCode,
		public readonly exitCode: number = EXIT_CODES.GENERAL,
	) {
		super(message)
		this.name = "OCXError"
	}
}

export class NotFoundError extends OCXError {
	constructor(message: string) {
		super(message, "NOT_FOUND", EXIT_CODES.NOT_FOUND)
		this.name = "NotFoundError"
	}
}

export class NetworkError extends OCXError {
	constructor(message: string) {
		super(message, "NETWORK_ERROR", EXIT_CODES.NETWORK)
		this.name = "NetworkError"
	}
}

export class ConfigError extends OCXError {
	constructor(message: string) {
		super(message, "CONFIG_ERROR", EXIT_CODES.CONFIG)
		this.name = "ConfigError"
	}
}

export class ValidationError extends OCXError {
	constructor(message: string) {
		super(message, "VALIDATION_ERROR", EXIT_CODES.GENERAL)
		this.name = "ValidationError"
	}
}

export class ConflictError extends OCXError {
	constructor(message: string) {
		super(message, "CONFLICT", EXIT_CODES.GENERAL)
		this.name = "ConflictError"
	}
}

export class IntegrityError extends OCXError {
	constructor(component: string, expected: string, found: string) {
		const message =
			`Integrity verification failed for "${component}"\n` +
			`  Expected: ${expected}\n` +
			`  Found:    ${found}\n\n` +
			`The registry content has changed since this component was locked.\n` +
			`Use 'ocx update ${component}' to intentionally update this component.`
		super(message, "INTEGRITY_ERROR", EXIT_CODES.INTEGRITY)
		this.name = "IntegrityError"
	}
}

export class SelfUpdateError extends OCXError {
	constructor(message: string) {
		super(message, "UPDATE_ERROR", EXIT_CODES.GENERAL)
		this.name = "SelfUpdateError"
	}
}

// =============================================================================
// GHOST MODE ERRORS
// =============================================================================

export class GhostNotInitializedError extends OCXError {
	constructor() {
		super(
			"Ghost mode not initialized. Run `ocx ghost init` first.",
			"CONFIG_ERROR",
			EXIT_CODES.CONFIG,
		)
		this.name = "GhostNotInitializedError"
	}
}

export class GhostAlreadyInitializedError extends OCXError {
	constructor(configPath?: string) {
		const path = configPath ?? "~/.config/ocx/ghost.jsonc"
		super(
			`Ghost mode already initialized.\n` +
				`Config: ${path}\n\n` +
				`To reset, delete the config and run init again:\n` +
				`  rm ${path} && ocx ghost init`,
			"CONFLICT",
			EXIT_CODES.GENERAL,
		)
		this.name = "GhostAlreadyInitializedError"
	}
}

export class GhostConfigError extends OCXError {
	constructor(message: string) {
		super(message, "CONFIG_ERROR", EXIT_CODES.CONFIG)
		this.name = "GhostConfigError"
	}
}

export class FileLimitExceededError extends OCXError {
	constructor(
		public readonly count: number,
		public readonly limit: number,
	) {
		super(
			`File limit exceeded: found ${count} entries (limit: ${limit}). ` +
				`To fix: add exclude patterns to ghost.jsonc, or set "maxFiles" to a higher value (0 = unlimited).`,
			"FILE_LIMIT",
			EXIT_CODES.FILE_LIMIT,
		)
		this.name = "FileLimitExceededError"
	}
}

// =============================================================================
// PROFILE ERRORS
// =============================================================================

export class ProfileNotFoundError extends OCXError {
	constructor(name: string) {
		super(`Profile "${name}" not found`, "NOT_FOUND", EXIT_CODES.NOT_FOUND)
		this.name = "ProfileNotFoundError"
	}
}

export class ProfileExistsError extends OCXError {
	constructor(name: string) {
		super(`Profile "${name}" already exists`, "CONFLICT", EXIT_CODES.GENERAL)
		this.name = "ProfileExistsError"
	}
}

export class InvalidProfileNameError extends OCXError {
	constructor(name: string, reason: string) {
		super(`Invalid profile name "${name}": ${reason}`, "VALIDATION_ERROR", EXIT_CODES.GENERAL)
		this.name = "InvalidProfileNameError"
	}
}

export class ProfilesNotInitializedError extends OCXError {
	constructor() {
		super(
			"Ghost profiles not initialized. Run 'ocx ghost init' first.",
			"NOT_FOUND",
			EXIT_CODES.NOT_FOUND,
		)
		this.name = "ProfilesNotInitializedError"
	}
}

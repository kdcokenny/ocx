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

export const EXIT_CODES = {
	SUCCESS: 0,
	GENERAL: 1,
	NOT_FOUND: 66,
	NETWORK: 69,
	CONFIG: 78,
	INTEGRITY: 1, // Exit code for integrity failures
	CONFLICT: 6,
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
	public readonly url?: string
	public readonly status?: number
	public readonly statusText?: string

	constructor(message: string, options?: { url?: string; status?: number; statusText?: string }) {
		super(message, "NETWORK_ERROR", EXIT_CODES.NETWORK)
		this.name = "NetworkError"
		this.url = options?.url
		this.status = options?.status
		this.statusText = options?.statusText
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
		super(message, "CONFLICT", EXIT_CODES.CONFLICT)
		this.name = "ConflictError"
	}
}

export class IntegrityError extends OCXError {
	constructor(
		public readonly component: string,
		public readonly expected: string,
		public readonly found: string,
	) {
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

export class OcxConfigError extends OCXError {
	constructor(message: string) {
		super(message, "CONFIG_ERROR", EXIT_CODES.CONFIG)
		this.name = "OcxConfigError"
	}
}

// =============================================================================
// PROFILE ERRORS
// =============================================================================

export class ProfileNotFoundError extends OCXError {
	constructor(public readonly profile: string) {
		super(`Profile "${profile}" not found`, "NOT_FOUND", EXIT_CODES.NOT_FOUND)
		this.name = "ProfileNotFoundError"
	}
}

export class ProfileExistsError extends OCXError {
	constructor(
		public readonly profile: string,
		hint?: string,
	) {
		const message = hint
			? `Profile "${profile}" already exists. ${hint}`
			: `Profile "${profile}" already exists.`
		super(message, "CONFLICT", EXIT_CODES.CONFLICT)
		this.name = "ProfileExistsError"
	}
}

export class RegistryExistsError extends OCXError {
	constructor(
		public readonly registryName: string,
		public readonly existingUrl: string,
		public readonly newUrl: string,
		public readonly targetLabel?: string,
	) {
		const target = targetLabel ? ` in ${targetLabel}` : ""
		const message =
			`Registry "${registryName}" already exists${target}.\n` +
			`  Current: ${existingUrl}\n` +
			`  New:     ${newUrl}\n\n` +
			`Use --force to overwrite.`
		super(message, "CONFLICT", EXIT_CODES.CONFLICT)
		this.name = "RegistryExistsError"
	}
}

export class InvalidProfileNameError extends OCXError {
	constructor(
		public readonly profile: string,
		public readonly reason: string,
	) {
		super(`Invalid profile name "${profile}": ${reason}`, "VALIDATION_ERROR", EXIT_CODES.GENERAL)
		this.name = "InvalidProfileNameError"
	}
}

export class ProfilesNotInitializedError extends OCXError {
	constructor() {
		super(
			"Profiles not initialized. Run 'ocx init --global' first.",
			"NOT_FOUND",
			EXIT_CODES.NOT_FOUND,
		)
		this.name = "ProfilesNotInitializedError"
	}
}

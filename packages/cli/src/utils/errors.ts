/**
 * Custom error classes with error codes
 * Following fail-fast philosophy - clear, actionable errors
 */

export type ErrorCode =
	| "NOT_FOUND"
	| "NETWORK_ERROR"
	| "CONFIG_ERROR"
	| "VALIDATION_ERROR"
	| "VALIDATION_FAILED"
	| "CONFLICT"
	| "PERMISSION_ERROR"
	| "INTEGRITY_ERROR"
	| "UPDATE_ERROR"
	| "REGISTRY_COMPAT_ERROR"

/**
 * Exit codes for OCX CLI errors
 * @property {0} SUCCESS - Command completed successfully
 * @property {1} GENERAL - Unspecified error
 * @property {6} CONFLICT - Resource already exists
 * @property {65} INTEGRITY - Component hash mismatch (data format error)
 * @property {66} NOT_FOUND - Resource not found
 * @property {69} NETWORK - Network/connectivity error
 * @property {78} CONFIG - Configuration error
 */
export const EXIT_CODES = {
	SUCCESS: 0,
	GENERAL: 1,
	NOT_FOUND: 66,
	NETWORK: 69,
	CONFIG: 78,
	INTEGRITY: 65,
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

export type RegistryNetworkContext = "source" | "dependency"

export interface NetworkErrorOptions {
	url?: string
	status?: number
	statusText?: string
	phase?: string
	qualifiedName?: string
	registryContext?: RegistryNetworkContext
	registryName?: string
}

export class NetworkError extends OCXError {
	public readonly url?: string
	public readonly status?: number
	public readonly statusText?: string
	public readonly phase?: string
	public readonly qualifiedName?: string
	public readonly registryContext?: RegistryNetworkContext
	public readonly registryName?: string

	constructor(message: string, options?: NetworkErrorOptions) {
		super(message, "NETWORK_ERROR", EXIT_CODES.NETWORK)
		this.name = "NetworkError"
		this.url = options?.url
		this.status = options?.status
		this.statusText = options?.statusText
		this.phase = options?.phase
		this.qualifiedName = options?.qualifiedName
		this.registryContext = options?.registryContext
		this.registryName = options?.registryName
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

export interface ValidationFailureDetails {
	valid: false
	errors: string[]
	summary: {
		valid: false
		totalErrors: number
		schemaErrors: number
		sourceFileErrors: number
		circularDependencyErrors: number
		duplicateTargetErrors: number
		otherErrors: number
	}
}

export class ValidationFailedError extends OCXError {
	constructor(public readonly details: ValidationFailureDetails) {
		super("Registry validation failed", "VALIDATION_FAILED", EXIT_CODES.CONFIG)
		this.name = "ValidationFailedError"
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

// =============================================================================
// REGISTRY COMPATIBILITY ERRORS
// =============================================================================

/**
 * Issue types for registry format incompatibility.
 * - `legacy-schema-v1`: missing/unversioned schema URL (legacy v1)
 * - `invalid-schema-url`: malformed/non-canonical schema URL
 * - `unsupported-schema-version`: versioned schema URL with unsupported major
 * - `invalid-format`: payload shape is invalid for supported schema
 */
export type RegistryCompatIssue =
	| "legacy-schema-v1"
	| "invalid-schema-url"
	| "unsupported-schema-version"
	| "invalid-format"

/**
 * Error for registry format/compatibility issues.
 * Thrown when a registry index cannot be parsed because it uses
 * an incompatible or legacy format.
 *
 * Includes structured details for JSON output: url, issue, and remediation.
 */
export class RegistryCompatibilityError extends OCXError {
	public readonly url: string
	public readonly issue: RegistryCompatIssue
	public readonly remediation: string
	public readonly schemaUrl?: string
	public readonly supportedMajor?: number
	public readonly detectedMajor?: number

	constructor(
		message: string,
		options: {
			url: string
			issue: RegistryCompatIssue
			remediation: string
			schemaUrl?: string
			supportedMajor?: number
			detectedMajor?: number
		},
	) {
		super(message, "REGISTRY_COMPAT_ERROR", EXIT_CODES.CONFIG)
		this.name = "RegistryCompatibilityError"
		this.url = options.url
		this.issue = options.issue
		this.remediation = options.remediation
		this.schemaUrl = options.schemaUrl
		this.supportedMajor = options.supportedMajor
		this.detectedMajor = options.detectedMajor
	}
}

// =============================================================================
// PROFILE ERRORS
// =============================================================================

export class ProfileNotFoundError extends OCXError {
	constructor(
		public readonly profile: string,
		hint?: string,
	) {
		const message = hint ?? `Profile "${profile}" not found`
		super(message, "NOT_FOUND", EXIT_CODES.NOT_FOUND)
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
	public readonly conflictType: "name" | "url"

	constructor(
		public readonly registryName: string,
		public readonly existingUrl: string,
		public readonly newUrl: string,
		public readonly targetLabel?: string,
		/**
		 * When conflictType is "url", this holds the existing registry name
		 * that already maps to the conflicting URL.
		 */
		public readonly existingName?: string,
	) {
		const target = targetLabel ? ` in ${targetLabel}` : ""
		const isUrlConflict = existingName !== undefined && existingName !== registryName

		const message = isUrlConflict
			? `Registry URL already registered under name "${existingName}"${target}.\n` +
				`  URL:           ${existingUrl}\n` +
				`  Existing name: ${existingName}\n` +
				`  Requested name: ${registryName}\n\n` +
				`Run 'ocx registry remove ${existingName}' first, then re-add with the new name.`
			: `Registry "${registryName}" already exists${target}.\n` +
				`  Current: ${existingUrl}\n` +
				`  New:     ${newUrl}\n\n` +
				`Run 'ocx registry remove ${registryName}' first, then re-add with the new URL.`

		super(message, "CONFLICT", EXIT_CODES.CONFLICT)
		this.name = "RegistryExistsError"
		this.conflictType = isUrlConflict ? "url" : "name"
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

export class LocalProfileUnsupportedError extends OCXError {
	constructor(
		public readonly profile: string,
		public readonly localDir: string,
	) {
		super(
			`Local profile directory unsupported: "${localDir}"\n\n` +
				`Local profiles are not supported. Profiles must be global only.\n` +
				`Remove the local profile directory and use global profiles instead:\n` +
				`  rm -rf "${localDir}"\n` +
				`  ocx profile show ${profile} --global`,
			"CONFIG_ERROR",
			EXIT_CODES.CONFIG,
		)
		this.name = "LocalProfileUnsupportedError"
	}
}

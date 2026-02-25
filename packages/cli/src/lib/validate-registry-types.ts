/**
 * Validation Types
 *
 * Shared types for registry validation (local and remote)
 */

export type ValidationErrorType =
	| "missing_file"
	| "invalid_schema"
	| "invalid_name"
	| "missing_dependency"
	| "circular_dependency"
	| "path_traversal"
	| "reserved_filename"
	| "http_error"
	| "unreachable_file"

export type ValidationWarningType =
	| "insecure_http"
	| "missing_cors"
	| "missing_content_type"
	| "duplicate_target"
	| "version_mismatch"

export interface ValidationError {
	type: ValidationErrorType
	message: string
	component?: string
	file?: string
	path?: string[]
}

export interface ValidationWarning {
	type: ValidationWarningType
	message: string
	component?: string
	file?: string
	suggestion?: string
}

export interface ValidationStats {
	componentsCount: number
	filesCount: number
	dependenciesCount?: number
	unreachableFiles?: number
	httpErrors?: number
}

export interface RegistryMetadata {
	name: string
	namespace: string
	version: string
	author: string
}

export interface ValidationResult {
	valid: boolean
	errors: ValidationError[]
	warnings: ValidationWarning[]
	stats: ValidationStats
	metadata?: RegistryMetadata
}

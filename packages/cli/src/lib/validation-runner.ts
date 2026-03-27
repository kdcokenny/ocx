/**
 * Validation Runner
 *
 * Shared validation workflow for both build and validate commands.
 */

import type { Registry } from "../schemas/registry"
import {
	type LoadRegistryErrorKind,
	loadRegistrySource,
	type ValidateRegistryOptions,
	validateRegistrySchema,
	validateRegistryWithOptions,
} from "./validators"

export type ValidationFailureType = "load" | "schema" | "rules"

export interface CompleteValidationResult {
	success: boolean
	errors: string[]
	registry?: Registry
	failureType?: ValidationFailureType
	loadErrorKind?: LoadRegistryErrorKind
}

/**
 * Run complete validation workflow: load, validate schema, and run all validators.
 *
 * @param sourcePath - Path to the registry source directory
 * @param options - Validation options
 * @returns Validation result with registry data if successful
 */
export async function runCompleteValidation(
	sourcePath: string,
	options: ValidateRegistryOptions = {},
): Promise<CompleteValidationResult> {
	// Load registry file
	const loadResult = await loadRegistrySource(sourcePath)
	if (!loadResult.success) {
		return {
			success: false,
			errors: [loadResult.error || "Failed to load registry"],
			failureType: "load",
			loadErrorKind: loadResult.errorKind,
		}
	}

	// Validate schema (compatibility + structure)
	const schemaResult = validateRegistrySchema(loadResult.data, sourcePath)
	if (!schemaResult.valid) {
		return {
			success: false,
			errors: schemaResult.errors,
			failureType: "schema",
		}
	}

	// Use the parsed and validated registry data
	const registry = schemaResult.data
	if (!registry) {
		throw new Error("Registry validation succeeded but returned no parsed data")
	}

	// Collect all validation errors
	const validationErrors: string[] = []
	for await (const error of validateRegistryWithOptions(registry, sourcePath, options)) {
		validationErrors.push(error)
	}

	if (validationErrors.length > 0) {
		return {
			success: false,
			errors: validationErrors,
			failureType: "rules",
		}
	}

	return {
		success: true,
		errors: [],
		registry,
	}
}

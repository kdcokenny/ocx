/**
 * Individual Validator Functions
 *
 * Extracted validation checks that can be used by both build and validate commands.
 */

import { registrySchema } from "../../schemas/registry"
import type { ValidationError } from "../validate-registry-types"

/**
 * Validation result for schema validation
 */
export interface SchemaValidationResult {
	errors: ValidationError[]
}

/**
 * Validate registry data against the schema
 *
 * @param registryData - The parsed registry data to validate
 * @returns Validation result with schema errors
 */
export function validateSchema(registryData: unknown): SchemaValidationResult {
	const errors: ValidationError[] = []

	const parseResult = registrySchema.safeParse(registryData)
	if (!parseResult.success) {
		for (const error of parseResult.error.errors) {
			errors.push({
				type: "invalid_schema",
				message: `${error.path.join(".")}: ${error.message}`,
				path: error.path.map(String),
			})
		}
	}

	return { errors }
}

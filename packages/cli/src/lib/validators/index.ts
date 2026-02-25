/**
 * Individual Validator Functions
 *
 * Extracted validation checks that can be used by both build and validate commands.
 */

import { join } from "node:path"
import { normalizeFile, type Registry, registrySchema } from "../../schemas/registry"
import type { ValidationError } from "../validate-registry-types"

/**
 * Validation result for schema validation
 */
export interface SchemaValidationResult {
	errors: ValidationError[]
}

/**
 * Validation result for file existence validation
 */
export interface FileExistenceValidationResult {
	errors: ValidationError[]
	filesCount: number
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

/**
 * Validate that all source files exist
 *
 * @param registry - The validated registry data
 * @param sourcePath - Path to the registry source directory
 * @returns Validation result with file existence errors and file count
 */
export async function validateFileExistence(
	registry: Registry,
	sourcePath: string,
): Promise<FileExistenceValidationResult> {
	const errors: ValidationError[] = []
	let totalFiles = 0

	for (const component of registry.components) {
		for (const rawFile of component.files) {
			const file = normalizeFile(rawFile, component.type)
			const sourceFilePath = join(sourcePath, "files", file.path)
			const exists = await Bun.file(sourceFilePath).exists()

			if (!exists) {
				errors.push({
					type: "missing_file",
					message: `Source file not found: ${file.path}`,
					component: component.name,
					file: file.path,
				})
			} else {
				totalFiles++
			}
		}
	}

	return { errors, filesCount: totalFiles }
}

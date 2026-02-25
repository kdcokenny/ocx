/**
 * Unified Validation Runner
 *
 * Orchestrates all validation checks and returns a complete ValidationResult.
 */

import { join } from "node:path"
import { parse } from "jsonc-parser"
import { registrySchema } from "../../schemas/registry"
import type { ValidationResult } from "../validate-registry-types"
import {
	detectCircularDependencies,
	detectDuplicateTargets,
	validateFileExistence,
	validateSchema,
} from "./index"

/**
 * Run all validation checks on a registry
 *
 * @param sourcePath - Path to the registry source directory
 * @returns Complete validation result
 */
export async function runValidation(sourcePath: string): Promise<ValidationResult> {
	const errors: ValidationError[] = []
	const warnings: ValidationWarning[] = []

	// Read registry.json
	const registryFilePath = join(sourcePath, "registry.json")
	const registryFile = Bun.file(registryFilePath)
	const registryText = await registryFile.text()
	const registryData = parse(registryText)

	// Schema validation
	const schemaResult = validateSchema(registryData)
	errors.push(...schemaResult.errors)

	// If schema is invalid, return early
	if (schemaResult.errors.length > 0) {
		return {
			valid: false,
			errors,
			warnings,
			stats: {
				componentsCount: 0,
				filesCount: 0,
			},
		}
	}

	// Parse the validated registry data
	const registry = registrySchema.parse(registryData)

	// File existence validation
	const fileResult = await validateFileExistence(registry, sourcePath)
	errors.push(...fileResult.errors)

	// Circular dependency detection
	const circularResult = detectCircularDependencies(registry)
	errors.push(...circularResult.errors)

	// Duplicate target detection
	const duplicateResult = detectDuplicateTargets(registry)
	warnings.push(...duplicateResult.warnings)

	return {
		valid: errors.length === 0,
		errors,
		warnings,
		stats: {
			componentsCount: registry.components.length,
			filesCount: fileResult.filesCount,
		},
		metadata: {
			name: registry.name,
			namespace: registry.namespace,
			version: registry.version,
			author: registry.author,
		},
	}
}

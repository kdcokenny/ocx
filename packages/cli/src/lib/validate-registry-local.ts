/**
 * Local Registry Validation
 *
 * Validates registry source files before building or publishing. This module
 * composes the individual validator functions from `validators/index.ts` to
 * provide a complete validation workflow.
 *
 * ## Validation Workflow
 *
 * 1. Check for registry.jsonc (or registry.json) file
 * 2. Parse JSONC content (supports comments and trailing commas)
 * 3. Validate schema (using validateSchema)
 * 4. Check file existence (using validateFileExistence)
 * 5. Detect circular dependencies (using detectCircularDependencies)
 * 6. Detect duplicate targets (using detectDuplicateTargets)
 *
 * The function short-circuits on schema validation failure, as subsequent
 * checks require a valid schema to proceed safely.
 *
 * @see {@link runValidation} for the unified validation runner used by build
 * @see {@link validators} for individual validation functions
 */

import { join } from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import { registrySchema } from "../schemas/registry"
import type { ValidationResult } from "./validate-registry-types"
import {
	detectCircularDependencies,
	detectDuplicateTargets,
	validateFileExistence,
	validateSchema,
} from "./validators/index"

/**
 * Validate a local registry source directory
 *
 * Performs comprehensive validation of a registry source directory, checking
 * schema compliance, file existence, circular dependencies, and duplicate targets.
 *
 * This function is used by the `ocx validate` command. For build workflows,
 * use `runValidation()` instead (it provides the same validation logic with
 * optional skip flags).
 *
 * @param sourcePath - Path to registry source directory (contains registry.jsonc and files/)
 * @returns Validation result with errors, warnings, stats, and metadata
 *
 * @example
 * ```typescript
 * const result = await validateRegistryLocal("./my-registry")
 * if (!result.valid) {
 *   console.error("Validation failed:", result.errors)
 *   process.exit(1)
 * }
 * if (result.warnings.length > 0) {
 *   console.warn("Warnings:", result.warnings)
 * }
 * ```
 */
export async function validateRegistryLocal(sourcePath: string): Promise<ValidationResult> {
	const errors: ValidationResult["errors"] = []
	const warnings: ValidationResult["warnings"] = []

	// 1. Check for registry file (prefer .jsonc over .json)
	const jsoncFile = Bun.file(join(sourcePath, "registry.jsonc"))
	const jsonFile = Bun.file(join(sourcePath, "registry.json"))
	const jsoncExists = await jsoncFile.exists()
	const jsonExists = await jsonFile.exists()

	if (!jsoncExists && !jsonExists) {
		errors.push({
			type: "invalid_schema",
			message: "No registry.jsonc or registry.json found in source directory",
		})
		return {
			valid: false,
			errors,
			warnings,
			stats: { componentsCount: 0, filesCount: 0 },
		}
	}

	// 2. Read and parse registry file
	const registryFile = jsoncExists ? jsoncFile : jsonFile
	const content = await registryFile.text()
	const registryData = parseJsonc(content, [], { allowTrailingComma: true })

	// 3. Validate schema
	const schemaResult = validateSchema(registryData)
	errors.push(...schemaResult.errors)

	if (schemaResult.errors.length > 0) {
		return {
			valid: false,
			errors,
			warnings,
			stats: { componentsCount: 0, filesCount: 0 },
		}
	}

	// Schema is valid, safe to parse
	const parseResult = registrySchema.safeParse(registryData)
	if (!parseResult.success) {
		// This should never happen since validateSchema passed, but keep for type safety
		throw new Error("Schema validation passed but parse failed - this is a bug")
	}

	const registry = parseResult.data

	// 4. Validate all source files exist
	const fileExistenceResult = await validateFileExistence(registry, sourcePath)
	errors.push(...fileExistenceResult.errors)
	const totalFiles = fileExistenceResult.filesCount

	// 5. Detect circular dependencies
	const circularDepsResult = detectCircularDependencies(registry)
	errors.push(...circularDepsResult.errors)

	// 6. Check for duplicate file targets
	const duplicateTargetsResult = detectDuplicateTargets(registry)
	warnings.push(...duplicateTargetsResult.warnings)

	return {
		valid: errors.length === 0,
		errors,
		warnings,
		stats: {
			componentsCount: registry.components.length,
			filesCount: totalFiles,
		},
		metadata: {
			name: registry.name,
			namespace: registry.namespace,
			version: registry.version,
			author: registry.author,
		},
	}
}

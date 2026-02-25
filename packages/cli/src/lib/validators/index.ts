/**
 * Individual Validator Functions
 *
 * This module provides reusable validation functions that are shared by both the
 * `ocx build` and `ocx validate` commands, ensuring consistent validation behavior
 * across the CLI.
 *
 * ## Validation Checks
 *
 * 1. **Schema Validation** (`validateSchema`):
 *    - Validates registry.jsonc structure against the Zod schema
 *    - Checks required fields, types, and formats
 *    - Used by: build, validate
 *
 * 2. **File Existence** (`validateFileExistence`):
 *    - Verifies all source files referenced in registry.jsonc exist
 *    - Checks files in the `files/` directory
 *    - Used by: build, validate
 *
 * 3. **Circular Dependencies** (`detectCircularDependencies`):
 *    - Detects dependency cycles within the same namespace
 *    - Prevents infinite loops during component installation
 *    - Used by: build, validate
 *
 * 4. **Duplicate Targets** (`detectDuplicateTargets`):
 *    - Warns when multiple components install to the same target path
 *    - Helps avoid installation conflicts
 *    - Used by: build (warning), validate (warning or error with --no-duplicate-targets)
 *
 * ## Architecture
 *
 * Each validator function:
 * - Accepts validated registry data and context (e.g., sourcePath)
 * - Returns a partial ValidationResult with errors and/or warnings
 * - Is composable via the `runValidation()` orchestrator
 * - Can be selectively skipped via configuration options
 *
 * @see {@link runValidation} for the orchestration function
 * @see {@link ValidationResult} for the unified result type
 */

import { join } from "node:path"
import { normalizeFile, type Registry, registrySchema } from "../../schemas/registry"
import type { ValidationError, ValidationWarning } from "../validate-registry-types"

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
 * Validation result for circular dependency detection
 */
export interface CircularDependencyValidationResult {
	errors: ValidationError[]
}

/**
 * Validation result for duplicate target detection
 */
export interface DuplicateTargetValidationResult {
	warnings: ValidationWarning[]
}

/**
 * Validate registry data against the schema
 *
 * Checks the parsed registry.jsonc structure against the OCX registry schema,
 * validating required fields (name, namespace, version, author, components),
 * field types, formats, and business rules (e.g., component name patterns,
 * dependency references).
 *
 * This is always the first validation check to run, since subsequent checks
 * require a valid schema to proceed safely.
 *
 * @param registryData - The parsed registry data to validate
 * @returns Validation result with schema errors (if any)
 *
 * @example
 * ```typescript
 * const data = JSON.parse(await Bun.file("registry.jsonc").text())
 * const result = validateSchema(data)
 * if (result.errors.length > 0) {
 *   console.error("Schema validation failed:", result.errors)
 * }
 * ```
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
 * Checks that every file referenced in component.files[] exists in the
 * registry's `files/` directory. This prevents build failures and ensures
 * the registry is complete before publishing.
 *
 * Files are checked at: `<sourcePath>/files/<file.path>`
 *
 * @param registry - The validated registry data (must pass schema validation first)
 * @param sourcePath - Path to the registry source directory
 * @returns Validation result with file existence errors and total file count
 *
 * @example
 * ```typescript
 * const registry = registrySchema.parse(data)
 * const result = await validateFileExistence(registry, "./my-registry")
 * console.log(`Found ${result.filesCount} files`)
 * if (result.errors.length > 0) {
 *   console.error("Missing files:", result.errors)
 * }
 * ```
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

/**
 * Detect circular dependencies in registry components
 *
 * Uses depth-first search to detect dependency cycles within the same namespace.
 * Circular dependencies prevent proper component installation order and would
 * cause infinite loops.
 *
 * Example cycle: comp-a → comp-b → comp-c → comp-a
 *
 * Cross-namespace dependencies (e.g., "other-registry/component") are skipped,
 * as they are resolved independently.
 *
 * @param registry - The validated registry data (must pass schema validation first)
 * @returns Validation result with circular dependency errors (if any)
 *
 * @example
 * ```typescript
 * const registry = registrySchema.parse(data)
 * const result = detectCircularDependencies(registry)
 * if (result.errors.length > 0) {
 *   console.error("Circular dependencies detected:", result.errors)
 * }
 * ```
 */
export function detectCircularDependencies(registry: Registry): CircularDependencyValidationResult {
	const errors: ValidationError[] = []
	const visited = new Set<string>()
	const visiting = new Set<string>()

	function detectCycle(componentName: string, path: string[] = []): boolean {
		if (visiting.has(componentName)) {
			errors.push({
				type: "circular_dependency",
				message: `Circular dependency: ${[...path, componentName].join(" → ")}`,
				component: componentName,
			})
			return true
		}
		if (visited.has(componentName)) return false

		visiting.add(componentName)
		const component = registry.components.find((c) => c.name === componentName)
		if (component?.dependencies) {
			for (const dep of component.dependencies) {
				if (dep.includes("/")) continue // Skip cross-namespace dependencies
				if (detectCycle(dep, [...path, componentName])) {
					return true
				}
			}
		}
		visiting.delete(componentName)
		visited.add(componentName)
		return false
	}

	for (const component of registry.components) {
		detectCycle(component.name)
	}

	return { errors }
}

/**
 * Detect duplicate file targets across components
 *
 * Checks if multiple components install files to the same target path.
 * This typically indicates a design issue and can cause installation conflicts
 * where one component overwrites another's files.
 *
 * Returns warnings (non-blocking) by default. The `ocx validate` command can
 * treat these as errors with the `--no-duplicate-targets` flag.
 *
 * @param registry - The validated registry data (must pass schema validation first)
 * @returns Validation result with duplicate target warnings (if any)
 *
 * @example
 * ```typescript
 * const registry = registrySchema.parse(data)
 * const result = detectDuplicateTargets(registry)
 * if (result.warnings.length > 0) {
 *   console.warn("Duplicate targets found:", result.warnings)
 * }
 * ```
 */
export function detectDuplicateTargets(registry: Registry): DuplicateTargetValidationResult {
	const warnings: ValidationWarning[] = []
	const targetMap = new Map<string, string[]>() // target -> component names

	for (const component of registry.components) {
		for (const rawFile of component.files) {
			const file = normalizeFile(rawFile, component.type)
			const components = targetMap.get(file.target) || []
			components.push(component.name)
			targetMap.set(file.target, components)
		}
	}

	// Warn about duplicates
	for (const [target, components] of targetMap) {
		if (components.length > 1) {
			warnings.push({
				type: "duplicate_target",
				message: `File ${target} is installed by multiple components: ${components.join(", ")}`,
				suggestion: "Consider renaming to avoid installation conflicts",
			})
		}
	}

	return { warnings }
}

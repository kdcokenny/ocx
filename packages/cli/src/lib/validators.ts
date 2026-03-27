/**
 * Registry Validation Library
 *
 * Pure validation functions for registry source validation.
 * Shared by both validate command and build command.
 */

import { join, posix } from "node:path"
import { type ParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser"
import type { Registry } from "../schemas/registry"
import { classifyRegistrySchemaIssue, normalizeFile, registrySchema } from "../schemas/registry"

export interface ValidationResult<T = unknown> {
	valid: boolean
	errors: string[]
	warnings?: string[]
	data?: T
}

export type LoadRegistryErrorKind = "not_found" | "parse_error"

export interface LoadRegistryResult {
	success: boolean
	data?: unknown
	error?: string
	errorKind?: LoadRegistryErrorKind
}

/**
 * Format JSONC parse errors into a readable error message.
 */
function formatJsoncParseError(parseErrors: ParseError[]): string {
	if (parseErrors.length === 0) {
		return "Unknown parse error"
	}

	const firstError = parseErrors[0]
	if (!firstError) {
		return "Unknown parse error"
	}

	return `${printParseErrorCode(firstError.error)} at offset ${firstError.offset}`
}

/**
 * Load and parse a registry source file from a directory.
 *
 * Looks for registry.jsonc first, then registry.json.
 * Supports JSONC format with comments and trailing commas.
 *
 * @param sourcePath - Path to the directory containing the registry file
 * @returns Result with parsed data or error message
 */
export async function loadRegistrySource(sourcePath: string): Promise<LoadRegistryResult> {
	const jsoncFile = Bun.file(`${sourcePath}/registry.jsonc`)
	const jsonFile = Bun.file(`${sourcePath}/registry.json`)
	const jsoncExists = await jsoncFile.exists()
	const jsonExists = await jsonFile.exists()

	if (!jsoncExists && !jsonExists) {
		return {
			success: false,
			error: "No registry.jsonc or registry.json found in source directory",
			errorKind: "not_found",
		}
	}

	const registryFile = jsoncExists ? jsoncFile : jsonFile
	const fileName = jsoncExists ? "registry.jsonc" : "registry.json"
	const content = await registryFile.text()

	const parseErrors: ParseError[] = []
	const data = parseJsonc(content, parseErrors, { allowTrailingComma: true })

	if (parseErrors.length > 0) {
		const errorDetail = formatJsoncParseError(parseErrors)
		return {
			success: false,
			error: `Invalid JSONC in ${fileName}: ${errorDetail}`,
			errorKind: "parse_error",
		}
	}

	return {
		success: true,
		data,
	}
}

/**
 * Validate a registry's schema compatibility and structure.
 *
 * This combines schema compatibility check (v1 vs v2) with schema validation.
 * It's a higher-level function that includes both checks.
 *
 * @param registryData - The parsed registry object
 * @param sourcePath - Path to the registry source (for error messages)
 * @returns Validation result with parsed data
 */
export function validateRegistrySchema(
	registryData: unknown,
	sourcePath: string,
): ValidationResult<Registry> {
	// Check schema compatibility first
	const schemaIssue = classifyRegistrySchemaIssue(registryData)
	if (schemaIssue) {
		return {
			valid: false,
			errors: [`Schema compatibility issue: ${schemaIssue.issue} - ${schemaIssue.remediation}`],
		}
	}

	// Then validate against the schema
	return validateRegistrySource(registryData, sourcePath)
}

/**
 * Validate a registry source object against the schema.
 *
 * @param registryData - The parsed registry object
 * @param sourcePath - Path to the registry source (for error messages)
 * @returns Validation result with parsed data
 */
export function validateRegistrySource(
	registryData: unknown,
	_sourcePath: string,
): ValidationResult<Registry> {
	const parseResult = registrySchema.safeParse(registryData)

	if (!parseResult.success) {
		const errors = parseResult.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`)
		return {
			valid: false,
			errors,
		}
	}

	return {
		valid: true,
		errors: [],
		data: parseResult.data,
	}
}

/**
 * Validate that all source files referenced in the registry exist.
 *
 * @param registry - The validated registry object
 * @param sourcePath - Path to the registry source directory
 * @returns Validation result with file existence errors
 */
export async function validateSourceFiles(
	registry: Registry,
	sourcePath: string,
): Promise<ValidationResult> {
	const errors: string[] = []

	for (const component of registry.components) {
		for (const rawFile of component.files) {
			const file = normalizeFile(rawFile, component.type)
			const sourceFilePath = join(sourcePath, "files", file.path)

			if (!(await Bun.file(sourceFilePath).exists())) {
				errors.push(`${component.name}: Source file not found at ${file.path}`)
			}
		}
	}

	return {
		valid: errors.length === 0,
		errors,
	}
}

/**
 * Validate that there are no circular dependencies in the registry.
 *
 * Uses depth-first search to detect cycles in the component dependency graph.
 * Only validates same-registry dependencies (bare names without "/").
 *
 * @param registry - The validated registry object
 * @returns Validation result with circular dependency errors
 */
export function validateCircularDependencies(registry: Registry): ValidationResult {
	const errors: string[] = []
	const componentMap = new Map(registry.components.map((c) => [c.name, c]))

	function detectCycle(
		componentName: string,
		visiting: Set<string>,
		visited: Set<string>,
		path: string[],
	): string | null {
		// If we're currently visiting this node, we found a cycle
		if (visiting.has(componentName)) {
			return [...path, componentName].join(" -> ")
		}

		// If already fully visited, no cycle from this path
		if (visited.has(componentName)) {
			return null
		}

		const component = componentMap.get(componentName)
		if (!component) {
			return null
		}

		// Mark as currently visiting
		visiting.add(componentName)
		path.push(componentName)

		// Check all dependencies
		for (const dep of component.dependencies) {
			// Only check same-registry deps (bare names without "/")
			if (dep.includes("/")) {
				continue
			}

			const cycle = detectCycle(dep, visiting, visited, path)
			if (cycle) {
				return cycle
			}
		}

		// Done visiting this node
		visiting.delete(componentName)
		visited.add(componentName)
		path.pop()

		return null
	}

	const globalVisited = new Set<string>()

	for (const component of registry.components) {
		if (globalVisited.has(component.name)) {
			continue
		}

		const cycle = detectCycle(component.name, new Set(), globalVisited, [])
		if (cycle) {
			errors.push(`Circular dependency detected: ${cycle}`)
			// Only report the first cycle found
			break
		}
	}

	return {
		valid: errors.length === 0,
		errors,
	}
}

/**
 * Validate that there are no duplicate target paths across components.
 *
 * @param registry - The validated registry object
 * @returns Validation result with duplicate target errors
 */
export function validateDuplicateTargets(registry: Registry): ValidationResult {
	const errors: string[] = []
	const targetMap = new Map<string, { componentName: string }>()

	const canonicalizeTargetForComparison = (target: string): string => {
		const normalizedUnicode = target.normalize("NFC")
		const unifiedSeparators = normalizedUnicode.replace(/\\/g, "/")
		const normalizedTarget = posix.normalize(unifiedSeparators)
		return normalizedTarget.replace(/^\.\//, "")
	}

	for (const component of registry.components) {
		for (const rawFile of component.files) {
			const file = normalizeFile(rawFile, component.type)
			const canonicalTarget = canonicalizeTargetForComparison(file.target)
			const existing = targetMap.get(canonicalTarget)

			if (existing) {
				errors.push(
					`Duplicate target "${canonicalTarget}" in components "${existing.componentName}" and "${component.name}"`,
				)
			} else {
				targetMap.set(canonicalTarget, {
					componentName: component.name,
				})
			}
		}
	}

	return {
		valid: errors.length === 0,
		errors,
	}
}

export interface ValidateRegistryOptions {
	skipDuplicateTargets?: boolean
}

/**
 * Validate a registry's structure using a generator that yields errors.
 *
 * This generator runs all validators in order and yields each error as it's found.
 * This eliminates duplication of calling all validators in the correct order.
 *
 * @param registry - The validated registry object
 * @param sourcePath - Path to the registry source directory
 * @param options - Validation options
 * @yields Individual validation error messages
 */
export async function* validateRegistryWithOptions(
	registry: Registry,
	sourcePath: string,
	options: ValidateRegistryOptions = {},
): AsyncGenerator<string, void, undefined> {
	// Validate source files exist
	const filesResult = await validateSourceFiles(registry, sourcePath)
	for (const error of filesResult.errors) {
		yield error
	}

	// Validate no circular dependencies
	const circularResult = validateCircularDependencies(registry)
	for (const error of circularResult.errors) {
		yield error
	}

	// Validate no duplicate targets (unless skipped)
	if (!options.skipDuplicateTargets) {
		const duplicateTargetsResult = validateDuplicateTargets(registry)
		for (const error of duplicateTargetsResult.errors) {
			yield error
		}
	}
}

/**
 * Local Registry Validation
 *
 * Validates registry source files before building
 */

import { join } from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import { normalizeFile, registrySchema } from "../schemas/registry"
import type { ValidationResult } from "./validate-registry-types"
import { validateFileExistence, validateSchema } from "./validators/index"

/**
 * Validate a local registry source directory
 *
 * @param sourcePath - Path to registry source directory
 * @returns Validation result with errors, warnings, and stats
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

	// 6. Check for duplicate file targets
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

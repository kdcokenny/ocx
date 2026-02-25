/**
 * Build Registry Library Function
 *
 * Pure function to build a registry from source. This function performs
 * comprehensive validation before building to ensure registry integrity.
 *
 * ## Validation
 *
 * All registries are validated before building using the unified validation
 * system (see `validators/run-validation.ts`). The build will fail if:
 * - Schema validation fails (invalid registry.jsonc structure)
 * - Source files are missing
 * - Circular dependencies are detected
 *
 * Warnings (e.g., duplicate targets) are captured but do not block the build.
 *
 * ## Build Process
 *
 * 1. Validate registry (schema, files, circular deps, duplicate targets)
 * 2. Create output directory structure
 * 3. Generate component packuments (components/[name].json)
 * 4. Copy source files to components/[name]/[path]
 * 5. Generate index.json with registry metadata
 * 6. Generate .well-known/ocx.json for discovery
 *
 * No CLI concerns - just input/output.
 *
 * @see {@link runValidation} for validation logic
 * @see {@link BuildRegistryError} for error handling
 */

import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import { normalizeFile, registrySchema } from "../schemas/registry"
import type { ValidationResult } from "./validate-registry-types"
import { runValidation } from "./validators/run-validation"

export interface BuildRegistryOptions {
	/** Source directory containing registry.jsonc (or registry.json) and files/ */
	source: string
	/** Output directory for built registry */
	out: string
}

export interface BuildRegistryResult {
	/** Name of the registry */
	name: string
	/** Namespace of the registry */
	namespace: string
	/** Version of the registry */
	version: string
	/** Number of components built */
	componentsCount: number
	/** Absolute path to output directory */
	outputPath: string
	/** Validation warnings (non-blocking) */
	warnings: string[]
}

/**
 * Error thrown when registry build fails
 *
 * This error carries either a ValidationResult (for validation failures) or
 * a string array (for backward compatibility with legacy error handling).
 *
 * When validationResult is present, the CLI uses formatValidationResult()
 * to display consistent, user-friendly error output.
 */
export class BuildRegistryError extends Error {
	public readonly errors: string[]
	public readonly validationResult?: ValidationResult

	constructor(message: string, errorsOrValidation: string[] | ValidationResult = []) {
		super(message)
		this.name = "BuildRegistryError"

		// Handle ValidationResult or string array for backward compatibility
		if (Array.isArray(errorsOrValidation)) {
			this.errors = errorsOrValidation
		} else {
			this.validationResult = errorsOrValidation
			this.errors = errorsOrValidation.errors.map((e) => e.message)
		}
	}
}

/**
 * Build a registry from source
 *
 * Validates the registry source, then builds the distributable registry structure
 * with packuments, source files, index, and discovery endpoint.
 *
 * ## Validation
 *
 * The build process starts with comprehensive validation:
 * - Schema validation (required fields, types, formats)
 * - File existence checks (all referenced files must exist)
 * - Circular dependency detection (prevents installation loops)
 * - Duplicate target detection (warns about installation conflicts)
 *
 * If validation fails, throws BuildRegistryError with detailed error information.
 *
 * ## Output Structure
 *
 * ```
 * dist/
 *   index.json              # Registry index
 *   .well-known/
 *     ocx.json              # Discovery endpoint
 *   components/
 *     comp-a.json           # Component packument
 *     comp-a/
 *       index.ts            # Component source files
 *     comp-b.json
 *     comp-b/
 *       skill.md
 * ```
 *
 * @param options - Build options (source path, output path)
 * @returns Build result with metadata and warnings
 * @throws {BuildRegistryError} If validation fails or files are missing
 *
 * @example
 * ```typescript
 * const result = await buildRegistry({
 *   source: "./my-registry",
 *   out: "./dist"
 * })
 * console.log(`Built ${result.componentsCount} components`)
 * if (result.warnings.length > 0) {
 *   console.warn("Warnings:", result.warnings)
 * }
 * ```
 */
export async function buildRegistry(options: BuildRegistryOptions): Promise<BuildRegistryResult> {
	const { source: sourcePath, out: outPath } = options

	// Run validation before building
	const validationResult = await runValidation(sourcePath)
	if (!validationResult.valid) {
		throw new BuildRegistryError("Registry validation failed", validationResult)
	}

	// Capture warnings (non-blocking)
	const warnings = validationResult.warnings.map((w) => w.message)

	// Read and parse registry file (already validated by runValidation)
	const jsoncFile = Bun.file(join(sourcePath, "registry.jsonc"))
	const jsonFile = Bun.file(join(sourcePath, "registry.json"))
	const jsoncExists = await jsoncFile.exists()
	const registryFile = jsoncExists ? jsoncFile : jsonFile
	const content = await registryFile.text()
	const registryData = parseJsonc(content, [], { allowTrailingComma: true })

	// Parse validated data (skip safeParse since runValidation already checked)
	const registry = registrySchema.parse(registryData)
	const validationErrors: string[] = []

	// Create output directory structure
	const componentsDir = join(outPath, "components")
	await mkdir(componentsDir, { recursive: true })

	// Generate packument and copy files for each component
	for (const component of registry.components) {
		const packument = {
			name: component.name,
			versions: {
				[registry.version]: component,
			},
			"dist-tags": {
				latest: registry.version,
			},
		}

		// Write manifest to components/[name].json
		const packumentPath = join(componentsDir, `${component.name}.json`)
		await Bun.write(packumentPath, JSON.stringify(packument, null, 2))

		// Copy files to components/[name]/[path]
		for (const rawFile of component.files) {
			const file = normalizeFile(rawFile, component.type)
			const sourceFilePath = join(sourcePath, "files", file.path)
			const destFilePath = join(componentsDir, component.name, file.path)
			const destFileDir = dirname(destFilePath)

			if (!(await Bun.file(sourceFilePath).exists())) {
				validationErrors.push(`${component.name}: Source file not found at ${sourceFilePath}`)
				continue
			}

			await mkdir(destFileDir, { recursive: true })
			const sourceFile = Bun.file(sourceFilePath)
			await Bun.write(destFilePath, sourceFile)
		}
	}

	// Fail fast if source files were missing during copy
	if (validationErrors.length > 0) {
		throw new BuildRegistryError(
			`Build failed with ${validationErrors.length} errors`,
			validationErrors,
		)
	}

	// Generate index.json at the root
	const index = {
		name: registry.name,
		namespace: registry.namespace,
		version: registry.version,
		author: registry.author,
		// Include version requirements for compatibility checking
		...(registry.opencode && { opencode: registry.opencode }),
		...(registry.ocx && { ocx: registry.ocx }),
		components: registry.components.map((c) => ({
			name: c.name,
			type: c.type,
			description: c.description,
		})),
	}

	await Bun.write(join(outPath, "index.json"), JSON.stringify(index, null, 2))

	// Generate .well-known/ocx.json for registry discovery
	const wellKnownDir = join(outPath, ".well-known")
	await mkdir(wellKnownDir, { recursive: true })
	const discovery = { registry: "/index.json" }
	await Bun.write(join(wellKnownDir, "ocx.json"), JSON.stringify(discovery, null, 2))

	return {
		name: registry.name,
		namespace: registry.namespace,
		version: registry.version,
		componentsCount: registry.components.length,
		outputPath: outPath,
		warnings,
	}
}

/**
 * Build Registry Library Function
 *
 * Pure function to build a registry from source.
 * No CLI concerns - just input/output.
 */

import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import { classifyRegistrySchemaIssue, normalizeFile, registrySchema } from "../schemas/registry"
import type { DryRunResult } from "../utils/dry-run"

export interface BuildRegistryOptions {
	/** Source directory containing registry.jsonc (or registry.json) and files/ */
	source: string
	/** Output directory for built registry */
	out: string
	/** Dry-run mode: validate and show what would be built */
	dryRun?: boolean
}

export interface BuildRegistryResult {
	/** Number of components built */
	componentsCount: number
	/** Absolute path to output directory */
	outputPath: string
}

export class BuildRegistryError extends Error {
	constructor(
		message: string,
		public readonly errors: string[] = [],
	) {
		super(message)
		this.name = "BuildRegistryError"
	}
}

/**
 * Build a registry from source.
 *
 * @param options - Build options
 * @returns Build result with metadata or DryRunResult
 * @throws {BuildRegistryError} If validation fails or files are missing
 */
export async function buildRegistry(
	options: BuildRegistryOptions,
): Promise<BuildRegistryResult | DryRunResult> {
	const { source: sourcePath, out: outPath } = options

	// Read registry file from source (prefer .jsonc over .json)
	const jsoncFile = Bun.file(join(sourcePath, "registry.jsonc"))
	const jsonFile = Bun.file(join(sourcePath, "registry.json"))
	const jsoncExists = await jsoncFile.exists()
	const jsonExists = await jsonFile.exists()

	if (!jsoncExists && !jsonExists) {
		throw new BuildRegistryError("No registry.jsonc or registry.json found in source directory")
	}

	const registryFile = jsoncExists ? jsoncFile : jsonFile
	const content = await registryFile.text()
	const registryData = parseJsonc(content, [], { allowTrailingComma: true })
	const schemaIssue = classifyRegistrySchemaIssue(registryData)
	if (schemaIssue) {
		throw new BuildRegistryError(`Registry schema compatibility failed (${schemaIssue.issue})`, [
			schemaIssue.remediation,
			...(schemaIssue.schemaUrl !== undefined ? [`Invalid $schema: ${schemaIssue.schemaUrl}`] : []),
		])
	}

	// Validate registry schema
	const parseResult = registrySchema.safeParse(registryData)
	if (!parseResult.success) {
		const errors = parseResult.error.issues.map(
			(issue) => `${issue.path.join(".")}: ${issue.message}`,
		)
		throw new BuildRegistryError("Registry validation failed", errors)
	}

	const registry = parseResult.data
	const validationErrors: string[] = []

	// Dry-run: Calculate what would be built without creating files
	if (options.dryRun) {
		const actions = []

		// Check for missing source files
		for (const component of registry.components) {
			// Would create packument file
			actions.push({
				action: "create" as const,
				target: `file:components/${component.name}.json`,
				details: { type: "packument" },
			})

			// Check source files exist
			for (const rawFile of component.files) {
				const file = normalizeFile(rawFile, component.type)
				const sourceFilePath = join(sourcePath, "files", file.path)

				if (!(await Bun.file(sourceFilePath).exists())) {
					validationErrors.push(`${component.name}: Source file not found at ${sourceFilePath}`)
					continue
				}

				// Would copy file
				actions.push({
					action: "create" as const,
					target: `file:components/${component.name}/${file.path}`,
					details: { source: sourceFilePath },
				})
			}
		}

		// Would create index.json
		actions.push({
			action: "create" as const,
			target: "file:index.json",
			details: { type: "registry index" },
		})

		// Would create .well-known/ocx.json
		actions.push({
			action: "create" as const,
			target: "file:.well-known/ocx.json",
			details: { type: "discovery file" },
		})

		// Calculate total files
		const totalFiles = actions.filter((a) => a.action === "create").length

		return {
			dryRun: true,
			command: "build",
			wouldPerform: actions,
			validation: {
				passed: validationErrors.length === 0,
				errors: validationErrors.length > 0 ? validationErrors : undefined,
			},
			summary: `Would build ${registry.components.length} components, ${totalFiles} files to ${outPath}`,
		}
	}

	// Normal mode: Create output directory structure
	const componentsDir = join(outPath, "components")
	await mkdir(componentsDir, { recursive: true })

	// V2: Generate packument and copy files for each component
	// Use component-level versioning (default to 1.0.0)
	const DEFAULT_COMPONENT_VERSION = "1.0.0"

	for (const component of registry.components) {
		const packument = {
			name: component.name,
			versions: {
				[DEFAULT_COMPONENT_VERSION]: component,
			},
			"dist-tags": {
				latest: DEFAULT_COMPONENT_VERSION,
			},
		}

		// Write manifest to components/[name].json
		const packumentPath = join(componentsDir, `${component.name}.json`)
		await Bun.write(packumentPath, JSON.stringify(packument, null, 2))

		// Copy files (if any - bundles may have no files, only dependencies)
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

	// V2: Generate index.json at the root (no registry version field)
	const index = {
		$schema: registry.$schema,
		name: registry.name,
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
		componentsCount: registry.components.length,
		outputPath: outPath,
	}
}

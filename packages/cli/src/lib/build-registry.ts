/**
 * Build Registry Library Function
 *
 * Pure function to build a registry from source.
 * No CLI concerns - just input/output.
 */

import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import { normalizeFile, registrySchema } from "../schemas/registry"

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
 * @returns Build result with metadata
 * @throws {BuildRegistryError} If validation fails or files are missing
 */
export async function buildRegistry(options: BuildRegistryOptions): Promise<BuildRegistryResult> {
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

	// Validate registry schema
	const parseResult = registrySchema.safeParse(registryData)
	if (!parseResult.success) {
		const errors = parseResult.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`)
		throw new BuildRegistryError("Registry validation failed", errors)
	}

	const registry = parseResult.data
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
			const file = normalizeFile(rawFile)
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
	}
}

/**
 * Component Info Command
 *
 * Display token cost estimates for a component.
 */

import type { Command } from "commander"
import kleur from "kleur"
import type { ConfigProvider } from "../../config/provider"
import { fetchComponent, fetchFileContent } from "../../registry/fetcher"
import type { ComponentManifest } from "../../schemas/registry"
import { parseQualifiedComponent } from "../../schemas/registry"
import { NetworkError, NotFoundError } from "../../utils/errors"
import { handleError } from "../../utils/handle-error"
import { outputJson } from "../../utils/json-output"
import { addCommonOptions, addVerboseOption } from "../../utils/shared-options"
import type { TokenEstimate } from "../../utils/token-estimation"
import { estimateTokensMultiModel } from "../../utils/token-estimation"

export interface ComponentInfoOptions {
	cwd: string
	json: boolean
	quiet: boolean
	verbose: boolean
	profile?: string
}

export interface ComponentInfoResult {
	component: ComponentManifest
	tokenEstimates: TokenEstimate
	totalFiles: number
	totalBytes: number
}

export interface FormatOptions {
	json: boolean
	quiet: boolean
	verbose: boolean
}

/**
 * Format a number with comma separators.
 */
function formatNumber(num: number): string {
	return new Intl.NumberFormat("en-US").format(num)
}

/**
 * Format file size in human-readable units.
 */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Format and output component info results.
 * Handles both JSON and human-readable output modes.
 */
export function formatComponentInfoOutput(
	result: ComponentInfoResult,
	options: FormatOptions,
): void {
	if (options.json) {
		// JSON output
		const output = {
			success: true,
			component: {
				name: result.component.name,
				type: result.component.type,
				description: result.component.description,
			},
			tokenEstimates: result.tokenEstimates,
			stats: {
				totalFiles: result.totalFiles,
				totalBytes: result.totalBytes,
			},
		}
		outputJson(output)
	} else {
		// Human-readable output
		console.log(`Component: ${kleur.cyan(result.component.name)}`)
		console.log(`Type: ${kleur.dim(result.component.type)}`)
		console.log(`Description: ${result.component.description}`)
		console.log()
		console.log("Token Estimates:")
		console.log(`  Claude (Sonnet)    │ ${formatNumber(result.tokenEstimates.claude)} tokens`)
		console.log(`  GPT-4o             │ ${formatNumber(result.tokenEstimates.gpt4o)} tokens`)

		if (result.tokenEstimates.gemini !== null) {
			console.log(`  Gemini 2.0 Flash   │ ${formatNumber(result.tokenEstimates.gemini)} tokens`)
		} else {
			console.log("  Gemini 2.0 Flash   │ N/A")
		}

		console.log()
		const roundedAverage = Math.round(result.tokenEstimates.average / 100) * 100
		console.log(`Estimated Context: ${kleur.bold(`~${formatNumber(roundedAverage)}`)} tokens (avg)`)
		console.log(kleur.dim(`Files: ${result.totalFiles} | Size: ${formatBytes(result.totalBytes)}`))
	}
}

/**
 * Core logic for component info command.
 * Fetches component, downloads files, and estimates token counts.
 */
export async function runComponentInfoCore(
	componentName: string,
	_options: Partial<ComponentInfoOptions>,
	provider: ConfigProvider,
): Promise<ComponentInfoResult> {
	const registries = provider.getRegistries()
	const registryNames = Object.keys(registries)

	if (registryNames.length === 0) {
		throw new NotFoundError("No registries configured")
	}

	// Parse component name - it may be qualified (namespace/component) or unqualified
	let searchName: string
	let specifiedRegistry: string | null = null

	if (componentName.includes("/")) {
		const parsed = parseQualifiedComponent(componentName)
		searchName = parsed.component
		specifiedRegistry = parsed.namespace // namespace IS the registry name
	} else {
		searchName = componentName
	}

	// Try to find component in registries
	let manifest: ComponentManifest | null = null
	let foundRegistry: string | null = null

	// If registry is specified, only check that registry
	if (specifiedRegistry) {
		const registryConfig = registries[specifiedRegistry]
		if (!registryConfig) {
			throw new NotFoundError(`Registry '${specifiedRegistry}' not found in configuration`)
		}

		try {
			manifest = await fetchComponent(registryConfig.url, searchName)
			foundRegistry = specifiedRegistry
		} catch (error) {
			if (error instanceof NotFoundError) {
				throw new NotFoundError(
					`Component '${searchName}' not found in registry '${specifiedRegistry}'`,
				)
			}
			throw error
		}
	} else {
		// Search all registries in order
		for (const [registryName, registryConfig] of Object.entries(registries)) {
			try {
				manifest = await fetchComponent(registryConfig.url, searchName)
				foundRegistry = registryName
				break
			} catch (error) {
				// Continue to next registry if not found
				if (error instanceof NotFoundError) {
					continue
				}
				// Re-throw network errors
				if (error instanceof NetworkError) {
					throw error
				}
				throw error
			}
		}
	}

	if (!manifest || !foundRegistry) {
		throw new NotFoundError(`Component '${componentName}' not found in any configured registry`)
	}

	// Fetch all file contents
	const registryConfig = registries[foundRegistry]
	if (!registryConfig) {
		throw new NotFoundError(`Registry configuration not found for '${foundRegistry}'`)
	}

	const fileContents: string[] = []
	let totalBytes = 0

	for (const file of manifest.files) {
		const filePath = typeof file === "string" ? file : file.path
		try {
			const content = await fetchFileContent(registryConfig.url, searchName, filePath)
			fileContents.push(content)
			totalBytes += Buffer.byteLength(content, "utf8")
		} catch (error) {
			throw new NetworkError(
				`Failed to fetch file '${filePath}' for component '${searchName}': ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	// Concatenate all file contents
	const concatenatedContent = fileContents.join("\n")

	// Estimate tokens
	const tokenEstimates = await estimateTokensMultiModel(concatenatedContent)

	return {
		component: manifest,
		tokenEstimates,
		totalFiles: manifest.files.length,
		totalBytes,
	}
}

/**
 * Register the component info command.
 */
export function registerComponentInfoCommand(program: Command): void {
	const cmd = program
		.command("component")
		.alias("c")
		.command("info <component>")
		.description("Display token cost estimates for a component")
		.option("-p, --profile <name>", "Use specific profile")

	addCommonOptions(cmd)
	addVerboseOption(cmd)

	cmd.action(
		handleError(async (componentName: string, options: ComponentInfoOptions) => {
			// For now, just run the core logic
			// Output formatting will be added in Story 5
			const { LocalConfigProvider } = await import("../../config/provider")
			const provider = await LocalConfigProvider.requireInitialized(options.cwd)
			await runComponentInfoCore(componentName, options, provider)
		}),
	)
}

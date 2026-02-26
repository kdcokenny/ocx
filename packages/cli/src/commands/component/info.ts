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
import { logger } from "../../utils/logger"
import { addCommonOptions, addVerboseOption } from "../../utils/shared-options"
import { createSpinner } from "../../utils/spinner"
import type { TokenEstimate } from "../../utils/token-estimation"
import { estimateTokensMultiModel } from "../../utils/token-estimation"

/**
 * Options for the component info command.
 */
export interface ComponentInfoOptions {
	cwd: string
	json: boolean
	quiet: boolean
	verbose: boolean
	profile?: string
	/** Include token estimates for all dependencies (optional) */
	withDependencies?: boolean
}

/**
 * Token information for a single dependency component.
 */
export interface DependencyTokenInfo {
	/** Unqualified component name (e.g., "web-search") */
	name: string
	/** Qualified component name with namespace (e.g., "kdco/web-search") */
	qualifiedName: string
	/** Component type */
	type: string
	/** Component description */
	description: string
	/** Token estimates for this dependency */
	tokenEstimates: TokenEstimate
	/** Number of files in this dependency */
	totalFiles: number
	/** Total bytes for this dependency */
	totalBytes: number
}

/**
 * Result of the component info command.
 * When withDependencies is true, includes dependency tree information.
 */
export interface ComponentInfoResult {
	/** The main component manifest */
	component: ComponentManifest
	/** Token estimates for the main component only */
	tokenEstimates: TokenEstimate
	/** Number of files in the main component */
	totalFiles: number
	/** Total bytes for the main component */
	totalBytes: number
	/** Optional dependency tree information (only when --with-dependencies flag is used) */
	dependencies?: {
		/** All dependency components in resolution order */
		components: DependencyTokenInfo[]
		/** Cumulative totals including main component + all dependencies */
		cumulative: {
			tokenEstimates: TokenEstimate
			totalFiles: number
			totalBytes: number
		}
	}
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
 * Get color for token count based on thresholds.
 */
function getTokenColor(count: number): (str: string) => string {
	if (count < 3000) return kleur.green
	if (count <= 8000) return kleur.yellow
	return kleur.red
}

/**
 * Format and output component info results.
 * Handles both JSON and human-readable output modes.
 */
export function formatComponentInfoOutput(
	result: ComponentInfoResult,
	options: FormatOptions,
): void {
	// Handle quiet mode - suppress all output unless JSON mode
	if (options.quiet && !options.json) {
		return
	}

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
		const colorFn = getTokenColor(result.tokenEstimates.average)

		console.log(`Component: ${kleur.cyan(result.component.name)}`)
		console.log(`Type: ${kleur.dim(result.component.type)}`)
		console.log(`Description: ${result.component.description}`)
		console.log()
		console.log("Token Estimates:")
		console.log(
			`  Claude (Sonnet)    │ ${colorFn(formatNumber(result.tokenEstimates.claude))} tokens`,
		)
		console.log(
			`  GPT-4o             │ ${colorFn(formatNumber(result.tokenEstimates.gpt4o))} tokens`,
		)

		console.log()
		const roundedAverage = Math.round(result.tokenEstimates.average / 100) * 100
		console.log(
			`Estimated Context: ${kleur.bold(colorFn(`~${formatNumber(roundedAverage)}`))} tokens (avg)`,
		)
		console.log(kleur.dim(`Files: ${result.totalFiles} | Size: ${formatBytes(result.totalBytes)}`))
	}
}

/**
 * Core logic for component info command.
 * Fetches component, downloads files, and estimates token counts.
 */
export async function runComponentInfoCore(
	componentName: string,
	options: Partial<ComponentInfoOptions>,
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

	// Show spinner unless quiet or verbose mode
	const showSpinner = !options.quiet && !options.verbose
	const spinner = showSpinner
		? createSpinner({ text: "Fetching component...", quiet: options.quiet })
		: null
	spinner?.start()

	// Verbose logging
	if (options.verbose) {
		logger.info(`Searching for component: ${componentName}`)
		logger.info(`Configured registries: ${registryNames.join(", ")}`)
	}

	// Try to find component in registries
	let manifest: ComponentManifest | null = null
	let foundRegistry: string | null = null

	// If registry is specified, only check that registry
	if (specifiedRegistry) {
		if (options.verbose) {
			logger.info(`Using specified registry: ${specifiedRegistry}`)
		}
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
		spinner?.stop()
		throw new NotFoundError(`Component '${componentName}' not found in any configured registry`)
	}

	if (options.verbose) {
		logger.info(`Found component in registry: ${foundRegistry}`)
		logger.info(`Component has ${manifest.files.length} files`)
	}

	// Handle dependency resolution if --with-dependencies flag is set
	if (options.withDependencies) {
		const { resolveDependencies } = await import("../../registry/resolver")
		const { createQualifiedComponent } = await import("../../schemas/registry")

		// Update spinner for dependency resolution
		if (spinner) {
			spinner.text = "Resolving dependencies..."
		}

		if (options.verbose) {
			logger.info("Resolving dependency tree...")
		}

		// Create qualified name for the main component
		const qualifiedName = createQualifiedComponent(foundRegistry, searchName)

		// Resolve all dependencies
		const resolved = await resolveDependencies(registries, [qualifiedName])

		if (options.verbose) {
			logger.info(`Found ${resolved.components.length - 1} dependencies`)
		}

		// Update spinner for file fetching
		if (spinner) {
			spinner.text = `Fetching ${resolved.components.length} components...`
		}

		// Process all components (main + dependencies)
		const allDependencyTokenInfo: DependencyTokenInfo[] = []
		const allFileContents: string[] = []
		let cumulativeTotalFiles = 0
		let cumulativeTotalBytes = 0

		// Track main component for later
		let mainComponent: {
			tokenEstimates: TokenEstimate
			totalFiles: number
			totalBytes: number
		} | null = null

		for (const component of resolved.components) {
			if (options.verbose) {
				logger.info(`Processing component: ${component.qualifiedName}`)
			}

			// Fetch all file contents for this component
			const componentFileContents: string[] = []
			let componentBytes = 0

			for (const file of component.files) {
				const filePath = typeof file === "string" ? file : file.path
				try {
					const content = await fetchFileContent(component.baseUrl, component.name, filePath)
					componentFileContents.push(content)
					componentBytes += Buffer.byteLength(content, "utf8")
				} catch (error) {
					throw new NetworkError(
						`Failed to fetch file '${filePath}' for component '${component.name}': ${error instanceof Error ? error.message : String(error)}`,
					)
				}
			}

			// Estimate tokens for this component
			const componentContent = componentFileContents.join("\n")
			const componentTokens = await estimateTokensMultiModel(componentContent)

			// Add to cumulative totals
			allFileContents.push(...componentFileContents)
			cumulativeTotalFiles += component.files.length
			cumulativeTotalBytes += componentBytes

			// Check if this is the main component
			if (component.qualifiedName === qualifiedName) {
				// Save main component info
				mainComponent = {
					tokenEstimates: componentTokens,
					totalFiles: component.files.length,
					totalBytes: componentBytes,
				}
			} else {
				// Add to dependencies list
				allDependencyTokenInfo.push({
					name: component.name,
					qualifiedName: component.qualifiedName,
					type: component.type,
					description: component.description,
					tokenEstimates: componentTokens,
					totalFiles: component.files.length,
					totalBytes: componentBytes,
				})
			}
		}

		// Update spinner for final token estimation
		if (spinner) {
			spinner.text = "Analyzing cumulative token costs..."
		}

		// Calculate cumulative token estimates from all content
		const allContent = allFileContents.join("\n")
		const cumulativeTokens = await estimateTokensMultiModel(allContent)

		spinner?.stop()

		if (options.verbose) {
			logger.info("Token estimation complete")
			logger.info(`Cumulative tokens: ~${Math.round(cumulativeTokens.average / 100) * 100}`)
		}

		// Return result with dependencies
		if (!mainComponent) {
			throw new Error("Main component not found in resolved dependencies")
		}

		return {
			component: manifest,
			tokenEstimates: mainComponent.tokenEstimates,
			totalFiles: mainComponent.totalFiles,
			totalBytes: mainComponent.totalBytes,
			dependencies: {
				components: allDependencyTokenInfo,
				cumulative: {
					tokenEstimates: cumulativeTokens,
					totalFiles: cumulativeTotalFiles,
					totalBytes: cumulativeTotalBytes,
				},
			},
		}
	}

	// Original logic for non-dependency mode
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

	// Update spinner for token estimation phase
	if (spinner) {
		spinner.text = "Analyzing token costs..."
	}

	if (options.verbose) {
		logger.info(`Fetched ${fileContents.length} files (${totalBytes} bytes)`)
		logger.info("Estimating token counts...")
	}

	// Concatenate all file contents
	const concatenatedContent = fileContents.join("\n")

	// Estimate tokens
	const tokenEstimates = await estimateTokensMultiModel(concatenatedContent)

	spinner?.stop()

	if (options.verbose) {
		logger.info("Token estimation complete")
	}

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
	const componentCmd = program.command("component").alias("c").description("Component utilities")

	const infoCmd = componentCmd
		.command("info <component>")
		.description("Display token cost estimates for a component")
		.option("-p, --profile <name>", "Use specific profile")

	addCommonOptions(infoCmd)
	addVerboseOption(infoCmd)

	infoCmd.action(async (componentName: string, options: ComponentInfoOptions) => {
		try {
			const { LocalConfigProvider } = await import("../../config/provider")
			const provider = await LocalConfigProvider.requireInitialized(options.cwd)
			const result = await runComponentInfoCore(componentName, options, provider)
			formatComponentInfoOutput(result, options)
		} catch (error) {
			handleError(error, { json: options.json })
		}
	})
}

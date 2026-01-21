/**
 * Search/List Command
 *
 * Search for components across registries or list installed.
 */

import type { Command } from "commander"
import { InvalidArgumentError, Option } from "commander"
import fuzzysort from "fuzzysort"
import kleur from "kleur"
import type { ConfigProvider } from "../config/provider"
import { LocalConfigProvider } from "../config/provider"
import { ConfigResolver } from "../config/resolver"
import { fetchRegistryIndex } from "../registry/fetcher"
import { readOcxLock } from "../schemas/config"
import { createSpinner, handleError, logger, outputJson } from "../utils/index"
import { addCommonOptions, addVerboseOption } from "../utils/shared-options"

export interface SearchOptions {
	cwd: string
	json: boolean
	quiet: boolean
	verbose: boolean
	installed: boolean
	limit: number
	profile?: string
}

/**
 * Parses and validates a positive integer from CLI input.
 * @param value - The string value from CLI
 * @returns The parsed positive integer
 * @throws InvalidArgumentError if value is not a positive integer
 */
function parsePositiveInt(value: string): number {
	const parsed = parseInt(value, 10)
	if (Number.isNaN(parsed) || parsed <= 0) {
		throw new InvalidArgumentError("Must be a positive integer")
	}
	return parsed
}

export function registerSearchCommand(program: Command): void {
	const cmd = program
		.command("search")
		.alias("list")
		.description("Search for components across registries or list installed")
		.argument("[query]", "Search query")
		.option("-i, --installed", "List installed components only", false)
		.option("-p, --profile <name>", "Use specific profile")
		.addOption(
			new Option("-l, --limit <n>", "Limit results").default(20).argParser(parsePositiveInt),
		)

	addCommonOptions(cmd)
	addVerboseOption(cmd)

	cmd.action(async (query: string | undefined, options: SearchOptions) => {
		try {
			// List installed only
			if (options.installed) {
				const lock = await readOcxLock(options.cwd)
				if (!lock) {
					if (options.json) {
						outputJson({ success: true, data: { components: [] } })
					} else {
						logger.info("No components installed.")
					}
					return
				}

				const installed = Object.entries(lock.installed).map(([name, info]) => ({
					name,
					registry: info.registry,
					version: info.version,
					installedAt: info.installedAt,
				}))

				if (options.json) {
					outputJson({ success: true, data: { components: installed } })
				} else {
					logger.info(`Installed components (${installed.length}):`)
					for (const comp of installed) {
						console.log(
							`  ${kleur.cyan(comp.name)} ${kleur.dim(`v${comp.version}`)} from ${comp.registry}`,
						)
					}
				}
				return
			}

			// Search using ConfigResolver (supports --profile) or LocalConfigProvider
			let provider: ConfigProvider

			if (options.profile) {
				// Use ConfigResolver with profile
				const resolver = await ConfigResolver.create(options.cwd, { profile: options.profile })
				provider = {
					cwd: resolver.getCwd(),
					getRegistries: () => resolver.getRegistries(),
					getComponentPath: () => resolver.getComponentPath(),
				}
			} else {
				provider = await LocalConfigProvider.requireInitialized(options.cwd)
			}

			await runSearchCore(query, options, provider)
		} catch (error) {
			handleError(error, { json: options.json })
		}
	})
}

/**
 * Core search logic that accepts a ConfigProvider.
 * This enables reuse across both standard and profile modes.
 */
export async function runSearchCore(
	query: string | undefined,
	options: { limit: number; json?: boolean; quiet?: boolean; verbose?: boolean },
	provider: ConfigProvider,
): Promise<void> {
	const registries = provider.getRegistries()

	if (options.verbose) {
		logger.info(`Searching in ${Object.keys(registries).length} registries...`)
	}

	const allComponents: Array<{
		name: string
		description: string
		type: string
		registry: string
	}> = []

	const spinner = createSpinner({
		text: "Searching registries...",
		quiet: options.quiet || options.verbose,
	})

	if (!options.json && !options.verbose) {
		spinner.start()
	}

	for (const [registryName, registryConfig] of Object.entries(registries)) {
		try {
			if (options.verbose) {
				logger.info(`Fetching index from ${registryName} (${registryConfig.url})...`)
			}
			const index = await fetchRegistryIndex(registryConfig.url)
			if (options.verbose) {
				logger.info(`Found ${index.components.length} components in ${registryName}`)
			}
			for (const comp of index.components) {
				allComponents.push({
					name: `${index.namespace}/${comp.name}`,
					description: comp.description,
					type: comp.type,
					registry: registryName,
				})
			}
		} catch (error) {
			if (options.verbose) {
				logger.warn(
					`Failed to fetch registry ${registryName}: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
			// Skip failed registries
		}
	}

	if (!options.json && !options.verbose) {
		spinner.stop()
	}

	// Filter by query if provided
	let results = allComponents
	if (query) {
		const fuzzyResults = fuzzysort.go(query, allComponents, {
			keys: ["name", "description"],
			limit: options.limit,
		})
		results = fuzzyResults.map((r) => r.obj)
	} else {
		results = results.slice(0, options.limit)
	}

	if (options.json) {
		outputJson({ success: true, data: { components: results } })
	} else {
		if (results.length === 0) {
			logger.info("No components found.")
		} else {
			logger.info(`Found ${results.length} components:`)
			for (const comp of results) {
				console.log(
					`  ${kleur.cyan(comp.name)} ${kleur.dim(`(${comp.type})`)} - ${comp.description}`,
				)
			}
		}
	}
}

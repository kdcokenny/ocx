/**
 * Search/List Command
 *
 * Search for components across registries or list installed.
 */

import type { Command } from "commander"
import fuzzysort from "fuzzysort"
import kleur from "kleur"
import { fetchRegistryIndex } from "../registry/fetcher.js"
import { readOcxConfig, readOcxLock } from "../schemas/config.js"
import { createSpinner, handleError, logger, outputJson, ValidationError } from "../utils/index.js"

interface SearchOptions {
	cwd: string
	json: boolean
	quiet: boolean
	verbose: boolean
	installed: boolean
	limit: number
}

export function registerSearchCommand(program: Command): void {
	program
		.command("search")
		.alias("list")
		.description("Search for components across registries or list installed")
		.argument("[query]", "Search query")
		.option("--cwd <path>", "Working directory", process.cwd())
		.option("--json", "Output as JSON", false)
		.option("-q, --quiet", "Suppress output", false)
		.option("-v, --verbose", "Verbose output", false)
		.option("-i, --installed", "List installed components only", false)
		.option("-l, --limit <n>", "Limit results", "20")
		.action(async (query: string | undefined, options: SearchOptions) => {
			try {
				const limit = parseInt(String(options.limit), 10)
				if (Number.isNaN(limit)) {
					throw new ValidationError("--limit must be a valid number");
				}

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

				// Search across registries
				const config = await readOcxConfig(options.cwd)
				if (!config) {
					logger.warn("No ocx.jsonc found. Run 'ocx init' first.")
					return
				}

				if (options.verbose) {
					logger.info(`Searching in ${Object.keys(config.registries).length} registries...`)
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

				for (const [registryName, registryConfig] of Object.entries(config.registries)) {
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
						limit,
					})
					results = fuzzyResults.map((r) => r.obj)
				} else {
					results = results.slice(0, limit)
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
			} catch (error) {
				handleError(error, { json: options.json })
			}
		})
}

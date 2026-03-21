import fuzzysort from "fuzzysort"
import kleur from "kleur"
import type { ConfigProvider } from "../config/provider"
import { LocalConfigProvider } from "../config/provider"
import { ConfigResolver } from "../config/resolver"
import { fetchRegistryIndex } from "../registry/fetcher"
import { readReceipt } from "../schemas"
import { outputJson } from "../utils/json-output"
import { logger } from "../utils/logger"
import { createSpinner } from "../utils/spinner"
import type { SearchOptions } from "./search"

export async function runSearchCommandAction(
	query: string | undefined,
	options: SearchOptions,
): Promise<void> {
	if (options.installed) {
		const receipt = await readReceipt(options.cwd)
		if (!receipt || Object.keys(receipt.installed).length === 0) {
			if (options.json) {
				outputJson({ success: true, data: { components: [] } })
			} else {
				logger.info("No components installed.")
			}
			return
		}

		const installed = Object.entries(receipt.installed).map(([_canonicalId, info]) => ({
			name: `${info.registryName}/${info.name}`,
			registry: info.registryUrl,
			version: info.revision,
			installedAt: undefined,
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

	let provider: ConfigProvider
	if (options.profile) {
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
}

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
					name: `${registryName}/${comp.name}`,
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
		}
	}

	if (!options.json && !options.verbose) {
		spinner.stop()
	}

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
		return
	}

	if (results.length === 0) {
		logger.info("No components found.")
		return
	}

	logger.info(`Found ${results.length} components:`)
	for (const comp of results) {
		console.log(`  ${kleur.cyan(comp.name)} ${kleur.dim(`(${comp.type})`)} - ${comp.description}`)
	}
}

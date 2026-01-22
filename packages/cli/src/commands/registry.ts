/**
 * Registry Command
 *
 * Manage configured registries.
 */

import type { Command } from "commander"
import kleur from "kleur"
import type { RegistryConfig } from "../schemas/config"
import { findOcxConfig, readOcxConfig, writeOcxConfig } from "../schemas/config"
import { handleError, logger, outputJson } from "../utils/index"
import { getGlobalConfigPath } from "../utils/paths"
import { addCommonOptions, addGlobalOption } from "../utils/shared-options"

export interface RegistryOptions {
	cwd: string
	json?: boolean
	quiet?: boolean
	global?: boolean
}

export interface RegistryAddOptions extends RegistryOptions {
	name?: string
	version?: string
}

// =============================================================================
// CORE FUNCTIONS (used by both standard and profile commands)
// =============================================================================

/**
 * Core logic for adding a registry.
 * @param url Registry URL
 * @param options Options including optional name, version
 * @param callbacks Callbacks for reading/writing config
 */
export async function runRegistryAddCore(
	url: string,
	options: RegistryAddOptions,
	callbacks: {
		getRegistries: () => Record<string, RegistryConfig>
		isLocked?: () => boolean
		setRegistry: (name: string, config: RegistryConfig) => Promise<void>
	},
): Promise<{ name: string; url: string; updated: boolean }> {
	// Guard: Check registries aren't locked
	if (callbacks.isLocked?.()) {
		throw new Error("Registries are locked. Cannot add.")
	}

	// Derive name from URL if not provided
	const name = options.name || new URL(url).hostname.replace(/\./g, "-")

	const registries = callbacks.getRegistries()
	const isUpdate = name in registries

	await callbacks.setRegistry(name, {
		url,
		version: options.version,
	})

	return { name, url, updated: isUpdate }
}

/**
 * Core logic for removing a registry.
 * @param name Registry name to remove
 * @param callbacks Callbacks for reading/writing config
 */
export async function runRegistryRemoveCore(
	name: string,
	callbacks: {
		getRegistries: () => Record<string, RegistryConfig>
		isLocked?: () => boolean
		removeRegistry: (name: string) => Promise<void>
	},
): Promise<{ removed: string }> {
	// Guard: Check registries aren't locked
	if (callbacks.isLocked?.()) {
		throw new Error("Registries are locked. Cannot remove.")
	}

	const registries = callbacks.getRegistries()
	if (!(name in registries)) {
		throw new Error(`Registry '${name}' not found.`)
	}

	await callbacks.removeRegistry(name)
	return { removed: name }
}

/**
 * Core logic for listing registries.
 * @param callbacks Callbacks for reading config
 */
export function runRegistryListCore(callbacks: {
	getRegistries: () => Record<string, RegistryConfig>
	isLocked?: () => boolean
}): { registries: Array<{ name: string; url: string; version: string }>; locked: boolean } {
	const registries = callbacks.getRegistries()
	const locked = callbacks.isLocked?.() ?? false

	const list = Object.entries(registries).map(([name, cfg]) => ({
		name,
		url: cfg.url,
		version: cfg.version || "latest",
	}))

	return { registries: list, locked }
}

// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerRegistryCommand(program: Command): void {
	const registry = program.command("registry").description("Manage registries")

	// registry add <url> [--name <name>]
	const addCmd = registry
		.command("add")
		.description("Add a registry")
		.argument("<url>", "Registry URL")
		.option("--name <name>", "Registry alias (defaults to hostname)")
		.option("--version <version>", "Pin to specific version")

	addGlobalOption(addCmd)
	addCommonOptions(addCmd)

	addCmd.action(async (url: string, options: RegistryAddOptions, command: Command) => {
		try {
			// Check if --cwd was explicitly provided (not just defaulted)
			const cwdExplicitlyProvided = command.getOptionValueSource("cwd") === "cli"

			if (options.global && cwdExplicitlyProvided) {
				logger.error("Cannot use --global with --cwd. They are mutually exclusive.")
				process.exit(1)
			}

			// Determine config location
			let configDir: string
			let configPath: string
			const config = await (async () => {
				if (options.global) {
					configDir = getGlobalConfigPath()
					const found = findOcxConfig(configDir)
					configPath = found.path
					const cfg = await readOcxConfig(configDir)
					if (!cfg) {
						logger.error("Global config not found. Run 'opencode' once to initialize.")
						process.exit(1)
					}
					return cfg
				} else {
					configDir = options.cwd ?? process.cwd()
					const found = findOcxConfig(configDir)
					configPath = found.path
					const cfg = await readOcxConfig(configDir)
					if (!cfg) {
						logger.error("No ocx.jsonc found. Run 'ocx init' first.")
						process.exit(1)
					}
					return cfg
				}
			})()

			const result = await runRegistryAddCore(url, options, {
				getRegistries: () => config.registries,
				isLocked: () => config.lockRegistries ?? false,
				setRegistry: async (name, regConfig) => {
					config.registries[name] = regConfig
					await writeOcxConfig(configDir, config, configPath)
				},
			})

			if (options.json) {
				outputJson({ success: true, data: result })
			} else if (!options.quiet) {
				const location = options.global ? "global config" : "local config"
				if (result.updated) {
					logger.success(`Updated registry in ${location}: ${result.name} -> ${result.url}`)
				} else {
					logger.success(`Added registry to ${location}: ${result.name} -> ${result.url}`)
				}
			}
		} catch (error) {
			handleError(error, { json: options.json })
		}
	})

	// registry remove <name>
	const removeCmd = registry
		.command("remove")
		.description("Remove a registry")
		.argument("<name>", "Registry name")

	addGlobalOption(removeCmd)
	addCommonOptions(removeCmd)

	removeCmd.action(async (name: string, options: RegistryOptions, command: Command) => {
		try {
			// Check if --cwd was explicitly provided (not just defaulted)
			const cwdExplicitlyProvided = command.getOptionValueSource("cwd") === "cli"

			if (options.global && cwdExplicitlyProvided) {
				logger.error("Cannot use --global with --cwd. They are mutually exclusive.")
				process.exit(1)
			}

			// Determine config location
			let configDir: string
			let configPath: string
			const config = await (async () => {
				if (options.global) {
					configDir = getGlobalConfigPath()
					const found = findOcxConfig(configDir)
					configPath = found.path
					const cfg = await readOcxConfig(configDir)
					if (!cfg) {
						logger.error("Global config not found. Run 'opencode' once to initialize.")
						process.exit(1)
					}
					return cfg
				} else {
					configDir = options.cwd ?? process.cwd()
					const found = findOcxConfig(configDir)
					configPath = found.path
					const cfg = await readOcxConfig(configDir)
					if (!cfg) {
						logger.error("No ocx.jsonc found. Run 'ocx init' first.")
						process.exit(1)
					}
					return cfg
				}
			})()

			const result = await runRegistryRemoveCore(name, {
				getRegistries: () => config.registries,
				isLocked: () => config.lockRegistries ?? false,
				removeRegistry: async (regName) => {
					delete config.registries[regName]
					await writeOcxConfig(configDir, config, configPath)
				},
			})

			if (options.json) {
				outputJson({ success: true, data: result })
			} else if (!options.quiet) {
				const location = options.global ? "global config" : "local config"
				logger.success(`Removed registry from ${location}: ${result.removed}`)
			}
		} catch (error) {
			handleError(error, { json: options.json })
		}
	})

	// registry list
	const listCmd = registry.command("list").description("List configured registries")

	addGlobalOption(listCmd)
	addCommonOptions(listCmd)

	listCmd.action(async (options: RegistryOptions, command: Command) => {
		try {
			// Check if --cwd was explicitly provided (not just defaulted)
			const cwdExplicitlyProvided = command.getOptionValueSource("cwd") === "cli"

			if (options.global && cwdExplicitlyProvided) {
				logger.error("Cannot use --global with --cwd. They are mutually exclusive.")
				process.exit(1)
			}

			// Determine config location
			let configDir: string
			const config = await (async () => {
				if (options.global) {
					configDir = getGlobalConfigPath()
					const cfg = await readOcxConfig(configDir)
					if (!cfg) {
						logger.warn("Global config not found. Run 'opencode' once to initialize.")
						return null
					}
					return cfg
				} else {
					configDir = options.cwd ?? process.cwd()
					const cfg = await readOcxConfig(configDir)
					if (!cfg) {
						logger.warn("No ocx.jsonc found. Run 'ocx init' first.")
						return null
					}
					return cfg
				}
			})()

			if (!config) return

			const result = runRegistryListCore({
				getRegistries: () => config.registries,
				isLocked: () => config.lockRegistries ?? false,
			})

			if (options.json) {
				outputJson({ success: true, data: result })
			} else if (!options.quiet) {
				if (result.registries.length === 0) {
					logger.info("No registries configured.")
				} else {
					logger.info(
						`Configured registries${options.global ? " (global)" : ""}${result.locked ? kleur.yellow(" (locked)") : ""}:`,
					)
					for (const reg of result.registries) {
						console.log(`  ${kleur.cyan(reg.name)}: ${reg.url} ${kleur.dim(`(${reg.version})`)}`)
					}
				}
			}
		} catch (error) {
			handleError(error, { json: options.json })
		}
	})
}

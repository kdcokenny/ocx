/**
 * Registry Command
 *
 * Manage configured registries.
 */

import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import type { Command } from "commander"
import kleur from "kleur"
import { ProfileManager } from "../profile/manager"
import { getProfileOcxConfig } from "../profile/paths"
import type { RegistryConfig } from "../schemas/config"
import { findOcxConfig, readOcxConfig, writeOcxConfig } from "../schemas/config"
import { OcxConfigError, ProfileNotFoundError, ValidationError } from "../utils/errors"
import { handleError, logger, outputJson } from "../utils/index"
import { getGlobalConfigPath } from "../utils/paths"
import {
	addCommonOptions,
	addGlobalOption,
	addProfileOption,
	validateProfileName,
} from "../utils/shared-options"

export interface RegistryOptions {
	cwd: string
	json?: boolean
	quiet?: boolean
	global?: boolean
	profile?: string
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
// REGISTRY TARGET RESOLUTION
// =============================================================================

interface RegistryTarget {
	scope: "profile" | "global" | "local"
	configPath: string
	configDir: string
	targetLabel: string
}

/**
 * Resolves the target config location for registry operations.
 * Handles mutual exclusivity checks and profile/global/local scope selection.
 */
async function resolveRegistryTarget(
	options: RegistryOptions,
	command: Command,
	cwd: string,
): Promise<RegistryTarget> {
	const cwdExplicitlyProvided = command.getOptionValueSource("cwd") === "cli"

	// Mutual exclusivity checks
	if (options.global && options.profile) {
		throw new ValidationError("Cannot use both --global and --profile flags")
	}
	if (cwdExplicitlyProvided && options.profile) {
		throw new ValidationError("Cannot use both --cwd and --profile flags")
	}
	if (options.global && cwdExplicitlyProvided) {
		throw new ValidationError("Cannot use both --global and --cwd flags")
	}

	// Profile scope
	if (options.profile) {
		validateProfileName(options.profile)

		const manager = await ProfileManager.requireInitialized()
		if (!(await manager.exists(options.profile))) {
			throw new ProfileNotFoundError(options.profile)
		}

		const configPath = getProfileOcxConfig(options.profile)
		if (!existsSync(configPath)) {
			throw new OcxConfigError(
				`Profile '${options.profile}' has no ocx.jsonc. Run 'ocx profile config ${options.profile}' to create it.`,
			)
		}

		return {
			scope: "profile",
			configPath,
			configDir: dirname(configPath),
			targetLabel: `profile '${options.profile}' config`,
		}
	}

	// Global scope
	if (options.global) {
		const configDir = getGlobalConfigPath()
		return {
			scope: "global",
			configPath: join(configDir, "ocx.jsonc"),
			configDir,
			targetLabel: "global config",
		}
	}

	// Local scope (default)
	const found = findOcxConfig(cwd)
	return {
		scope: "local",
		configPath: found.path,
		configDir: found.exists ? dirname(found.path) : join(cwd, ".opencode"),
		targetLabel: "local config",
	}
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
	addProfileOption(addCmd)
	addCommonOptions(addCmd)

	addCmd.action(async (url: string, options: RegistryAddOptions, command: Command) => {
		try {
			const cwd = options.cwd ?? process.cwd()
			const target = await resolveRegistryTarget(options, command, cwd)

			// Read config from resolved path
			const config = await readOcxConfig(target.configDir)
			if (!config) {
				const initHint =
					target.scope === "global"
						? "Run 'ocx init --global' first."
						: target.scope === "profile"
							? `Run 'ocx profile config ${options.profile}' to create it.`
							: "Run 'ocx init' first."
				logger.error(`${target.targetLabel} not found. ${initHint}`)
				process.exit(1)
			}

			const result = await runRegistryAddCore(url, options, {
				getRegistries: () => config.registries,
				isLocked: () => config.lockRegistries ?? false,
				setRegistry: async (name, regConfig) => {
					config.registries[name] = regConfig
					await writeOcxConfig(target.configDir, config, target.configPath)
				},
			})

			if (options.json) {
				outputJson({ success: true, data: result })
			} else if (!options.quiet) {
				if (result.updated) {
					logger.success(
						`Updated registry in ${target.targetLabel}: ${result.name} -> ${result.url}`,
					)
				} else {
					logger.success(`Added registry to ${target.targetLabel}: ${result.name} -> ${result.url}`)
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
	addProfileOption(removeCmd)
	addCommonOptions(removeCmd)

	removeCmd.action(async (name: string, options: RegistryOptions, command: Command) => {
		try {
			const cwd = options.cwd ?? process.cwd()
			const target = await resolveRegistryTarget(options, command, cwd)

			// Read config from resolved path
			const config = await readOcxConfig(target.configDir)
			if (!config) {
				const initHint =
					target.scope === "global"
						? "Run 'ocx init --global' first."
						: target.scope === "profile"
							? `Run 'ocx profile config ${options.profile}' to create it.`
							: "Run 'ocx init' first."
				logger.error(`${target.targetLabel} not found. ${initHint}`)
				process.exit(1)
			}

			const result = await runRegistryRemoveCore(name, {
				getRegistries: () => config.registries,
				isLocked: () => config.lockRegistries ?? false,
				removeRegistry: async (regName) => {
					delete config.registries[regName]
					await writeOcxConfig(target.configDir, config, target.configPath)
				},
			})

			if (options.json) {
				outputJson({ success: true, data: result })
			} else if (!options.quiet) {
				logger.success(`Removed registry from ${target.targetLabel}: ${result.removed}`)
			}
		} catch (error) {
			handleError(error, { json: options.json })
		}
	})

	// registry list
	const listCmd = registry.command("list").description("List configured registries")

	addGlobalOption(listCmd)
	addProfileOption(listCmd)
	addCommonOptions(listCmd)

	listCmd.action(async (options: RegistryOptions, command: Command) => {
		try {
			const cwd = options.cwd ?? process.cwd()
			const target = await resolveRegistryTarget(options, command, cwd)

			// Read config from resolved path
			const config = await readOcxConfig(target.configDir)
			if (!config) {
				const initHint =
					target.scope === "global"
						? "Run 'ocx init --global' first."
						: target.scope === "profile"
							? `Run 'ocx profile config ${options.profile}' to create it.`
							: "Run 'ocx init' first."
				logger.warn(`${target.targetLabel} not found. ${initHint}`)
				return
			}

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
					const scopeLabel =
						target.scope === "global"
							? " (global)"
							: target.scope === "profile"
								? ` (profile '${options.profile}')`
								: ""
					logger.info(
						`Configured registries${scopeLabel}${result.locked ? kleur.yellow(" (locked)") : ""}:`,
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

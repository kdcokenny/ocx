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
import { type DryRunResult, outputDryRun } from "../utils/dry-run"
import {
	ConfigError,
	ProfileNotFoundError,
	RegistryExistsError,
	ValidationError,
} from "../utils/errors"
import { handleError } from "../utils/handle-error"
import { outputJson } from "../utils/json-output"
import { logger } from "../utils/logger"
import { getGlobalConfigPath } from "../utils/paths"
import {
	addCommonOptions,
	addGlobalOption,
	addProfileOption,
	validateProfileName,
} from "../utils/shared-options"
import { normalizeRegistryUrl } from "../utils/url"

export interface RegistryOptions {
	cwd: string
	json?: boolean
	quiet?: boolean
	global?: boolean
	profile?: string
}

export interface RegistryAddOptions extends RegistryOptions {
	name: string // Always present — enforced by Commander .requiredOption()
	dryRun?: boolean
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
		targetLabel?: string // For dry-run summary
	},
): Promise<
	{ name: string; url: string; updated: boolean; alreadyConfigured: boolean } | DryRunResult
> {
	// Guard: Check registries aren't locked
	if (callbacks.isLocked?.()) {
		throw new Error("Registries are locked. Cannot add.")
	}

	// Validate and parse URL
	const trimmedUrl = url.trim()
	if (!trimmedUrl) {
		throw new ValidationError("Registry URL is required")
	}
	try {
		const parsed = new URL(trimmedUrl)
		if (!["http:", "https:"].includes(parsed.protocol)) {
			throw new ValidationError(`Invalid registry URL: ${trimmedUrl} (must use http or https)`)
		}
	} catch (error) {
		if (error instanceof ValidationError) throw error
		throw new ValidationError(`Invalid registry URL: ${trimmedUrl}`)
	}

	const normalizedUrl = normalizeRegistryUrl(trimmedUrl)

	const name = options.name
	const registries = callbacks.getRegistries()
	const existingByName = registries[name]

	// URL uniqueness check: find any existing registry with the same normalized URL
	const existingByUrl = findRegistryByUrl(registries, normalizedUrl)

	// Fetch registry index to validate the URL serves a valid registry
	const { fetchRegistryIndex } = await import("../registry/fetcher")
	await fetchRegistryIndex(normalizedUrl)

	// -------------------------------------------------------------------------
	// Conflict resolution matrix (alias-first model)
	// Rule 1: New name + new URL => add
	// Rule 2: Same name + same URL => idempotent no-op
	// Rule 3: Same name + different URL => fail (name conflict)
	// Rule 4: Different name + same URL => fail (URL conflict)
	// -------------------------------------------------------------------------

	const nameExists = existingByName !== undefined
	const urlExists = existingByUrl !== null
	const sameUrl = nameExists && normalizeRegistryUrl(existingByName.url) === normalizedUrl
	const urlOwnedByDifferentName = urlExists && existingByUrl.name !== name

	// Dry-run mode: report what would happen
	if (options.dryRun) {
		const warnings: string[] = []

		if (nameExists && !sameUrl) {
			warnings.push(
				`Registry '${name}' already exists with a different URL (${existingByName.url}). ` +
					`Run 'ocx registry remove ${name}' first, then re-add.`,
			)
		} else if (urlOwnedByDifferentName) {
			warnings.push(
				`URL '${normalizedUrl}' is already registered under name '${existingByUrl.name}'. ` +
					`Run 'ocx registry remove ${existingByUrl.name}' first, then re-add.`,
			)
		}

		const isConflict = (nameExists && !sameUrl) || urlOwnedByDifferentName
		const isIdempotent = nameExists && sameUrl
		const targetLabel = callbacks.targetLabel || "config"

		const dryRunResult: DryRunResult = {
			dryRun: true,
			command: "registry add",
			wouldPerform: isIdempotent
				? []
				: [
						{
							action: "add",
							target: `registry:${name}`,
							details: {
								url: normalizedUrl,
							},
						},
					],
			validation: {
				passed: !isConflict,
				warnings: warnings.length > 0 ? warnings : undefined,
			},
			summary: isConflict
				? `Would fail: conflict detected for registry '${name}'`
				: isIdempotent
					? `Registry '${name}' already configured with same URL (no-op)`
					: `Would add registry '${name}' to ${targetLabel}`,
		}

		return dryRunResult
	}

	// Rule 3: Same name + different URL => fail
	if (nameExists && !sameUrl) {
		throw new RegistryExistsError(name, existingByName.url, normalizedUrl, callbacks.targetLabel)
	}

	// Rule 4: Different name + same URL => fail
	if (urlOwnedByDifferentName) {
		throw new RegistryExistsError(
			name,
			normalizedUrl,
			normalizedUrl,
			callbacks.targetLabel,
			existingByUrl.name,
		)
	}

	// Rule 2: Same name + same URL => idempotent no-op
	if (nameExists && sameUrl) {
		return { name, url: normalizedUrl, updated: false, alreadyConfigured: true }
	}

	// Rule 1: New name + new URL => add
	await callbacks.setRegistry(name, {
		url: normalizedUrl,
	})

	return { name, url: normalizedUrl, updated: false, alreadyConfigured: false }
}

/**
 * Find an existing registry entry by normalized URL.
 * Returns the entry name and config if found, null otherwise.
 */
function findRegistryByUrl(
	registries: Record<string, RegistryConfig>,
	normalizedUrl: string,
): { name: string; config: RegistryConfig } | null {
	for (const [name, config] of Object.entries(registries)) {
		if (normalizeRegistryUrl(config.url) === normalizedUrl) {
			return { name, config }
		}
	}
	return null
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
}): { registries: Array<{ name: string; url: string }>; locked: boolean } {
	const registries = callbacks.getRegistries()
	const locked = callbacks.isLocked?.() ?? false

	const list = Object.entries(registries).map(([name, cfg]) => ({
		name,
		url: cfg.url,
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
			throw new ConfigError(
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

	// registry add <url> --name <name>
	const addCmd = registry
		.command("add")
		.description("Add a registry")
		.argument("<url>", "Registry URL")
		.requiredOption(
			"--name <name>",
			"Registry alias (required, used as lookup key for alias/component refs)",
		)
		.option("--dry-run", "Validate registry without adding to config")

	addGlobalOption(addCmd)
	addProfileOption(addCmd)
	addCommonOptions(addCmd)

	addCmd.action(async (url: string, options: RegistryAddOptions, command: Command) => {
		let target: RegistryTarget | undefined
		try {
			const cwd = options.cwd ?? process.cwd()
			target = await resolveRegistryTarget(options, command, cwd)
			const { configDir, configPath } = target

			// Read config from resolved path
			const config = await readOcxConfig(configDir)
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
					await writeOcxConfig(configDir, config, configPath)
				},
				targetLabel: target.targetLabel,
			})

			// Handle dry-run result
			if ("dryRun" in result && result.dryRun) {
				outputDryRun(result, { json: options.json, quiet: options.quiet })
				return
			}

			// Type narrowing: result is now the add-result shape
			const actualResult = result as {
				name: string
				url: string
				updated: boolean
				alreadyConfigured: boolean
			}

			if (options.json) {
				outputJson({ success: true, data: actualResult })
			} else if (!options.quiet) {
				if (actualResult.alreadyConfigured) {
					logger.info(`Registry already configured (no changes): ${actualResult.name}`)
				} else if (actualResult.updated) {
					logger.success(
						`Updated registry in ${target.targetLabel}: ${actualResult.name} -> ${actualResult.url}`,
					)
				} else {
					logger.success(
						`Added registry to ${target.targetLabel}: ${actualResult.name} -> ${actualResult.url}`,
					)
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
						console.log(`  ${kleur.cyan(reg.name)}: ${reg.url}`)
					}
				}
			}
		} catch (error) {
			handleError(error, { json: options.json })
		}
	})
}

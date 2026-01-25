/**
 * Profile Add Command
 *
 * Create a new global profile.
 * Optionally clone settings from an existing profile or install from registry.
 */

import type { Command } from "commander"
import { parse as parseJsonc } from "jsonc-parser"
import { atomicWrite } from "../../profile/atomic"
import { ProfileManager } from "../../profile/manager"
import { getGlobalConfig, getProfileOcxConfig } from "../../profile/paths"
import type { ProfileOcxConfig } from "../../schemas/ocx"
import { profileOcxConfigSchema } from "../../schemas/ocx"
import { ConfigError, ProfileExistsError, ValidationError } from "../../utils/errors"
import { handleError, logger } from "../../utils/index"
import { installProfileFromRegistry } from "./install-from-registry"

// =============================================================================
// FROM INPUT TYPES (Discriminated Union)
// =============================================================================

/**
 * Parsed --from input - discriminated union for type-safe routing.
 * Parsed at the boundary (Law 2: Parse Don't Validate).
 */
export type FromInput =
	| { type: "local-profile"; name: string }
	| { type: "registry"; namespace: string; component: string }

/**
 * Parse the --from option value to determine input type.
 *
 * Routing logic:
 * - Contains exactly one / → registry ref (namespace/component)
 * - No / → existing local profile name
 *
 * @param from - The --from option value
 * @returns Parsed FromInput with discriminated type
 */
export function parseFromOption(from: string): FromInput {
	// Guard: empty input
	if (!from?.trim()) {
		throw new ValidationError("--from value cannot be empty")
	}

	const trimmed = from.trim()

	// Route registry references: contains exactly one /
	const slashCount = (trimmed.match(/\//g) || []).length
	if (slashCount === 1) {
		const [namespace, component] = trimmed.split("/").map((s) => s.trim())
		if (!namespace || !component) {
			throw new ValidationError(
				`Invalid registry reference: "${from}". Expected format: namespace/component`,
			)
		}
		return { type: "registry", namespace, component }
	}

	// No slash → local profile name
	return { type: "local-profile", name: trimmed }
}

// =============================================================================
// COMMAND OPTIONS
// =============================================================================

interface ProfileAddOptions {
	from?: string
}

// =============================================================================
// GLOBAL CONFIG HELPERS
// =============================================================================

/**
 * Read and parse the global ocx.jsonc configuration.
 * Returns null if file doesn't exist.
 *
 * @throws ConfigError if file exists but is invalid
 */
async function readGlobalOcxConfig() {
	const configPath = getGlobalConfig()
	const file = Bun.file(configPath)

	if (!(await file.exists())) {
		return null
	}

	try {
		const content = await file.text()
		const json = parseJsonc(content, [], { allowTrailingComma: true })
		return profileOcxConfigSchema.parse(json)
	} catch (error) {
		// Guard: Wrap parse errors with helpful context (Law 4: Fail Fast, Fail Loud)
		if (error instanceof Error) {
			throw new ConfigError(
				`Failed to parse global config at "${configPath}": ${error.message}\n\n` +
					`Check the file for syntax errors or run: ocx config edit --global`,
			)
		}
		throw error
	}
}

/**
 * Get the global config with a specific registry, throwing if not configured.
 *
 * @param namespace - Registry namespace to require
 * @returns Global config and the registry URL
 * @throws ConfigError if registry is not configured globally
 */
async function requireGlobalRegistry(
	namespace: string,
): Promise<{ config: ProfileOcxConfig; registryUrl: string }> {
	const globalConfig = await readGlobalOcxConfig()

	// Guard: no global config
	if (!globalConfig) {
		throw new ConfigError(
			`Registry "${namespace}" is not configured globally.\n\n` +
				`Profile installation requires global registry configuration.\n` +
				`Run: ocx registry add <url> --name ${namespace} --global`,
		)
	}

	// Guard: registry not in global config
	const registry = globalConfig.registries[namespace]
	if (!registry) {
		throw new ConfigError(
			`Registry "${namespace}" is not configured globally.\n\n` +
				`Profile installation requires global registry configuration.\n` +
				`Run: ocx registry add <url> --name ${namespace} --global`,
		)
	}

	return { config: globalConfig, registryUrl: registry.url }
}

// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerProfileAddCommand(parent: Command): void {
	parent
		.command("add <name>")
		.description("Create a new profile, clone from existing, or install from registry")
		.option(
			"--from <source>",
			"Clone from existing profile or install from registry (e.g., kdco/minimal)",
		)
		.addHelpText(
			"after",
			`
Examples:
  $ ocx profile add work                      # Create empty profile
  $ ocx profile add work --from dev           # Clone from existing profile
  $ ocx profile add work --from kdco/minimal  # Install from registry
`,
		)
		.action(async (name: string, options: ProfileAddOptions) => {
			try {
				await runProfileAdd(name, options)
			} catch (error) {
				handleError(error)
			}
		})
}

// =============================================================================
// COMMAND IMPLEMENTATION
// =============================================================================

async function runProfileAdd(name: string, options: ProfileAddOptions): Promise<void> {
	const manager = await ProfileManager.requireInitialized()

	// Route based on --from input type
	if (!options.from) {
		// No --from: create empty profile
		await createEmptyProfile(manager, name)
		return
	}

	const fromInput = parseFromOption(options.from)

	switch (fromInput.type) {
		case "local-profile":
			await cloneFromLocalProfile(manager, name, fromInput.name)
			break

		case "registry": {
			// Validate registry is configured globally and get URL
			const { config: globalConfig, registryUrl } = await requireGlobalRegistry(fromInput.namespace)

			// Build registries map for dependency resolution
			const registries: Record<string, { url: string }> = {}
			for (const [ns, reg] of Object.entries(globalConfig.registries)) {
				registries[ns] = { url: reg.url }
			}

			// Install profile from registry
			await installProfileFromRegistry({
				namespace: fromInput.namespace,
				component: fromInput.component,
				profileName: name,
				registryUrl,
				registries,
			})
			break
		}
	}
}

/**
 * Create an empty profile with default configuration.
 */
async function createEmptyProfile(manager: ProfileManager, name: string): Promise<void> {
	const exists = await manager.exists(name)
	if (exists) {
		throw new ProfileExistsError(name, `Remove it first with 'ocx profile rm ${name}'.`)
	}
	await manager.add(name)
	logger.success(`Created profile "${name}"`)
}

/**
 * Clone settings from an existing local profile.
 */
async function cloneFromLocalProfile(
	manager: ProfileManager,
	name: string,
	sourceName: string,
): Promise<void> {
	// Guard: check if target profile already exists (Fail Fast)
	const exists = await manager.exists(name)
	if (exists) {
		throw new ProfileExistsError(name, `Remove it first with 'ocx profile rm ${name}'.`)
	}

	// Load source profile (fail fast if not found)
	const source = await manager.get(sourceName)

	await manager.add(name)

	// Copy OCX config from source
	await atomicWrite(getProfileOcxConfig(name), source.ocx)

	logger.success(`Created profile "${name}" (cloned from "${sourceName}")`)
}

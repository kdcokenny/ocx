/**
 * Profile Add Command
 *
 * Create a new profile (local by default, or global with --global flag).
 * Optionally clone settings from an existing profile or install from registry.
 */

import type { Command } from "commander"
import { parse as parseJsonc } from "jsonc-parser"
import { atomicWrite } from "../../profile/atomic"
import { ProfileManager } from "../../profile/manager"
import { getGlobalConfig, getLocalProfileOcxConfig, getProfileOcxConfig } from "../../profile/paths"
import type { Profile } from "../../profile/schema"
import type { ProfileOcxConfig } from "../../schemas/ocx"
import { profileOcxConfigSchema } from "../../schemas/ocx"
import {
	ConfigError,
	ProfileExistsError,
	ProfileNotFoundError,
	ValidationError,
} from "../../utils/errors"
import { handleError, logger, normalizeRegistryUrl } from "../../utils/index"
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
	| { type: "url"; url: string }

/**
 * Parse the --from option value to determine input type.
 *
 * Routing logic:
 * - Starts with http:// or https:// → URL (direct fetch)
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

	// Route URLs: starts with http:// or https://
	if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
		return { type: "url", url: trimmed }
	}

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
	global?: boolean
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
		.description(
			"Create a new profile (local by default), clone from existing, or install from registry",
		)
		.option(
			"--from <source>",
			"Clone from existing profile or install from registry (e.g., kdco/minimal)",
		)
		.option("-g, --global", "Create global profile (default: local overlay)")
		.addHelpText(
			"after",
			`
Examples:
  $ ocx profile add work                                  # Create local profile (.opencode/profiles/work/)
  $ ocx profile add work --global                         # Create global profile (~/.config/opencode/profiles/work/)
  $ ocx profile add work --from dev                       # Clone from existing (local by default)
  $ ocx profile add work --from dev --global              # Clone to global profile
  $ ocx profile add work --from kdco/minimal              # Install from registry (always global)
  $ ocx profile add work --from http://registry.com/prof  # Install from URL (always global)
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
		await createEmptyProfile(manager, name, options.global ?? false)
		return
	}

	const fromInput = parseFromOption(options.from)

	switch (fromInput.type) {
		case "local-profile":
			await cloneFromLocalProfile(manager, name, fromInput.name, options.global ?? false)
			break

		case "url": {
			// URL installation always creates global profiles
			if (!options.global) {
				logger.warn("URL installation requires --global flag. Creating global profile.")
			}

			// Parse URL to extract registry base and component name
			// e.g., http://localhost:8788/omo -> registry: http://localhost:8788, component: omo
			const url = new URL(fromInput.url)
			const pathParts = url.pathname.split("/").filter((p) => p.length > 0)

			if (pathParts.length === 0) {
				throw new ValidationError(
					`Invalid profile URL: "${fromInput.url}". ` +
						`URL must include a component path (e.g., http://registry.com/component)`,
				)
			}

			// Component is the last path segment
			const component = pathParts[pathParts.length - 1]
			if (!component) {
				throw new ValidationError(
					`Invalid profile URL: "${fromInput.url}". ` +
						`Could not extract component name from URL path.`,
				)
			}

			// Registry URL is everything except the last path segment
			pathParts.pop()
			url.pathname = pathParts.length > 0 ? `/${pathParts.join("/")}` : ""
			const registryUrl = normalizeRegistryUrl(url.toString()) // Remove trailing slash

			// Install profile from URL
			await installProfileFromRegistry({
				component,
				profileName: name,
				registryUrl,
			})
			break
		}

		case "registry": {
			// Registry installation always creates global profiles
			if (!options.global) {
				logger.warn("Registry installation requires --global flag. Creating global profile.")
			}

			// Validate registry is configured globally and get URL
			const { registryUrl } = await requireGlobalRegistry(fromInput.namespace)

			// Install profile from registry
			await installProfileFromRegistry({
				namespace: fromInput.namespace,
				component: fromInput.component,
				profileName: name,
				registryUrl,
			})
			break
		}
	}
}

/**
 * Create an empty profile with default configuration.
 */
async function createEmptyProfile(
	manager: ProfileManager,
	name: string,
	global: boolean,
): Promise<void> {
	const exists = await manager.exists(name, global)
	if (exists) {
		throw new ProfileExistsError(name, `Remove it first with 'ocx profile rm ${name}'.`)
	}
	await manager.add(name, global)
	const scope = global ? "global" : "local"
	logger.success(`Created ${scope} profile "${name}"`)
}

/**
 * Clone settings from an existing local profile.
 */
async function cloneFromLocalProfile(
	manager: ProfileManager,
	name: string,
	sourceName: string,
	global: boolean,
): Promise<void> {
	// Guard: check if target profile already exists (Fail Fast)
	const exists = await manager.exists(name, global)
	if (exists) {
		throw new ProfileExistsError(name, `Remove it first with 'ocx profile rm ${name}'.`)
	}

	// Load source profile (fail fast if not found)
	// Try to load from global first, then local
	let source: Profile
	try {
		source = await manager.get(sourceName)
	} catch {
		throw new ProfileNotFoundError(sourceName)
	}

	await manager.add(name, global)

	// Copy OCX config from source
	const targetOcxPath = global ? getProfileOcxConfig(name) : getLocalProfileOcxConfig(name)
	await atomicWrite(targetOcxPath, source.ocx)

	const scope = global ? "global" : "local"
	logger.success(`Created ${scope} profile "${name}" (cloned from "${sourceName}")`)
}

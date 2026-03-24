/**
 * Profile Add Command
 *
 * Create a new profile (global only — local profiles are unsupported).
 * Optionally clone settings from an existing profile or install from registry.
 *
 * Contract:
 * - Empty profile: `ocx profile add <name> --global`
 * - Clone profile: `ocx profile add <name> --clone <profile-name> --global`
 * - Install from configured registry: `ocx profile add <name> --source <namespace/component> --global`
 * - Install from ephemeral registry: `ocx profile add <name> --source <namespace/component> --from <registry-url> --global`
 */

import type { Command } from "commander"
import { parse as parseJsonc } from "jsonc-parser"
import { atomicCopy } from "../../profile/atomic"
import { ProfileManager } from "../../profile/manager"
import {
	getProfileOcxConfig,
	RequiredGlobalConfigReadError,
	readRequiredGlobalOcxConfig,
} from "../../profile/paths"
import type { ProfileOcxConfig } from "../../schemas/ocx"
import { profileOcxConfigSchema } from "../../schemas/ocx"
import {
	ConfigError,
	OCXError,
	ProfileExistsError,
	ProfileNotFoundError,
	ValidationError,
} from "../../utils/errors"
import { handleError } from "../../utils/handle-error"
import { outputJson } from "../../utils/json-output"
import { logger } from "../../utils/logger"
import { normalizeRegistryUrl } from "../../utils/url"
import { installProfileFromRegistry } from "./install-from-registry"

// =============================================================================
// SOURCE INPUT TYPES (Parsed at boundary)
// =============================================================================

/**
 * Parsed --source input - namespace/component format only.
 * Parsed at the boundary (Law 2: Parse Don't Validate).
 */
export interface SourceInput {
	namespace: string
	component: string
}

/**
 * Parse the --source option value to extract namespace and component.
 *
 * @param source - The --source option value (must be namespace/component format)
 * @returns Parsed SourceInput with namespace and component
 * @throws ValidationError if format is invalid
 */
export function parseSourceOption(source: string): SourceInput {
	// Guard: empty input
	if (!source?.trim()) {
		throw new ValidationError("--source value cannot be empty")
	}

	const trimmed = source.trim()

	// Must contain exactly one /
	const slashCount = (trimmed.match(/\//g) || []).length
	if (slashCount !== 1) {
		throw new ValidationError(`Invalid --source format: "${source}". Expected: namespace/component`)
	}

	const [namespace, component] = trimmed.split("/").map((s) => s.trim())
	if (!namespace || !component) {
		throw new ValidationError(`Invalid --source format: "${source}". Expected: namespace/component`)
	}

	return { namespace, component }
}

// =============================================================================
// COMMAND OPTIONS
// =============================================================================

interface ProfileAddOptions {
	clone?: string
	source?: string
	from?: string
	global?: boolean
	json?: boolean
}

interface ProfileAddResult {
	name: string
	scope: "local" | "global"
	mode: "empty" | "clone" | "registry"
	cloneFrom?: string
	registry?: {
		namespace: string
		component: string
		url: string
		ephemeral: boolean
	}
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
	let configPath = "global ocx config"

	try {
		const requiredConfig = await readRequiredGlobalOcxConfig()
		configPath = requiredConfig.path
		const content = requiredConfig.content
		const json = parseJsonc(content, [], { allowTrailingComma: true })
		return profileOcxConfigSchema.parse(json)
	} catch (error) {
		if (error instanceof RequiredGlobalConfigReadError) {
			throw error
		}

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
	let globalConfig: ProfileOcxConfig
	try {
		globalConfig = await readGlobalOcxConfig()
	} catch (error) {
		if (error instanceof RequiredGlobalConfigReadError) {
			throw new ConfigError(
				`Registry "${namespace}" is not configured globally.\n\n` +
					`Profile installation requires global registry configuration.\n` +
					`${error.message}\n` +
					`Run: ocx registry add <url> --name ${namespace} --global`,
			)
		}
		throw error
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
			"Create a new profile (--global required), clone from existing, or install from registry",
		)
		.option("--clone <profile>", "Clone from existing global profile")
		.option("--source <namespace/component>", "Install from registry (requires --global)")
		.option("--from <url>", "Ephemeral registry URL for --source (does not persist)")
		.option("-g, --global", "Create global profile (required — local profiles are unsupported)")
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			`
Examples:
  $ ocx profile add work --global                                     # Create global profile (~/.config/opencode/profiles/work/)
  $ ocx profile add work --clone dev --global                         # Clone from existing global profile
  $ ocx profile add work --source kdco/minimal --global               # Install from configured registry
  $ ocx profile add work --source kdco/minimal --from http://r.com --global  # Install from ephemeral registry
`,
		)
		.action(async (name: string, options: ProfileAddOptions) => {
			try {
				const result = await runProfileAdd(name, options)
				if (options.json) {
					outputJson({ success: true, data: result })
				}
			} catch (error) {
				handleError(error, { json: options.json })
			}
		})
}

// =============================================================================
// COMMAND IMPLEMENTATION
// =============================================================================

async function runProfileAdd(name: string, options: ProfileAddOptions): Promise<ProfileAddResult> {
	const quiet = options.json === true

	// ==========================================================================
	// Guard: Validate option combinations (Law 1: Early Exit, Law 4: Fail Fast)
	// These fire before the --global guard so their specific messages are preserved.
	// ==========================================================================

	// Guard: --clone cannot be used with --source or --from
	if (options.clone && (options.source || options.from)) {
		throw new ValidationError(
			"--clone cannot be used with --source or --from.\n\n" +
				"Use one of:\n" +
				"  ocx profile add <name> --clone <profile> --global   # Clone existing profile\n" +
				"  ocx profile add <name> --source <ns/comp> --global  # Install from registry",
		)
	}

	// Guard: --from requires --source
	if (options.from && !options.source) {
		// Detect legacy usage pattern and provide migration hint
		const fromValue = options.from.trim()
		const isUrl = fromValue.startsWith("http://") || fromValue.startsWith("https://")
		const isRegistryRef = (fromValue.match(/\//g) || []).length === 1 && !isUrl

		if (isRegistryRef) {
			// Legacy: --from namespace/component
			throw new ValidationError(
				`Invalid option: --from requires --source.\n\n` +
					`Migration: The --from option now only accepts registry URLs.\n` +
					`Use --source for namespace/component references:\n\n` +
					`  ocx profile add ${name} --source ${fromValue} --global`,
			)
		}

		if (isUrl) {
			// Legacy: --from <url> with component in path
			// Attempt to extract base URL safely for a helpful hint
			let migrationHint: string
			try {
				const parsed = new URL(fromValue)
				// Check if path has component-like segments (namespace/component)
				const pathSegments = parsed.pathname.split("/").filter(Boolean)
				if (pathSegments.length >= 2) {
					// Extract namespace/component from path and provide base URL
					const component = pathSegments.slice(-2).join("/")
					parsed.pathname = pathSegments.slice(0, -2).join("/") || "/"
					const baseUrl = parsed.toString().replace(/\/$/, "")
					migrationHint =
						`Migration: Separate the registry URL and component:\n\n` +
						`  ocx profile add ${name} --source ${component} --from ${baseUrl} --global`
				} else {
					// Path doesn't look like namespace/component - use generic template
					migrationHint =
						`Migration: Separate the registry URL and component:\n\n` +
						`  ocx profile add ${name} --source <namespace/component> --from <registry-url> --global`
				}
			} catch {
				// URL parsing failed - use generic template
				migrationHint =
					`Migration: Separate the registry URL and component:\n\n` +
					`  ocx profile add ${name} --source <namespace/component> --from <registry-url> --global`
			}
			throw new ValidationError(`Invalid option: --from requires --source.\n\n${migrationHint}`)
		}

		// Plain profile name - suggest --clone instead
		throw new ValidationError(
			`Invalid option: --from requires --source.\n\n` +
				`Did you mean to clone a profile?\n\n` +
				`  ocx profile add ${name} --clone ${fromValue} --global`,
		)
	}

	// Guard: --source requires --global
	if (options.source && !options.global) {
		throw new ValidationError(
			"--source requires --global flag.\n\n" +
				"Profile installation from registries is only supported for global profiles:\n\n" +
				`  ocx profile add ${name} --source ${options.source} --global`,
		)
	}

	// Guard: Validate --from is a well-formed URL when provided with --source (Law 2: Parse at boundary)
	if (options.from) {
		const fromValue = options.from.trim()
		try {
			const parsed = new URL(fromValue)
			// Require http/https protocol
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				throw new ValidationError(
					`Invalid --from value: "${options.from}".\n\n` +
						"--from must be a registry URL with http:// or https:// protocol.\n" +
						"For profile cloning, use --clone instead.",
				)
			}
			// Require valid hostname (catches http:// or https:///)
			if (!parsed.hostname) {
				throw new ValidationError(
					`Invalid --from value: "${options.from}".\n\n` +
						"--from must be a valid registry URL with a hostname.\n" +
						"Example: --from https://registry.example.com",
				)
			}
		} catch (error) {
			// URL constructor throws TypeError for malformed URLs
			if (error instanceof ValidationError) {
				throw error
			}
			throw new ValidationError(
				`Invalid --from value: "${options.from}".\n\n` +
					"--from must be a valid registry URL (http:// or https://).\n" +
					"Example: --from https://registry.example.com",
			)
		}
	}

	// ==========================================================================
	// Guard: Local profiles are unsupported (catch-all after specific guards)
	// ==========================================================================
	if (!options.global) {
		throw new ConfigError(
			"Local profiles are unsupported. Use --global to create a global profile.\n\n" +
				`  ocx profile add ${name} --global`,
		)
	}

	const scope = "global" as const

	// ==========================================================================
	// Route to appropriate handler
	// ==========================================================================

	const manager = await ProfileManager.requireInitialized()

	// Route: --clone (profile cloning)
	if (options.clone) {
		await cloneFromGlobalProfile(manager, name, options.clone, quiet)
		return {
			name,
			scope,
			mode: "clone",
			cloneFrom: options.clone,
		}
	}

	// Route: --source (registry installation)
	if (options.source) {
		const { namespace, component } = parseSourceOption(options.source)
		let registryUrl: string

		if (options.from) {
			// Ephemeral registry URL
			registryUrl = normalizeRegistryUrl(options.from.trim())
			await installProfileFromRegistry({
				namespace,
				component,
				profileName: name,
				registryUrl,
				quiet,
			})
		} else {
			// Configured registry
			const globalRegistry = await requireGlobalRegistry(namespace)
			registryUrl = globalRegistry.registryUrl
			await installProfileFromRegistry({
				namespace,
				component,
				profileName: name,
				registryUrl,
				quiet,
			})
		}

		return {
			name,
			scope,
			mode: "registry",
			registry: {
				namespace,
				component,
				url: registryUrl,
				ephemeral: Boolean(options.from),
			},
		}
	}

	// Route: No options (empty profile creation)
	await createEmptyProfile(manager, name, quiet)

	return {
		name,
		scope,
		mode: "empty",
	}
}

/**
 * Create an empty profile with default configuration.
 */
async function createEmptyProfile(
	manager: ProfileManager,
	name: string,
	quiet: boolean,
): Promise<void> {
	const exists = await manager.exists(name)
	if (exists) {
		throw new ProfileExistsError(name, `Remove it first with 'ocx profile rm ${name} --global'.`)
	}
	await manager.add(name)
	if (!quiet) {
		logger.success(`Created global profile "${name}"`)
	}
}

/**
 * Clone settings from an existing global profile.
 */
async function cloneFromGlobalProfile(
	manager: ProfileManager,
	name: string,
	sourceName: string,
	quiet: boolean,
): Promise<void> {
	// Guard: check if target profile already exists (Fail Fast)
	const exists = await manager.exists(name)
	if (exists) {
		throw new ProfileExistsError(name, `Remove it first with 'ocx profile rm ${name} --global'.`)
	}

	// Load source from global scope
	try {
		await manager.get(sourceName)
	} catch (error) {
		// Re-throw known errors with enhanced scope context
		if (error instanceof ProfileNotFoundError) {
			throw new ProfileNotFoundError(
				sourceName,
				`Profile '${sourceName}' not found in global scope.`,
			)
		}
		if (error instanceof OCXError) {
			throw error
		}
		// Wrap unknown errors with context
		throw new ValidationError(
			`Failed to load profile '${sourceName}': ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	await manager.add(name)

	// Copy OCX config from source (byte-for-byte)
	const sourceOcxPath = getProfileOcxConfig(sourceName)
	const targetOcxPath = getProfileOcxConfig(name)
	await atomicCopy(sourceOcxPath, targetOcxPath)

	if (!quiet) {
		logger.success(`Created global profile "${name}" (cloned from "${sourceName}")`)
	}
}

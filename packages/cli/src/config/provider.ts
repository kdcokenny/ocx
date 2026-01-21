/**
 * ConfigProvider Interface
 *
 * Abstract configuration provider pattern following the 5 Laws of Elegant Defense:
 * - Parse at boundary (async factory), sync getters (trusted internal state)
 * - Early exit via guard clauses in factories
 * - Fail fast with descriptive errors
 *
 * Implementations parse config at construction; getters are sync and pure.
 */

import { type OcxConfig, type RegistryConfig, readOcxConfig } from "../schemas/config"
import { ConfigError } from "../utils/errors"
import { getGlobalConfigPath, globalDirectoryExists } from "../utils/paths"

// =============================================================================
// INTERFACE
// =============================================================================

/**
 * Abstract configuration provider interface.
 * Implementations parse config at construction (boundary), getters are sync and pure.
 */
export interface ConfigProvider {
	/** Working directory for this config context */
	readonly cwd: string

	/** Get registries (sync - data already parsed at construction) */
	getRegistries(): Record<string, RegistryConfig>

	/** Get component installation path */
	getComponentPath(): string
}

// =============================================================================
// LOCAL CONFIG PROVIDER
// =============================================================================

/**
 * Provides configuration from local project (ocx.jsonc).
 *
 * Use this when operating on a project with an ocx.jsonc file.
 */
export class LocalConfigProvider implements ConfigProvider {
	readonly cwd: string
	private readonly config: OcxConfig // immutable, parsed at construction

	private constructor(cwd: string, config: OcxConfig) {
		this.cwd = cwd
		this.config = config
	}

	/**
	 * Require an initialized local config, throwing if not found.
	 * Use this in commands that require a local ocx.jsonc to exist.
	 *
	 * @throws ConfigError if ocx.jsonc doesn't exist or is invalid
	 * @returns LocalConfigProvider instance guaranteed to have valid config
	 */
	static async requireInitialized(cwd: string): Promise<LocalConfigProvider> {
		const config = await readOcxConfig(cwd)

		// Guard: No config file (Law 1: Early Exit)
		if (!config) {
			throw new ConfigError(
				"No ocx.jsonc found in .opencode/ or project root. Run 'ocx init' first.",
			)
		}

		return new LocalConfigProvider(cwd, config)
	}

	getRegistries(): Record<string, RegistryConfig> {
		return this.config.registries
	}

	getComponentPath(): string {
		// Default to .opencode directory for local projects
		return ".opencode"
	}

	/** Get the raw config for advanced use cases */
	getConfig(): OcxConfig {
		return this.config
	}
}

// =============================================================================
// GLOBAL CONFIG PROVIDER
// =============================================================================

/**
 * Config provider for global OpenCode installations.
 * Installs to ~/.config/opencode/ without .opencode prefix.
 */
export class GlobalConfigProvider implements ConfigProvider {
	readonly cwd: string
	private readonly config: OcxConfig | null

	private constructor(basePath: string, config: OcxConfig | null) {
		this.cwd = basePath
		this.config = config
	}

	/**
	 * Require an initialized global config, throwing if not found.
	 * Use this in commands that require global OpenCode config to exist.
	 *
	 * @throws ConfigError if OpenCode hasn't been initialized globally
	 * @returns GlobalConfigProvider instance guaranteed to have valid config
	 */
	static async requireInitialized(): Promise<GlobalConfigProvider> {
		const basePath = getGlobalConfigPath()

		// Guard: Global directory must exist (Law 1: Early Exit)
		if (!(await globalDirectoryExists())) {
			throw new ConfigError(
				"Global config not found. Run 'opencode' once to initialize, then retry.",
			)
		}

		// Load ocx.jsonc if it exists (returns null if not found)
		const config = await readOcxConfig(basePath)

		return new GlobalConfigProvider(basePath, config)
	}

	getRegistries(): Record<string, RegistryConfig> {
		return this.config?.registries ?? {}
	}

	/**
	 * Returns empty string - global installs have no .opencode prefix.
	 */
	getComponentPath(): string {
		return ""
	}
}

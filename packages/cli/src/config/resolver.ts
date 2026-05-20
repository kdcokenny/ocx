/**
 * ConfigResolver - Global Profile Resolution
 *
 * Profile selection via `.opencode/ocx.jsonc` field: `{ "profile": "work" }`
 * Profiles are global-only (~/.config/opencode/profiles/). Local profiles are
 * unsupported and produce a hard error via ProfileManager.getLayered().
 *
 * Visibility controlled by profile `ocx.jsonc` include/exclude patterns.
 * OCX configs (ocx.jsonc) remain ISOLATED per scope - they do NOT merge.
 * OpenCode configs (opencode.jsonc) ALWAYS merge: profile → local.
 * Local opencode.jsonc always participates regardless of exclude/include
 * patterns, matching OpenCode's native layering semantics.
 *
 * This is controlled by exclude/include patterns from the profile.
 *
 * Security: This isolation prevents global registries from injecting
 * components into all projects.
 *
 * Follows the 5 Laws of Elegant Defense:
 * - Law 1 (Early Exit): Guard clauses handle edge cases at top
 * - Law 2 (Parse Don't Validate): Async factory parses at boundary, sync getters use trusted state
 * - Law 3 (Atomic Predictability): Pure resolve method, no hidden mutations
 * - Law 4 (Fail Fast): Throws ProfileNotFoundError for missing profiles
 * - Law 5 (Intentional Naming): Names describe exact purpose
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, relative } from "node:path"
import { Glob } from "bun"
import { type ParseError, parse as parseJsonc } from "jsonc-parser"
import { ProfileManager } from "../profile/manager"
import {
	findLocalConfigDir,
	getProfileDir,
	LOCAL_CONFIG_DIR,
	OCX_CONFIG_FILE,
	OPENCODE_CONFIG_FILE,
} from "../profile/paths"
import type { Profile } from "../profile/schema"
import { mergeOpencodeConfig } from "../registry/merge"
import type { OcxConfig, RegistryConfig } from "../schemas/config"
import { ocxConfigSchema, readReceipt } from "../schemas/config"
import type { NormalizedOpencodeConfig } from "../schemas/registry"
import { ConfigError, ProfileNotFoundError, ProfilesNotInitializedError } from "../utils/errors"
import { resolveGitRootSync } from "../utils/git-root"
import { resolveRegistryInstructionPaths } from "../utils/instruction-paths"
import { formatJsoncParseError } from "../utils/jsonc"
import { getGlobalConfigPath } from "../utils/paths"

// =============================================================================
// TYPES
// =============================================================================

/**
 * The fully resolved configuration from all sources.
 */
export interface ResolvedConfig {
	/** Registries from active scope (profile OR local, never merged) */
	registries: Record<string, RegistryConfig>
	/** Component installation path */
	componentPath: string
	/** Merged OpenCode config */
	opencode: Record<string, unknown>
	/** Discovered instruction files (filtered by exclude/include) */
	instructions: string[]
	/** The resolved profile name, or null if no profile */
	profileName: string | null
}

/**
 * Source of a configuration value for debugging.
 */
export type ConfigSource = "global-profile" | "local-config" | "local-opencode" | "default"

/**
 * Tracks where a configuration value originated.
 */
export interface ConfigOrigin {
	path: string
	source: ConfigSource
}

/**
 * Resolved configuration with origin tracking for debugging.
 */
export interface ResolvedConfigWithOrigin extends ResolvedConfig {
	/** Origin tracking for each setting (for debugging) */
	origins: Map<string, ConfigOrigin>
}

type ProfileResolutionSource = "none" | "local-config" | "cli" | "env" | "default"

function isExplicitProfileSource(source: ProfileResolutionSource): boolean {
	return source === "local-config" || source === "cli" || source === "env"
}

function requireNonEmptyExplicitProfile(profileName: string, sourceDescription: string): string {
	if (profileName.trim().length === 0) {
		throw new ConfigError(
			`Invalid profile from ${sourceDescription}: value cannot be empty or whitespace`,
		)
	}

	return profileName
}

function parseLocalOcxConfig(configPath: string): OcxConfig {
	let text: string
	try {
		text = readFileSync(configPath, "utf8")
	} catch (error) {
		const reason = error instanceof Error ? error.message : "Unknown read error"
		throw new ConfigError(`Failed to read local config at ${configPath}: ${reason}`)
	}

	const parseErrors: ParseError[] = []
	const parsed = parseJsonc(text, parseErrors, { allowTrailingComma: true })
	if (parseErrors.length > 0) {
		const errorDetail = formatJsoncParseError(parseErrors)
		throw new ConfigError(`Invalid JSONC in local config at ${configPath}: ${errorDetail}`)
	}

	const validationResult = ocxConfigSchema.safeParse(parsed)
	if (!validationResult.success) {
		const firstIssue = validationResult.error.issues[0]
		const issuePath = firstIssue?.path.length ? firstIssue.path.join(".") : "root"
		const issueMessage = firstIssue?.message ?? "Invalid OCX config"
		throw new ConfigError(`Invalid local config at ${configPath}: ${issuePath} ${issueMessage}`)
	}

	return validationResult.data
}

function parseLocalOpencodeConfig(configPath: string): Record<string, unknown> {
	let text: string
	try {
		text = readFileSync(configPath, "utf8")
	} catch (error) {
		const reason = error instanceof Error ? error.message : "Unknown read error"
		throw new ConfigError(`Failed to read local OpenCode config at ${configPath}: ${reason}`)
	}

	const parseErrors: ParseError[] = []
	const parsed = parseJsonc(text, parseErrors, { allowTrailingComma: true })
	if (parseErrors.length > 0) {
		const errorDetail = formatJsoncParseError(parseErrors)
		throw new ConfigError(`Invalid JSONC in local OpenCode config at ${configPath}: ${errorDetail}`)
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ConfigError(`Invalid local OpenCode config at ${configPath}: root must be an object`)
	}

	return parsed as Record<string, unknown>
}

// =============================================================================
// INSTRUCTION FILE DISCOVERY
// =============================================================================

/**
 * Instruction file types to search for, in priority order.
 * OpenCode uses "first type wins" pattern - if ANY files of the first type
 * are found, only those are used (remaining types are not checked).
 *
 * Reference: https://github.com/sst/opencode/blob/dev/packages/opencode/src/session/instruction.ts#L75-L84
 */
const INSTRUCTION_FILES = [
	"AGENTS.md",
	"CLAUDE.md",
	"CONTEXT.md", // Deprecated - kept for OpenCode compatibility
] as const

/**
 * Find instruction files of a specific type by walking UP from projectDir to gitRoot.
 * Returns repo-relative paths in deepest-first order.
 */
function findInstructionsByType(filename: string, projectDir: string, gitRoot: string): string[] {
	const discovered: string[] = []
	let currentDir = projectDir

	// Walk up from projectDir to root
	while (true) {
		const filePath = join(currentDir, filename)
		if (existsSync(filePath) && statSync(filePath).isFile()) {
			// Store as relative to root
			const relativePath = relative(gitRoot, filePath)
			discovered.push(relativePath)
		}

		// Stop if we've reached the root
		if (currentDir === gitRoot) break

		// Move up one directory
		const parentDir = join(currentDir, "..")
		if (parentDir === currentDir) break // filesystem root
		currentDir = parentDir
	}

	return discovered
}

/**
 * Discover instruction files by walking UP from projectDir to gitRoot.
 * Implements OpenCode's "first type wins" pattern - searches for AGENTS.md first,
 * only checks CLAUDE.md if no AGENTS.md found, and CONTEXT.md only if neither found.
 *
 * Returns repo-relative paths, deepest first.
 *
 * Reference: https://github.com/sst/opencode/blob/dev/packages/opencode/src/session/instruction.ts#L75-L84
 */
function discoverInstructionFiles(projectDir: string, gitRoot: string): string[] {
	// First type wins - check each type in priority order
	for (const filename of INSTRUCTION_FILES) {
		const matches = findInstructionsByType(filename, projectDir, gitRoot)
		if (matches.length > 0) {
			return matches // Return immediately - first type wins
		}
	}

	return []
}

/**
 * Normalize a glob pattern by stripping leading "./" for consistent matching.
 * Discovered paths are repo-relative (e.g. "src/AGENTS.md") so patterns
 * with "./" prefix (e.g. "./src/AGENTS.md") need normalization to match.
 */
function normalizePattern(pattern: string): string {
	return pattern.startsWith("./") ? pattern.slice(2) : pattern
}

/**
 * Filter files using TypeScript/Vite style include/exclude.
 * Include overrides exclude, order is preserved.
 */
function filterByPatterns(files: string[], exclude: string[], include: string[]): string[] {
	return files.filter((file) => {
		// Check include first - include overrides exclude
		for (const pattern of include) {
			const glob = new Glob(normalizePattern(pattern))
			if (glob.match(file)) return true
		}

		// Check exclude
		for (const pattern of exclude) {
			const glob = new Glob(normalizePattern(pattern))
			if (glob.match(file)) return false
		}

		// Not matched by include or exclude - keep it
		return true
	})
}

// =============================================================================
// REGISTRY INSTRUCTION LOADING
// =============================================================================

/**
 * Load and resolve registry-provided instruction paths from installed components.
 * Reads the receipt and resolves install-root-relative paths to absolute paths.
 *
 * @param installRoot - The install root directory (absolute)
 * @returns Array of absolute instruction paths (deduplicated)
 */
async function loadRegistryInstructionsFromReceipt(installRoot: string): Promise<string[]> {
	const receipt = await readReceipt(installRoot)

	// Early exit: no receipt or no installed components
	if (!receipt || Object.keys(receipt.installed).length === 0) {
		return []
	}

	const allInstructions: string[] = []

	// Collect all instruction paths from all installed components
	for (const [canonicalId, entry] of Object.entries(receipt.installed)) {
		// Guard: Skip components without opencode config
		if (!entry.opencode?.instructions) {
			continue
		}

		const instructions = entry.opencode.instructions
		// Guard: Skip if not an array
		if (!Array.isArray(instructions)) {
			continue
		}

		// Source description for error messages
		const source = `${entry.registryName}/${entry.name} (${canonicalId})`

		// Resolve each instruction path (validates and expands globs)
		const resolved = resolveRegistryInstructionPaths(instructions, installRoot, source)
		allInstructions.push(...resolved)
	}

	// Deduplicate (already done in resolveRegistryInstructionPaths, but safe to repeat)
	return Array.from(new Set(allInstructions))
}

// =============================================================================
// CONFIG RESOLVER
// =============================================================================

/**
 * Configuration resolver with scope-isolated registries.
 *
 * Registries are scoped: profile registries OR local registries, never merged.
 * OpenCode config and instructions use additive merging across scopes.
 *
 * Use the static `create()` factory to construct; it parses at the boundary
 * so that `resolve()` and getter methods are synchronous and pure.
 */
export class ConfigResolver {
	private readonly cwd: string
	private readonly profileName: string | null
	private readonly profile: Profile | null
	private readonly localConfigDir: string | null
	private readonly registryInstructions: string[]

	// Cached resolution (computed lazily, memoized)
	private cachedConfig: ResolvedConfig | null = null

	private constructor(
		cwd: string,
		profileName: string | null,
		profile: Profile | null,
		localConfigDir: string | null,
		registryInstructions: string[],
	) {
		this.cwd = cwd
		this.profileName = profileName
		this.profile = profile
		this.localConfigDir = localConfigDir
		this.registryInstructions = registryInstructions
	}

	/**
	 * Create a ConfigResolver for the given directory.
	 *
	 * Parses configuration at the boundary (Law 2: Parse Don't Validate).
	 * After construction, all getter methods are synchronous.
	 *
	 * Profile Resolution:
	 * 1. Check local `.opencode/ocx.jsonc` for `profile` field
	 * 2. Fall back to options.profile
	 * 3. Fall back to OCX_PROFILE env var
	 * 4. Fall back to "default" profile (if it exists)
	 * 5. No profile (base configs only)
	 *
	 * Explicit sources (local config, CLI, env) fail fast when invalid.
	 * Only implicit/default resolution can fall back to base config.
	 *
	 * @param cwd - Working directory
	 * @param options - Optional profile override
	 * @throws ProfileNotFoundError if specified profile doesn't exist
	 */
	static async create(cwd: string, options?: { profile?: string }): Promise<ConfigResolver> {
		const manager = ProfileManager.create(cwd)

		// Resolve profile intent with explicit precedence:
		// local config > CLI option > environment > implicit default
		let profileName: string | null = null
		let profileSource: ProfileResolutionSource = "none"
		const localConfigDir = findLocalConfigDir(cwd)
		if (localConfigDir) {
			const localOcxPath = join(localConfigDir, OCX_CONFIG_FILE)
			if (existsSync(localOcxPath)) {
				const localConfig = parseLocalOcxConfig(localOcxPath)
				if (localConfig.profile !== undefined) {
					profileName = requireNonEmptyExplicitProfile(
						localConfig.profile,
						`local config at ${localOcxPath}`,
					)
					profileSource = "local-config"
				}
			}
		}

		// Preserve short-circuit precedence:
		// once a higher-priority source is selected, lower-priority sources are ignored.
		if (profileName === null) {
			if (options?.profile !== undefined) {
				profileName = requireNonEmptyExplicitProfile(options.profile, "CLI option --profile")
				profileSource = "cli"
			} else if (process.env.OCX_PROFILE !== undefined) {
				profileName = requireNonEmptyExplicitProfile(
					process.env.OCX_PROFILE,
					"environment variable OCX_PROFILE",
				)
				profileSource = "env"
			}
		}

		const isInitialized = await manager.isInitialized()
		if (isExplicitProfileSource(profileSource) && !isInitialized) {
			throw new ProfilesNotInitializedError()
		}

		let profile: Profile | null = null

		if (isInitialized) {
			// Explicit sources must fail fast: no fallback to default/base config.
			if (profileName !== null) {
				profile = await manager.getLayered(profileName, cwd)
			} else {
				try {
					// Implicit resolution can still fall back to base config.
					profileName = await manager.resolveProfile()
					profile = await manager.getLayered(profileName, cwd)
					profileSource = "default"
				} catch (error) {
					if (!(error instanceof ProfileNotFoundError) || error.profile !== "default") {
						throw error
					}

					profileName = null
					profile = null
					profileSource = "none"
				}
			}
		}

		// Load registry-provided instructions from receipt
		// Install root selection:
		// - Profile active → profile directory
		// - Local config exists → project root (parent of .opencode)
		// - Otherwise → global config directory
		let installRoot: string
		if (profile) {
			// Use resolved profile object, not profileName
			// profileName could be set but profile failed to load
			installRoot = getProfileDir(profileName as string)
		} else if (localConfigDir) {
			// Project root is parent of .opencode directory
			installRoot = join(localConfigDir, "..")
		} else {
			installRoot = getGlobalConfigPath()
		}

		const registryInstructions = await loadRegistryInstructionsFromReceipt(installRoot)

		return new ConfigResolver(cwd, profileName, profile, localConfigDir, registryInstructions)
	}

	/**
	 * Resolve configuration with global profile support.
	 *
	 * - Registries: Profile OR local (isolated, not merged)
	 * - OpenCode config: Always merged (profile + local) to match OpenCode layering.
	 *   Local opencode.jsonc always participates in merge regardless of exclude/include
	 *   patterns, because exclude/include controls instruction file discovery, not config merging.
	 *
	 * Uses memoization - first call computes, subsequent calls return cached result.
	 * Pure function (Law 3: Atomic Predictability) - same instance always returns same result.
	 */
	resolve(): ResolvedConfig {
		// Return cached if available
		if (this.cachedConfig) {
			return this.cachedConfig
		}

		// 1. Start with defaults
		let registries: Record<string, RegistryConfig> = {}
		let componentPath = LOCAL_CONFIG_DIR
		let opencode: Record<string, unknown> = {}

		// 2. Apply global profile if resolved
		if (this.profile) {
			registries = { ...registries, ...this.profile.ocx.registries }
			if (this.profile.ocx.componentPath) {
				componentPath = this.profile.ocx.componentPath
			}
			if (this.profile.opencode) {
				opencode = this.mergeOpencode(opencode, this.profile.opencode)
			}
		}

		// 3. Check exclude/include patterns (for instruction files and OCX registries only)
		const shouldLoadLocalOcx = this.shouldLoadLocalConfig()

		// 4. Apply local OCX registries ONLY when no profile active (isolation)
		if (!this.profile && shouldLoadLocalOcx && this.localConfigDir) {
			const localOcxConfig = this.loadLocalOcxConfig()
			if (localOcxConfig) {
				registries = localOcxConfig.registries
			}
		}

		// 5. Apply local OpenCode config (ALWAYS merges with profile)
		// Local opencode.jsonc always participates in merge regardless of exclude/include
		// patterns to match OpenCode's layering semantics.
		if (this.localConfigDir) {
			const localOpencodeConfig = this.loadLocalOpencodeConfig()
			if (localOpencodeConfig) {
				opencode = this.mergeOpencode(opencode, localOpencodeConfig)
			}
		}

		// 6. Discover instruction files
		const instructions = this.discoverInstructions()

		this.cachedConfig = {
			registries,
			componentPath,
			opencode,
			instructions,
			profileName: this.profileName,
		}

		return this.cachedConfig
	}

	/**
	 * Resolve config with origin tracking for debugging.
	 * Used by `ocx config show --origin`
	 */
	resolveWithOrigin(): ResolvedConfigWithOrigin {
		const origins = new Map<string, ConfigOrigin>()

		// 1. Start with defaults
		const registries: Record<string, RegistryConfig> = {}
		let componentPath = LOCAL_CONFIG_DIR
		let opencode: Record<string, unknown> = {}

		origins.set("componentPath", { path: "", source: "default" })

		// 2. Apply global profile if resolved
		if (this.profile) {
			const profileOcxPath = `~/.config/opencode/profiles/${this.profileName}/ocx.jsonc`

			for (const [key, value] of Object.entries(this.profile.ocx.registries)) {
				registries[key] = value
				origins.set(`registries.${key}`, { path: profileOcxPath, source: "global-profile" })
			}

			if (this.profile.ocx.componentPath) {
				componentPath = this.profile.ocx.componentPath
				origins.set("componentPath", { path: profileOcxPath, source: "global-profile" })
			}

			if (this.profile.opencode) {
				opencode = this.mergeOpencode(opencode, this.profile.opencode)
				const profileOpencodePath = `~/.config/opencode/profiles/${this.profileName}/opencode.jsonc`
				for (const key of Object.keys(this.profile.opencode)) {
					origins.set(`opencode.${key}`, { path: profileOpencodePath, source: "global-profile" })
				}
			}
		}

		// 3. Check exclude/include patterns (for instruction files and OCX registries only)
		const shouldLoadLocalOcx = this.shouldLoadLocalConfig()

		// 4. Apply local OCX registries ONLY when no profile active (isolation)
		if (!this.profile && shouldLoadLocalOcx && this.localConfigDir) {
			const localOcxConfig = this.loadLocalOcxConfig()
			if (localOcxConfig) {
				const localOcxPath = join(this.localConfigDir, OCX_CONFIG_FILE)
				for (const [key, value] of Object.entries(localOcxConfig.registries)) {
					registries[key] = value
					origins.set(`registries.${key}`, { path: localOcxPath, source: "local-config" })
				}
			}
		}

		// 5. Apply local OpenCode config (ALWAYS merges with profile)
		// Local opencode.jsonc always participates in merge regardless of exclude/include
		// patterns to match OpenCode's layering semantics.
		if (this.localConfigDir) {
			const localOpencodeConfig = this.loadLocalOpencodeConfig()
			if (localOpencodeConfig) {
				opencode = this.mergeOpencode(opencode, localOpencodeConfig)
				const localOpencodePath = join(this.localConfigDir, OPENCODE_CONFIG_FILE)
				for (const key of Object.keys(localOpencodeConfig)) {
					origins.set(`opencode.${key}`, { path: localOpencodePath, source: "local-opencode" })
				}
			}
		}

		// 6. Discover instruction files
		const instructions = this.discoverInstructions()

		return {
			registries,
			componentPath,
			opencode,
			instructions,
			profileName: this.profileName,
			origins,
		}
	}

	/**
	 * Check if local config should be loaded based on exclude/include patterns.
	 *
	 * Returns true if local .opencode/ directory is NOT excluded by profile patterns.
	 */
	private shouldLoadLocalConfig(): boolean {
		// If no profile or no exclude patterns, load local config
		if (!this.profile?.ocx.exclude) return true
		if (!this.localConfigDir) return true

		// Get git root for relative path calculation (supports worktrees)
		const gitRoot = resolveGitRootSync(this.cwd)
		const root = gitRoot

		// Get relative path of local config dir from root
		const relativePath = relative(root, this.localConfigDir)

		// Check if .opencode directory matches exclude patterns
		const exclude = this.profile.ocx.exclude ?? []
		const include = this.profile.ocx.include ?? []

		// Check include first - include overrides exclude
		for (const pattern of include) {
			const glob = new Glob(normalizePattern(pattern))
			// Match the directory path with trailing content
			if (glob.match(`${relativePath}/`) || glob.match(relativePath)) {
				return true
			}
		}

		// Check exclude
		for (const pattern of exclude) {
			const glob = new Glob(normalizePattern(pattern))
			// Check if pattern matches .opencode directory
			if (glob.match(`${relativePath}/`) || glob.match(`${relativePath}/**`)) {
				return false
			}
		}

		return true
	}

	/**
	 * Load local ocx.jsonc configuration.
	 * Returns null if file doesn't exist.
	 * Throws ConfigError if the file exists but is invalid.
	 */
	private loadLocalOcxConfig(): { registries: Record<string, RegistryConfig> } | null {
		if (!this.localConfigDir) return null

		const configPath = join(this.localConfigDir, OCX_CONFIG_FILE)
		if (!existsSync(configPath)) return null

		const parsed = parseLocalOcxConfig(configPath)
		return {
			registries: parsed.registries,
		}
	}

	/**
	 * Load local opencode.jsonc configuration.
	 * Returns null if file doesn't exist.
	 * Throws ConfigError if the file exists but is invalid.
	 */
	private loadLocalOpencodeConfig(): Record<string, unknown> | null {
		if (!this.localConfigDir) return null

		const configPath = join(this.localConfigDir, OPENCODE_CONFIG_FILE)
		if (!existsSync(configPath)) return null

		return parseLocalOpencodeConfig(configPath)
	}

	/**
	 * Discover instruction files matching OpenCode's exact behavior.
	 *
	 * Discovery order (top to bottom in merged file):
	 * 1. Global AGENTS.md (or CLAUDE.md fallback for Claude Code compat)
	 * 2. Global Profile AGENTS.md (when profile active)
	 * 3. Registry-provided instructions (from installed components - resolved to absolute)
	 * 4. Local (Project) files - first file type wins (AGENTS.md > CLAUDE.md > CONTEXT.md)
	 *
	 * exclude/include patterns apply ONLY to LOCAL (project) files.
	 *
	 * References:
	 * - Global discovery: https://github.com/sst/opencode/blob/dev/packages/opencode/src/session/instruction.ts#L19-L29
	 * - Project discovery: https://github.com/sst/opencode/blob/dev/packages/opencode/src/session/instruction.ts#L75-L84
	 */
	private discoverInstructions(): string[] {
		const instructions: string[] = []

		// 1. Global AGENTS.md (always first - lowest priority)
		const globalConfigDir = getGlobalConfigPath()
		const globalAgents = join(globalConfigDir, "AGENTS.md")
		if (existsSync(globalAgents)) {
			instructions.push(globalAgents)
		} else if (!process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT) {
			// Claude Code fallback - check ~/.claude/CLAUDE.md
			const claudeGlobal = join(homedir(), ".claude", "CLAUDE.md")
			if (existsSync(claudeGlobal)) {
				instructions.push(claudeGlobal)
			}
		}

		// 2. Global Profile AGENTS.md (when profile active)
		if (this.profile && this.profileName) {
			const globalProfileAgents = join(getProfileDir(this.profileName), "AGENTS.md")
			if (existsSync(globalProfileAgents)) {
				instructions.push(globalProfileAgents)
			}
		}

		// 3. Registry-provided instructions (from installed components)
		// Load from receipt and resolve install-root-relative paths to absolute
		const registryInstructions = this.loadRegistryInstructions()
		instructions.push(...registryInstructions)

		// 4. Local (Project) files - first file type wins, filtered by exclude/include
		const gitRoot = resolveGitRootSync(this.cwd)
		const discoveredFiles = discoverInstructionFiles(this.cwd, gitRoot)

		// Apply profile exclude/include patterns to LOCAL files only
		const exclude = this.profile?.ocx.exclude ?? []
		const include = this.profile?.ocx.include ?? []
		const filteredFiles = filterByPatterns(discoveredFiles, exclude, include)

		// Convert to absolute paths
		const projectInstructions = filteredFiles.map((f) => join(gitRoot, f))
		instructions.push(...projectInstructions)

		return instructions
	}

	/**
	 * Load registry-provided instruction paths from installed components.
	 * Returns cached data loaded during create().
	 *
	 * @returns Array of absolute instruction paths from registry components
	 */
	private loadRegistryInstructions(): string[] {
		return this.registryInstructions
	}

	/**
	 * Wrapper for OpenCode config merging with type conversions.
	 *
	 * Casts between Record<string, unknown> and NormalizedOpencodeConfig.
	 * Safe because inputs are validated at config loading boundary.
	 * Uses the shared mergeOpencodeConfig utility which correctly handles:
	 * - plugin array: concatenate + dedupe by canonical name (last wins)
	 * - instructions array: concatenate + dedupe by exact string
	 * - All other arrays: source replaces target (mergeDeep default)
	 */
	private mergeOpencode(
		target: Record<string, unknown>,
		source: Record<string, unknown>,
	): Record<string, unknown> {
		return mergeOpencodeConfig(
			target as NormalizedOpencodeConfig,
			source as NormalizedOpencodeConfig,
		) as Record<string, unknown>
	}

	// =========================================================================
	// CONVENIENCE GETTERS (for compatibility with existing code)
	// =========================================================================

	/**
	 * Get registries from the active scope (profile OR local, not merged).
	 *
	 * When a profile is active: returns ONLY profile's registries
	 * When no profile: returns ONLY local registries
	 */
	getRegistries(): Record<string, RegistryConfig> {
		return this.resolve().registries
	}

	/**
	 * Get the component installation path.
	 */
	getComponentPath(): string {
		return this.resolve().componentPath
	}

	/**
	 * Get the resolved profile name, or null if no profile.
	 */
	getProfileName(): string | null {
		return this.profileName
	}

	/**
	 * Get the working directory this resolver was created for.
	 */
	getCwd(): string {
		return this.cwd
	}

	/**
	 * Get the resolved profile, or null if no profile.
	 */
	getProfile(): Profile | null {
		return this.profile
	}
}

/**
 * ConfigResolver - V2 Profile Layering with Scope Resolution
 *
 * V2 Changes:
 * - Profile selection via `.opencode/ocx.jsonc` field: `{ "profile": "work" }`
 * - Profiles layer: global base + local overlay of same name; overlay wins
 * - Visibility controlled by profile `ocx.jsonc` include/exclude patterns
 * - OCX configs (ocx.jsonc) remain ISOLATED per scope - they do NOT merge
 * - OpenCode configs (opencode.jsonc) DO merge: profile → local
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

import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, relative } from "node:path"
import { Glob } from "bun"
import { parse as parseJsonc } from "jsonc-parser"
import { ProfileManager } from "../profile/manager"
import {
	findLocalConfigDir,
	getLocalProfileAgents,
	getProfileDir,
	LOCAL_CONFIG_DIR,
	OCX_CONFIG_FILE,
	OPENCODE_CONFIG_FILE,
} from "../profile/paths"
import type { Profile } from "../profile/schema"
import { mergeOpencodeConfig } from "../registry/merge"
import type { RegistryConfig } from "../schemas/config"
import { readReceipt } from "../schemas/config"
import type { NormalizedOpencodeConfig } from "../schemas/registry"
import { resolveGitRootSync } from "../utils/git-root"
import { resolveRegistryInstructionPaths } from "../utils/instruction-paths"
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
		const source = `${entry.namespace}/${entry.name} (${canonicalId})`

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
	 * V2: Create a ConfigResolver for the given directory.
	 *
	 * Parses configuration at the boundary (Law 2: Parse Don't Validate).
	 * After construction, all getter methods are synchronous.
	 *
	 * V2 Profile Resolution:
	 * 1. Check local `.opencode/ocx.jsonc` for `profile` field
	 * 2. Fall back to options.profile
	 * 3. Fall back to OCX_PROFILE env var
	 * 4. Fall back to "default" profile (if it exists)
	 * 5. No profile (base configs only)
	 *
	 * @param cwd - Working directory
	 * @param options - Optional profile override
	 * @throws ProfileNotFoundError if specified profile doesn't exist
	 */
	static async create(cwd: string, options?: { profile?: string }): Promise<ConfigResolver> {
		const manager = ProfileManager.create(cwd)

		// V2: Check local config for profile selection first
		let profileName: string | null = null
		const localConfigDir = findLocalConfigDir(cwd)
		if (localConfigDir) {
			try {
				const localOcxPath = join(localConfigDir, OCX_CONFIG_FILE)
				if (existsSync(localOcxPath)) {
					const text = require("node:fs").readFileSync(localOcxPath, "utf8")
					const parsed = parseJsonc(text)
					if (parsed?.profile) {
						profileName = parsed.profile
					}
				}
			} catch {
				// Silent fail - local config is optional
			}
		}

		// V2 Priority: local config > options > env var > default > none
		if (!profileName) {
			profileName = options?.profile ?? process.env.OCX_PROFILE ?? null
		}

		let profile: Profile | null = null

		if (await manager.isInitialized()) {
			try {
				// If profileName is set, use it; otherwise try to resolve default
				if (profileName) {
					profile = await manager.getLayered(profileName, cwd)
				} else {
					// Try default profile
					profileName = await manager.resolveProfile()
					profile = await manager.getLayered(profileName, cwd)
				}
			} catch {
				// No profile resolved - that's OK, we'll just use base configs
				profileName = null
				profile = null
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
	 * V2: Resolve configuration with profile layering.
	 *
	 * V2 Changes:
	 * - Profiles layer: global base + local overlay of same name (overlay wins)
	 * - Registries: Profile OR local (isolated, not merged)
	 * - OpenCode config: Additively merged (profile + local if not excluded)
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
				opencode = mergeOpencodeConfig(
					opencode as NormalizedOpencodeConfig,
					this.profile.opencode as NormalizedOpencodeConfig,
				) as Record<string, unknown>
			}
		}

		// 3. Check exclude/include patterns
		const shouldLoadLocal = this.shouldLoadLocalConfig()

		// 4. V2: Apply local OCX registries ONLY when no profile active (isolation)
		// This maintains registry isolation as before
		if (!this.profile && shouldLoadLocal && this.localConfigDir) {
			const localOcxConfig = this.loadLocalOcxConfig()
			if (localOcxConfig) {
				registries = localOcxConfig.registries
			}
		}

		// 5. V2: Apply local OpenCode config (DOES merge with profile)
		// Check if profile and local have the same name for layering
		if (shouldLoadLocal && this.localConfigDir) {
			const localOpencodeConfig = this.loadLocalOpencodeConfig()
			if (localOpencodeConfig) {
				opencode = mergeOpencodeConfig(
					opencode as NormalizedOpencodeConfig,
					localOpencodeConfig as NormalizedOpencodeConfig,
				) as Record<string, unknown>
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
				opencode = mergeOpencodeConfig(
					opencode as NormalizedOpencodeConfig,
					this.profile.opencode as NormalizedOpencodeConfig,
				) as Record<string, unknown>
				const profileOpencodePath = `~/.config/opencode/profiles/${this.profileName}/opencode.jsonc`
				for (const key of Object.keys(this.profile.opencode)) {
					origins.set(`opencode.${key}`, { path: profileOpencodePath, source: "global-profile" })
				}
			}
		}

		// 3. Check exclude/include patterns
		const shouldLoadLocal = this.shouldLoadLocalConfig()

		// 4. Apply local OCX registries ONLY when no profile active (isolation)
		if (!this.profile && shouldLoadLocal && this.localConfigDir) {
			const localOcxConfig = this.loadLocalOcxConfig()
			if (localOcxConfig) {
				const localOcxPath = join(this.localConfigDir, OCX_CONFIG_FILE)
				for (const [key, value] of Object.entries(localOcxConfig.registries)) {
					registries[key] = value
					origins.set(`registries.${key}`, { path: localOcxPath, source: "local-config" })
				}
			}
		}

		// 5. Apply local OpenCode config (DOES merge with profile)
		if (shouldLoadLocal && this.localConfigDir) {
			const localOpencodeConfig = this.loadLocalOpencodeConfig()
			if (localOpencodeConfig) {
				opencode = mergeOpencodeConfig(
					opencode as NormalizedOpencodeConfig,
					localOpencodeConfig as NormalizedOpencodeConfig,
				) as Record<string, unknown>
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
	 * Returns null if file doesn't exist or fails to parse.
	 */
	private loadLocalOcxConfig(): { registries: Record<string, RegistryConfig> } | null {
		if (!this.localConfigDir) return null

		const configPath = join(this.localConfigDir, OCX_CONFIG_FILE)
		if (!existsSync(configPath)) return null

		try {
			// Synchronous read for simplicity in resolve path
			const text = require("node:fs").readFileSync(configPath, "utf8")
			const parsed = parseJsonc(text)
			return {
				registries: parsed?.registries ?? {},
			}
		} catch {
			// Silent fail - local config is optional
			return null
		}
	}

	/**
	 * Load local opencode.jsonc configuration.
	 * Returns null if file doesn't exist or fails to parse.
	 */
	private loadLocalOpencodeConfig(): Record<string, unknown> | null {
		if (!this.localConfigDir) return null

		const configPath = join(this.localConfigDir, OPENCODE_CONFIG_FILE)
		if (!existsSync(configPath)) return null

		try {
			const text = require("node:fs").readFileSync(configPath, "utf8")
			return parseJsonc(text) as Record<string, unknown>
		} catch {
			// Silent fail - local config is optional
			return null
		}
	}

	/**
	 * Discover instruction files matching OpenCode's exact behavior.
	 *
	 * Discovery order (top to bottom in merged file):
	 * 1. Global AGENTS.md (or CLAUDE.md fallback for Claude Code compat)
	 * 2. Global Profile AGENTS.md (when profile active)
	 * 3. Registry-provided instructions (from installed components - resolved to absolute)
	 * 4. Local (Project) files - first file type wins (AGENTS.md > CLAUDE.md > CONTEXT.md)
	 * 5. Local Profile AGENTS.md (when local profile active - highest priority)
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

		// 5. Local Profile AGENTS.md (when local profile active - highest priority)
		if (this.profileName && this.localConfigDir) {
			const localProfileAgents = getLocalProfileAgents(this.profileName, this.cwd)
			if (existsSync(localProfileAgents)) {
				instructions.push(localProfileAgents)
			}
		}

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

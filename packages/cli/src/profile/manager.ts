import { mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import { parse } from "jsonc-parser"
import type { ProfileOcxConfig } from "../schemas/ocx"
import { profileOcxConfigSchema } from "../schemas/ocx"
import {
	ConfigError,
	ConflictError,
	InvalidProfileNameError,
	ProfileExistsError,
	ProfileNotFoundError,
	ProfilesNotInitializedError,
} from "../utils/errors"
import { atomicWrite } from "./atomic"
import {
	getLocalProfileAgents,
	getLocalProfileDir,
	getLocalProfileOcxConfig,
	getLocalProfileOpencodeConfig,
	getProfileAgents,
	getProfileDir,
	getProfileOcxConfig,
	getProfileOpencodeConfig,
	getProfilesDir,
} from "./paths"
import type { Profile } from "./schema"
import { profileNameSchema } from "./schema"

/**
 * Default ocx.jsonc config for new profiles (programmatic use).
 * Note: AGENTS.md is NOT excluded by default - it's commented out in the template.
 */
export const DEFAULT_OCX_CONFIG: ProfileOcxConfig = {
	$schema: "https://ocx.kdco.dev/schemas/ocx.json",
	registries: {},
	renameWindow: true,
	exclude: [
		"**/CLAUDE.md",
		"**/CONTEXT.md",
		"**/.opencode/**",
		"**/opencode.jsonc",
		"**/opencode.json",
	],
	include: [],
}

/**
 * Default ocx.jsonc JSONC template for new profiles.
 * Includes commented-out AGENTS.md line so users can easily enable exclusion.
 */
export const DEFAULT_OCX_CONFIG_TEMPLATE = `{
  "$schema": "https://ocx.kdco.dev/schemas/ocx.json",
  "registries": {},
  "renameWindow": true,
  "exclude": [
    // "**/AGENTS.md",
    "**/CLAUDE.md",
    "**/CONTEXT.md",
    "**/.opencode/**",
    "**/opencode.jsonc",
    "**/opencode.json"
  ],
  "include": []
}
`

/**
 * Manages OCX profiles.
 * Uses static factory pattern for consistent construction.
 * Supports both global (~/.config/opencode/profiles/) and local (.opencode/profiles/) profiles.
 */
export class ProfileManager {
	private constructor(
		private readonly profilesDir: string,
		private readonly cwd: string = process.cwd(),
	) {}

	/**
	 * Create a ProfileManager instance.
	 * Does not require profiles to be initialized.
	 */
	static create(cwd?: string): ProfileManager {
		return new ProfileManager(getProfilesDir(), cwd ?? process.cwd())
	}

	/**
	 * Get a ProfileManager instance, throwing if OCX is not initialized.
	 * Use this in commands that require profiles to exist.
	 *
	 * @throws ProfilesNotInitializedError if OCX is not initialized
	 * @returns ProfileManager instance guaranteed to be initialized
	 */
	static async requireInitialized(): Promise<ProfileManager> {
		const manager = ProfileManager.create()
		if (!(await manager.isInitialized())) {
			throw new ProfilesNotInitializedError()
		}
		return manager
	}

	/**
	 * Check if profiles have been initialized.
	 */
	async isInitialized(): Promise<boolean> {
		try {
			const stats = await stat(this.profilesDir)
			return stats.isDirectory()
		} catch {
			return false
		}
	}

	/**
	 * Ensure profiles are initialized, throw if not.
	 */
	private async ensureInitialized(): Promise<void> {
		if (!(await this.isInitialized())) {
			throw new ProfilesNotInitializedError()
		}
	}

	/**
	 * List all profile names.
	 * @returns Array of profile names
	 */
	async list(): Promise<string[]> {
		await this.ensureInitialized()
		const entries = await readdir(this.profilesDir, { withFileTypes: true })
		return entries
			.filter((e) => e.isDirectory() && !e.name.startsWith("."))
			.map((e) => e.name)
			.sort()
	}

	/**
	 * Check if a profile exists.
	 * @param name - Profile name
	 * @param global - Whether to check global location (default: true for backward compatibility with existing commands)
	 */
	async exists(name: string, global = true): Promise<boolean> {
		const dir = global ? getProfileDir(name) : getLocalProfileDir(name, this.cwd)
		try {
			const stats = await stat(dir)
			return stats.isDirectory()
		} catch {
			return false
		}
	}

	/**
	 * Load a profile by name.
	 * @param name - Profile name
	 * @returns Loaded and validated profile
	 */
	async get(name: string): Promise<Profile> {
		if (!(await this.exists(name))) {
			throw new ProfileNotFoundError(name)
		}

		// Check ocx.jsonc exists with descriptive error
		const ocxPath = getProfileOcxConfig(name)
		const ocxFile = Bun.file(ocxPath)

		if (!(await ocxFile.exists())) {
			throw new ConfigError(`Profile "${name}" is missing ocx.jsonc. Expected at: ${ocxPath}`)
		}

		const ocxContent = await ocxFile.text()
		const ocxRaw = parse(ocxContent)
		const ocx = profileOcxConfigSchema.parse(ocxRaw)

		// Load opencode.jsonc (optional)
		const opencodePath = getProfileOpencodeConfig(name)
		const opencodeFile = Bun.file(opencodePath)
		let opencode: Record<string, unknown> | undefined
		if (await opencodeFile.exists()) {
			const opencodeContent = await opencodeFile.text()
			opencode = parse(opencodeContent) as Record<string, unknown>
		}

		// Check for AGENTS.md
		const agentsPath = getProfileAgents(name)
		const agentsFile = Bun.file(agentsPath)
		const hasAgents = await agentsFile.exists()

		return {
			name,
			ocx,
			opencode,
			hasAgents,
		}
	}

	/**
	 * Load a profile with global + local layering.
	 * Global profile is base, local profile overlays on top.
	 * Matches OpenCode's config merge behavior.
	 *
	 * @param name - Profile name
	 * @param cwd - Current working directory (for local profile lookup)
	 * @returns Merged profile (global base + local overlay)
	 * @throws ProfileNotFoundError if global profile doesn't exist
	 */
	async getLayered(name: string, cwd: string): Promise<Profile> {
		// 1. Load global profile (required - base layer)
		const globalProfile = await this.get(name)

		// 2. Check for local profile (optional - overlay layer)
		if (!(await this.exists(name, false))) {
			return globalProfile // No local overlay
		}

		// 3. Load local profile
		const localProfile = await this.loadFromLocal(name, cwd)

		// 4. Merge: local wins on conflicts
		return this.mergeProfiles(globalProfile, localProfile)
	}

	/**
	 * Load a profile from local directory.
	 * @param name - Profile name
	 * @param cwd - Current working directory
	 */
	private async loadFromLocal(name: string, cwd: string): Promise<Profile> {
		const ocxPath = getLocalProfileOcxConfig(name, cwd)
		const ocxFile = Bun.file(ocxPath)

		if (!(await ocxFile.exists())) {
			throw new ConfigError(`Local profile "${name}" is missing ocx.jsonc. Expected at: ${ocxPath}`)
		}

		const ocxContent = await ocxFile.text()
		const ocxRaw = parse(ocxContent)
		const ocx = profileOcxConfigSchema.parse(ocxRaw)

		// Load opencode.jsonc (optional)
		const opencodePath = getLocalProfileOpencodeConfig(name, cwd)
		const opencodeFile = Bun.file(opencodePath)
		let opencode: Record<string, unknown> | undefined
		if (await opencodeFile.exists()) {
			const opencodeContent = await opencodeFile.text()
			opencode = parse(opencodeContent) as Record<string, unknown>
		}

		// Check for AGENTS.md
		const agentsPath = getLocalProfileAgents(name, cwd)
		const agentsFile = Bun.file(agentsPath)
		const hasAgents = await agentsFile.exists()

		return {
			name,
			ocx,
			opencode,
			hasAgents,
		}
	}

	/**
	 * Merge two profiles (global base + local overlay).
	 * Uses deep merge for objects, local wins on conflicts.
	 * Matches OpenCode's merge behavior:
	 * - Objects: deep merge recursively
	 * - Arrays: local replaces global (except plugin/instructions which concatenate)
	 * - Scalars: local wins
	 */
	private mergeProfiles(base: Profile, overlay: Profile): Profile {
		return {
			name: base.name,
			ocx: this.deepMergeOcx(base.ocx, overlay.ocx),
			opencode: this.deepMerge(base.opencode ?? {}, overlay.opencode ?? {}),
			hasAgents: base.hasAgents || overlay.hasAgents,
		}
	}

	/**
	 * Deep merge OCX configs.
	 * Objects merge deeply, arrays replace, scalars replace.
	 */
	private deepMergeOcx(base: ProfileOcxConfig, overlay: ProfileOcxConfig): ProfileOcxConfig {
		const result: ProfileOcxConfig = { ...base }

		// Merge registries (deep merge - local adds to/overrides global)
		if (overlay.registries) {
			result.registries = { ...base.registries, ...overlay.registries }
		}

		// Replace arrays (local wins)
		if (overlay.exclude !== undefined) {
			result.exclude = overlay.exclude
		}
		if (overlay.include !== undefined) {
			result.include = overlay.include
		}

		// Replace scalars (local wins)
		if (overlay.componentPath !== undefined) {
			result.componentPath = overlay.componentPath
		}
		if (overlay.renameWindow !== undefined) {
			result.renameWindow = overlay.renameWindow
		}
		if (overlay.bin !== undefined) {
			result.bin = overlay.bin
		}

		return result
	}

	/**
	 * Deep merge for opencode config.
	 * Matches OpenCode behavior: objects merge, arrays replace (except plugin/instructions).
	 */
	private deepMerge(
		target: Record<string, unknown>,
		source: Record<string, unknown>,
	): Record<string, unknown> {
		const result = { ...target }

		for (const key of Object.keys(source)) {
			const sourceValue = source[key]
			const targetValue = result[key]

			// Special handling for plugin and instructions arrays - concatenate + dedupe
			if (
				(key === "plugin" || key === "instructions") &&
				Array.isArray(sourceValue) &&
				Array.isArray(targetValue)
			) {
				result[key] = Array.from(new Set([...targetValue, ...sourceValue]))
				continue
			}

			// If both are plain objects, recurse
			if (this.isPlainObject(sourceValue) && this.isPlainObject(targetValue)) {
				result[key] = this.deepMerge(
					targetValue as Record<string, unknown>,
					sourceValue as Record<string, unknown>,
				)
			} else {
				// Arrays and scalars: source wins (last-write-wins)
				result[key] = sourceValue
			}
		}

		return result
	}

	/**
	 * Check if value is a plain object (not array, not null).
	 */
	private isPlainObject(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null && !Array.isArray(value)
	}

	/**
	 * Create a new profile.
	 * @param name - Profile name (validated)
	 * @param global - Whether to create global profile (default: false for local-first)
	 */
	async add(name: string, global = false): Promise<void> {
		// Validate name
		const result = profileNameSchema.safeParse(name)
		if (!result.success) {
			throw new InvalidProfileNameError(name, result.error.errors[0]?.message ?? "Invalid name")
		}

		// Check doesn't exist
		if (await this.exists(name, global)) {
			throw new ProfileExistsError(name)
		}

		// Create directory with secure permissions
		const dir = global ? getProfileDir(name) : getLocalProfileDir(name, this.cwd)
		await mkdir(dir, { recursive: true, mode: 0o700 })

		// Create ocx.jsonc with create-if-missing (uses JSONC template with commented AGENTS.md)
		const ocxPath = global ? getProfileOcxConfig(name) : getLocalProfileOcxConfig(name, this.cwd)
		const ocxFile = Bun.file(ocxPath)
		if (!(await ocxFile.exists())) {
			await Bun.write(ocxPath, DEFAULT_OCX_CONFIG_TEMPLATE, { mode: 0o600 })
		}

		// Create opencode.jsonc with create-if-missing
		const opencodePath = global
			? getProfileOpencodeConfig(name)
			: getLocalProfileOpencodeConfig(name, this.cwd)
		const opencodeFile = Bun.file(opencodePath)
		if (!(await opencodeFile.exists())) {
			await atomicWrite(opencodePath, {})
		}

		// Create AGENTS.md with create-if-missing
		const agentsPath = global ? getProfileAgents(name) : getLocalProfileAgents(name, this.cwd)
		const agentsFile = Bun.file(agentsPath)
		if (!(await agentsFile.exists())) {
			const agentsContent = `# Profile Instructions

<!-- Add your custom instructions for this profile here -->
<!-- These will be included when running \`ocx opencode -p ${name}\` -->
`
			await Bun.write(agentsPath, agentsContent, { mode: 0o600 })
		}
	}

	/**
	 * Remove a profile.
	 * @param name - Profile name
	 * @param global - Whether to remove global profile (default: true for backward compatibility)
	 */
	async remove(name: string, global = true): Promise<void> {
		if (!(await this.exists(name, global))) {
			throw new ProfileNotFoundError(name)
		}

		// Only apply last-profile check when removing global profiles
		if (global) {
			const profiles = await this.list()
			if (profiles.length <= 1) {
				throw new Error("Cannot delete the last profile. At least one profile must exist.")
			}
		}

		const dir = global ? getProfileDir(name) : getLocalProfileDir(name, this.cwd)
		await rm(dir, { recursive: true })
	}

	/**
	 * Move (rename) a profile atomically.
	 * @param oldName - Current profile name
	 * @param newName - New profile name
	 * @param global - Whether to move global profile (default: true for backward compatibility)
	 * @returns Object indicating if active profile warning should be shown
	 */
	async move(
		oldName: string,
		newName: string,
		global = true,
	): Promise<{ warnActiveProfile: boolean }> {
		// 1. Validate oldName format
		const oldResult = profileNameSchema.safeParse(oldName)
		if (!oldResult.success) {
			throw new InvalidProfileNameError(
				oldName,
				oldResult.error.errors[0]?.message ?? "Invalid name",
			)
		}

		// 2. Validate newName format
		const newResult = profileNameSchema.safeParse(newName)
		if (!newResult.success) {
			throw new InvalidProfileNameError(
				newName,
				newResult.error.errors[0]?.message ?? "Invalid name",
			)
		}

		// 3. Ensure profiles are initialized
		await this.ensureInitialized()

		// 4. Check source exists
		if (!(await this.exists(oldName, global))) {
			throw new ProfileNotFoundError(oldName)
		}

		// 5. Check for self-move (no-op) - safe now that we know source exists
		if (oldName === newName) {
			return { warnActiveProfile: false }
		}

		// 6. Check target doesn't exist
		if (await this.exists(newName, global)) {
			throw new ConflictError(
				`Cannot move: profile "${newName}" already exists. Remove it first with 'ocx p rm ${newName}'.`,
			)
		}

		// 7. Check if moving active profile
		const warnActiveProfile = process.env.OCX_PROFILE === oldName

		// 8. Atomic rename (with race condition handling)
		const oldDir = global ? getProfileDir(oldName) : getLocalProfileDir(oldName, this.cwd)
		const newDir = global ? getProfileDir(newName) : getLocalProfileDir(newName, this.cwd)
		try {
			await rename(oldDir, newDir)
		} catch (error) {
			// Handle race condition where destination was created between check and rename
			if (error instanceof Error && "code" in error) {
				const code = (error as NodeJS.ErrnoException).code
				if (code === "EEXIST" || code === "ENOTEMPTY") {
					throw new ConflictError(
						`Cannot move: profile "${newName}" already exists. Remove it first with 'ocx p rm ${newName}'.`,
					)
				}
				if (code === "ENOENT") {
					throw new ProfileNotFoundError(oldName)
				}
			}
			throw error
		}

		return { warnActiveProfile }
	}

	/**
	 * Resolve the profile name to use.
	 * Priority: override (from -p flag) > OCX_PROFILE env > "default"
	 *
	 * @param override - Optional override from --profile flag
	 * @returns Resolved profile name (validated to exist)
	 * @throws ProfileNotFoundError if resolved profile doesn't exist
	 */
	async resolveProfile(override?: string): Promise<string> {
		// Priority 1: Explicit override from -p/--profile flag
		if (override) {
			if (!(await this.exists(override))) {
				throw new ProfileNotFoundError(override)
			}
			return override
		}

		// Priority 2: OCX_PROFILE environment variable
		const envProfile = process.env.OCX_PROFILE
		if (envProfile) {
			if (!(await this.exists(envProfile))) {
				throw new ProfileNotFoundError(envProfile)
			}
			return envProfile
		}

		// Priority 3: Fall back to "default" profile
		const defaultProfile = "default"
		if (!(await this.exists(defaultProfile))) {
			throw new ProfileNotFoundError(defaultProfile)
		}
		return defaultProfile
	}

	/**
	 * Initialize profiles with a default profile.
	 * Called by `ocx init --global`.
	 */
	async initialize(): Promise<void> {
		// Create profiles directory
		await mkdir(this.profilesDir, { recursive: true, mode: 0o700 })

		// Create default profile (global)
		await this.add("default", true)
	}
}

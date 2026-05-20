import { mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import { type ParseError, parse as parseJsonc } from "jsonc-parser"
import type { ProfileOcxConfig } from "../schemas/ocx"
import { profileOcxConfigSchema } from "../schemas/ocx"
import {
	ConfigError,
	ConflictError,
	InvalidProfileNameError,
	LocalProfileUnsupportedError,
	ProfileExistsError,
	ProfileNotFoundError,
	ProfilesNotInitializedError,
} from "../utils/errors"
import { formatJsoncParseError } from "../utils/jsonc"
import { atomicWrite } from "./atomic"
import {
	getLocalProfileDir,
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
	$schema: "https://ocx.kdco.dev/schemas/profile.json",
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
  "$schema": "https://ocx.kdco.dev/schemas/profile.json",
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

function parseJsoncOrThrow(content: string, filePath: string): unknown {
	const parseErrors: ParseError[] = []
	const parsed = parseJsonc(content, parseErrors, { allowTrailingComma: true })

	if (parseErrors.length > 0) {
		const errorDetail = formatJsoncParseError(parseErrors)
		throw new ConfigError(`Invalid JSONC in ${filePath}: ${errorDetail}`)
	}

	return parsed
}

function parseProfileOcxConfigOrThrow(
	rawConfig: unknown,
	filePath: string,
	profileName: string,
): ProfileOcxConfig {
	const validationResult = profileOcxConfigSchema.safeParse(rawConfig)
	if (!validationResult.success) {
		const firstIssue = validationResult.error.issues[0]
		const issuePath = firstIssue?.path.length ? firstIssue.path.join(".") : "root"
		const issueMessage = firstIssue?.message ?? "Invalid profile OCX configuration"
		throw new ConfigError(
			`Invalid profile "${profileName}" ocx.jsonc at ${filePath}: ${issuePath} ${issueMessage}`,
		)
	}

	return validationResult.data
}

function parseProfileOpencodeConfigOrThrow(
	rawConfig: unknown,
	filePath: string,
	profileName: string,
): Record<string, unknown> {
	if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
		throw new ConfigError(
			`Invalid profile "${profileName}" opencode.jsonc at ${filePath}: root must be an object`,
		)
	}

	return rawConfig as Record<string, unknown>
}

function requireNonEmptyProfileName(profileName: string, sourceDescription: string): string {
	if (profileName.trim().length === 0) {
		throw new ConfigError(
			`Invalid profile from ${sourceDescription}: value cannot be empty or whitespace`,
		)
	}

	return profileName
}

/**
 * Manages OCX profiles (global-only).
 *
 * All profiles are stored in the global config directory (~/.config/opencode/profiles/).
 * Local profiles are unsupported; any local profile directory presence triggers a hard error
 * via getLayered().
 *
 * Uses static factory pattern for consistent construction.
 */
export class ProfileManager {
	private constructor(private readonly cwd: string = process.cwd()) {}

	/** Returns the profiles directory, reading fresh from environment each access. */
	private get profilesDir(): string {
		return getProfilesDir()
	}

	/**
	 * Create a ProfileManager instance.
	 * Does not require profiles to be initialized.
	 */
	static create(cwd?: string): ProfileManager {
		return new ProfileManager(cwd ?? process.cwd())
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
	 * List all global profile names.
	 * @returns Array of profile names, sorted alphabetically
	 */
	async list(): Promise<string[]> {
		await this.ensureInitialized()

		const entries = await readdir(this.profilesDir, { withFileTypes: true, encoding: "utf8" })
		const profiles: string[] = []

		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.name === "current") {
				continue
			}

			if (entry.isDirectory()) {
				profiles.push(entry.name)
				continue
			}

			if (entry.isSymbolicLink()) {
				try {
					const stats = await stat(getProfileDir(entry.name))
					if (stats.isDirectory()) {
						profiles.push(entry.name)
					}
				} catch {
					// Broken symlinks and inaccessible targets are not profile directories.
				}
			}
		}

		return profiles.sort()
	}

	/**
	 * Check if a global profile exists.
	 * @param name - Profile name
	 */
	async exists(name: string): Promise<boolean> {
		const dir = getProfileDir(name)
		try {
			const stats = await stat(dir)
			return stats.isDirectory()
		} catch {
			return false
		}
	}

	/**
	 * Load a global profile by name.
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
		const ocxRaw = parseJsoncOrThrow(ocxContent, ocxPath)
		const ocx = parseProfileOcxConfigOrThrow(ocxRaw, ocxPath, name)

		// Load opencode.jsonc (optional)
		const opencodePath = getProfileOpencodeConfig(name)
		const opencodeFile = Bun.file(opencodePath)
		let opencode: Record<string, unknown> | undefined
		if (await opencodeFile.exists()) {
			const opencodeContent = await opencodeFile.text()
			const opencodeRaw = parseJsoncOrThrow(opencodeContent, opencodePath)
			opencode = parseProfileOpencodeConfigOrThrow(opencodeRaw, opencodePath, name)
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
	 * Load a global-only profile. Hard errors if a local profile directory exists.
	 *
	 * Local profiles are unsupported. If a local profile directory is detected
	 * for the active profile, a LocalProfileUnsupportedError is thrown immediately
	 * (Law 4: Fail Fast, Fail Loud).
	 *
	 * @param name - Profile name
	 * @param cwd - Current working directory (for local profile detection)
	 * @returns Global profile
	 * @throws ProfileNotFoundError if global profile doesn't exist
	 * @throws LocalProfileUnsupportedError if local profile directory exists
	 */
	async getLayered(name: string, cwd: string): Promise<Profile> {
		// Guard: Reject local profile directory presence (Law 1: Early Exit)
		const localDir = getLocalProfileDir(name, cwd)
		let localExists = false
		try {
			const stats = await stat(localDir)
			localExists = stats.isDirectory()
		} catch {
			localExists = false
		}
		if (localExists) {
			throw new LocalProfileUnsupportedError(name, localDir)
		}

		// Load global profile (the only supported source)
		return this.get(name)
	}

	/**
	 * Create a new global profile.
	 * @param name - Profile name (validated)
	 */
	async add(name: string): Promise<void> {
		// Validate name
		const result = profileNameSchema.safeParse(name)
		if (!result.success) {
			throw new InvalidProfileNameError(name, result.error.issues[0]?.message ?? "Invalid name")
		}

		// Check doesn't exist
		if (await this.exists(name)) {
			throw new ProfileExistsError(name)
		}

		// Create directory with secure permissions
		const dir = getProfileDir(name)
		await mkdir(dir, { recursive: true, mode: 0o700 })

		// Create ocx.jsonc with create-if-missing (uses JSONC template with commented AGENTS.md)
		const ocxPath = getProfileOcxConfig(name)
		const ocxFile = Bun.file(ocxPath)
		if (!(await ocxFile.exists())) {
			await Bun.write(ocxPath, DEFAULT_OCX_CONFIG_TEMPLATE, { mode: 0o600 })
		}

		// Create opencode.jsonc with create-if-missing
		const opencodePath = getProfileOpencodeConfig(name)
		const opencodeFile = Bun.file(opencodePath)
		if (!(await opencodeFile.exists())) {
			await atomicWrite(opencodePath, {})
		}

		// Create AGENTS.md with create-if-missing
		const agentsPath = getProfileAgents(name)
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
	 * Remove a global profile.
	 * @param name - Profile name
	 */
	async remove(name: string): Promise<void> {
		if (!(await this.exists(name))) {
			throw new ProfileNotFoundError(name)
		}

		const profiles = await this.list()
		if (profiles.length <= 1) {
			throw new Error("Cannot delete the last profile. At least one profile must exist.")
		}

		const dir = getProfileDir(name)
		await rm(dir, { recursive: true })
	}

	/**
	 * Move (rename) a global profile atomically.
	 * @param oldName - Current profile name
	 * @param newName - New profile name
	 * @returns Object indicating if active profile warning should be shown
	 */
	async move(oldName: string, newName: string): Promise<{ warnActiveProfile: boolean }> {
		// 1. Validate oldName format
		const oldResult = profileNameSchema.safeParse(oldName)
		if (!oldResult.success) {
			throw new InvalidProfileNameError(
				oldName,
				oldResult.error.issues[0]?.message ?? "Invalid name",
			)
		}

		// 2. Validate newName format
		const newResult = profileNameSchema.safeParse(newName)
		if (!newResult.success) {
			throw new InvalidProfileNameError(
				newName,
				newResult.error.issues[0]?.message ?? "Invalid name",
			)
		}

		// 3. Ensure profiles are initialized
		await this.ensureInitialized()

		// 4. Check source exists
		if (!(await this.exists(oldName))) {
			throw new ProfileNotFoundError(oldName)
		}

		// 5. Check for self-move (no-op) - safe now that we know source exists
		if (oldName === newName) {
			return { warnActiveProfile: false }
		}

		// 6. Check target doesn't exist
		if (await this.exists(newName)) {
			throw new ConflictError(
				`Cannot move: profile "${newName}" already exists. Remove it first with 'ocx profile rm ${newName} --global'.`,
			)
		}

		// 7. Check if moving active profile
		const warnActiveProfile = process.env.OCX_PROFILE === oldName

		// 8. Atomic rename (with race condition handling)
		const oldDir = getProfileDir(oldName)
		const newDir = getProfileDir(newName)
		try {
			await rename(oldDir, newDir)
		} catch (error) {
			// Handle race condition where destination was created between check and rename
			if (error instanceof Error && "code" in error) {
				const code = (error as NodeJS.ErrnoException).code
				if (code === "EEXIST" || code === "ENOTEMPTY") {
					throw new ConflictError(
						`Cannot move: profile "${newName}" already exists. Remove it first with 'ocx profile rm ${newName} --global'.`,
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
		if (override !== undefined) {
			const profileName = requireNonEmptyProfileName(override, "CLI option --profile")
			if (!(await this.exists(profileName))) {
				throw new ProfileNotFoundError(profileName)
			}
			return profileName
		}

		// Priority 2: OCX_PROFILE environment variable
		const envProfile = process.env.OCX_PROFILE
		if (envProfile !== undefined) {
			const profileName = requireNonEmptyProfileName(envProfile, "environment variable OCX_PROFILE")
			if (!(await this.exists(profileName))) {
				throw new ProfileNotFoundError(profileName)
			}
			return profileName
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

		// Create default profile
		await this.add("default")
	}
}

import { mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import { parse } from "jsonc-parser"
import type { ProfileOcxConfig } from "../schemas/ocx"
import { profileOcxConfigSchema } from "../schemas/ocx"
import {
	ConflictError,
	InvalidProfileNameError,
	OcxConfigError,
	ProfileExistsError,
	ProfileNotFoundError,
	ProfilesNotInitializedError,
} from "../utils/errors"
import { atomicWrite } from "./atomic"
import {
	getProfileAgents,
	getProfileDir,
	getProfileOcxConfig,
	getProfileOpencodeConfig,
	getProfilesDir,
} from "./paths"
import type { Profile } from "./schema"
import { profileNameSchema } from "./schema"

/**
 * Default ocx.jsonc template for new profiles.
 */
export const DEFAULT_OCX_CONFIG: ProfileOcxConfig = {
	$schema: "https://ocx.kdco.dev/schemas/ocx.json",
	registries: {},
	renameWindow: true,
	exclude: [
		"**/AGENTS.md",
		"**/CLAUDE.md",
		"**/CONTEXT.md",
		"**/.opencode/**",
		"**/opencode.jsonc",
		"**/opencode.json",
	],
	include: [],
}

/**
 * Manages OCX profiles.
 * Uses static factory pattern for consistent construction.
 */
export class ProfileManager {
	private constructor(private readonly profilesDir: string) {}

	/**
	 * Create a ProfileManager instance.
	 * Does not require profiles to be initialized.
	 */
	static create(): ProfileManager {
		return new ProfileManager(getProfilesDir())
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
			throw new OcxConfigError(`Profile "${name}" is missing ocx.jsonc. Expected at: ${ocxPath}`)
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
	 * Create a new profile.
	 * @param name - Profile name (validated)
	 */
	async add(name: string): Promise<void> {
		// Validate name
		const result = profileNameSchema.safeParse(name)
		if (!result.success) {
			throw new InvalidProfileNameError(name, result.error.errors[0]?.message ?? "Invalid name")
		}

		// Check doesn't exist
		if (await this.exists(name)) {
			throw new ProfileExistsError(name)
		}

		// Create directory with secure permissions
		const dir = getProfileDir(name)
		await mkdir(dir, { recursive: true, mode: 0o700 })

		// Create ocx.jsonc with create-if-missing
		const ocxPath = getProfileOcxConfig(name)
		const ocxFile = Bun.file(ocxPath)
		if (!(await ocxFile.exists())) {
			await atomicWrite(ocxPath, DEFAULT_OCX_CONFIG)
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
	 * Remove a profile.
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
	 * Move (rename) a profile atomically.
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
				`Cannot move: profile "${newName}" already exists. Remove it first with 'ocx p rm ${newName}'.`,
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

		// Create default profile
		await this.add("default")
	}
}

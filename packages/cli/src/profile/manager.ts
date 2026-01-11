import { mkdir, readdir, readlink, rm, stat } from "node:fs/promises"
import { parse } from "jsonc-parser"
import type { GhostConfig } from "../schemas/ghost.js"
import { ghostConfigSchema } from "../schemas/ghost.js"
import {
	GhostConfigError,
	InvalidProfileNameError,
	ProfileExistsError,
	ProfileNotFoundError,
	ProfilesNotInitializedError,
} from "../utils/errors.js"
import { atomicSymlink, atomicWrite } from "./atomic.js"
import {
	getCurrentSymlink,
	getProfileAgents,
	getProfileDir,
	getProfileGhostConfig,
	getProfileOpencodeConfig,
	getProfilesDir,
} from "./paths.js"
import type { Profile } from "./schema.js"
import { profileNameSchema } from "./schema.js"

/**
 * Default ghost.jsonc template for new profiles.
 */
const DEFAULT_GHOST_CONFIG: GhostConfig = {
	$schema: "https://ocx.kdco.dev/schemas/ghost.json",
	registries: {},
	exclude: [
		// Rule files - recursive (can exist at any depth)
		"**/AGENTS.md",
		"**/CLAUDE.md",
		"**/CONTEXT.md",
		// Config - root only (one per project)
		".opencode",
		"opencode.jsonc",
		"opencode.json",
	],
	include: [],
	renameWindow: true,
}

/**
 * Manages ghost mode profiles.
 * Uses static factory pattern matching GhostConfigProvider.
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
			.filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "current")
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

		// Check ghost.jsonc exists with descriptive error
		const ghostPath = getProfileGhostConfig(name)
		const ghostFile = Bun.file(ghostPath)

		if (!(await ghostFile.exists())) {
			throw new GhostConfigError(
				`Profile "${name}" is missing ghost.jsonc. Expected at: ${ghostPath}`,
			)
		}

		const ghostContent = await ghostFile.text()
		const ghostRaw = parse(ghostContent)
		const ghost = ghostConfigSchema.parse(ghostRaw)

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
			ghost,
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

		// Create ghost.jsonc with default template
		const ghostPath = getProfileGhostConfig(name)
		await atomicWrite(ghostPath, DEFAULT_GHOST_CONFIG)
	}

	/**
	 * Remove a profile.
	 * @param name - Profile name
	 * @param force - Allow deleting current profile
	 */
	async remove(name: string, force = false): Promise<void> {
		if (!(await this.exists(name))) {
			throw new ProfileNotFoundError(name)
		}

		const current = await this.getCurrent()
		const isCurrentProfile = current === name
		const profiles = await this.list()

		if (isCurrentProfile && !force) {
			throw new Error(`Cannot delete current profile "${name}". Use --force to override.`)
		}

		if (profiles.length <= 1) {
			throw new Error("Cannot delete the last profile. At least one profile must exist.")
		}

		// Compute remaining BEFORE deletion for atomicity
		const remaining = profiles.filter((p) => p !== name)

		const dir = getProfileDir(name)
		await rm(dir, { recursive: true })

		// Auto-switch symlink if we deleted current profile
		if (isCurrentProfile && remaining.length > 0) {
			await this.setCurrent(remaining[0] as string)
		}
	}

	/**
	 * Get the current profile name.
	 * Respects OCX_PROFILE environment variable.
	 * @param override - Optional override (e.g., from --profile flag)
	 */
	async getCurrent(override?: string): Promise<string> {
		// Priority: override > env > symlink
		if (override) {
			// Validate the override exists
			if (!(await this.exists(override))) {
				throw new ProfileNotFoundError(override)
			}
			return override
		}

		const envProfile = process.env.OCX_PROFILE
		if (envProfile) {
			if (!(await this.exists(envProfile))) {
				throw new ProfileNotFoundError(envProfile)
			}
			return envProfile
		}

		// Read symlink
		await this.ensureInitialized()
		const linkPath = getCurrentSymlink()
		try {
			const target = await readlink(linkPath)
			// Target is relative directory name (e.g., "default")
			return target
		} catch {
			// No symlink, fallback to first profile
			const profiles = await this.list()
			const firstProfile = profiles[0]
			if (!firstProfile) {
				throw new ProfilesNotInitializedError()
			}
			return firstProfile
		}
	}

	/**
	 * Set the current profile.
	 * @param name - Profile name to set as current
	 */
	async setCurrent(name: string): Promise<void> {
		if (!(await this.exists(name))) {
			throw new ProfileNotFoundError(name)
		}

		const linkPath = getCurrentSymlink()
		// Use relative target so symlink works if profiles dir moves
		await atomicSymlink(name, linkPath)
	}

	/**
	 * Initialize profiles with a default profile.
	 * Called by `ocx ghost init`.
	 */
	async initialize(): Promise<void> {
		// Create profiles directory
		await mkdir(this.profilesDir, { recursive: true, mode: 0o700 })

		// Create default profile
		await this.add("default")

		// Set as current
		await this.setCurrent("default")
	}
}

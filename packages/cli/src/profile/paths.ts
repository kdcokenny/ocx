import { existsSync, statSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

// =============================================================================
// FILE NAME CONSTANTS
// =============================================================================

/** OCX configuration file name */
export const OCX_CONFIG_FILE = "ocx.jsonc"

/** OpenCode configuration file name */
export const OPENCODE_CONFIG_FILE = "opencode.jsonc"

/** Local config directory name */
export const LOCAL_CONFIG_DIR = ".opencode"

export interface GlobalPathResolutionOptions {
	/** Optional XDG override for deterministic path resolution in tests */
	xdgConfigHome?: string
	/** Optional home-directory override for deterministic path resolution in tests */
	homeDir?: string
}

export type OpencodePathScope = "global-root" | "global-profile-root" | "local-project"

export class RequiredGlobalConfigReadError extends Error {
	constructor(
		readonly reason: "missing" | "not-file" | "read-failed",
		readonly configPath: string,
		detail?: string,
	) {
		const reasonText =
			reason === "missing"
				? `Required global config is missing at "${configPath}".`
				: reason === "not-file"
					? `Required global config target is not a file: "${configPath}".`
					: `Failed to read required global config at "${configPath}": ${detail ?? "Unknown read error"}`

		super(reasonText)
		this.name = "RequiredGlobalConfigReadError"
	}
}

function resolveConfigBaseDir(options: GlobalPathResolutionOptions = {}): string {
	const xdgConfigHome = options.xdgConfigHome ?? process.env.XDG_CONFIG_HOME
	if (xdgConfigHome && xdgConfigHome.trim().length > 0) {
		return path.resolve(xdgConfigHome)
	}

	const homeDir = options.homeDir ?? homedir()
	return path.resolve(homeDir, ".config")
}

function isWithinDirectory(parentPath: string, candidatePath: string): boolean {
	const resolvedParent = path.resolve(parentPath)
	const resolvedCandidate = path.resolve(candidatePath)
	const relativeToParent = path.relative(resolvedParent, resolvedCandidate)

	if (relativeToParent === "") {
		return true
	}

	if (relativeToParent === "..") {
		return false
	}

	if (relativeToParent.startsWith(`..${path.sep}`)) {
		return false
	}

	return !path.isAbsolute(relativeToParent)
}

/**
 * Resolve the canonical global OpenCode root directory.
 * Example: ~/.config/opencode or $XDG_CONFIG_HOME/opencode
 */
export function getGlobalOpencodeRoot(options: GlobalPathResolutionOptions = {}): string {
	return path.join(resolveConfigBaseDir(options), "opencode")
}

/**
 * Classify whether a path is inside global OpenCode scope.
 */
export function resolveOpencodePathScope(
	cwd: string,
	options: GlobalPathResolutionOptions = {},
): OpencodePathScope {
	const globalRoot = getGlobalOpencodeRoot(options)
	if (!isWithinDirectory(globalRoot, cwd)) {
		return "local-project"
	}

	const globalProfilesRoot = path.join(globalRoot, "profiles")
	if (isWithinDirectory(globalProfilesRoot, cwd)) {
		return "global-profile-root"
	}

	return "global-root"
}

// =============================================================================
// PROFILE PATH HELPERS
// =============================================================================

/**
 * Get the global profiles directory path.
 * Respects XDG_CONFIG_HOME if set.
 * @returns Absolute path to ~/.config/opencode/profiles/
 */
export function getProfilesDir(options: GlobalPathResolutionOptions = {}): string {
	return path.join(getGlobalOpencodeRoot(options), "profiles")
}

/**
 * Get the local profiles directory path (within project).
 * @param cwd - Working directory (defaults to process.cwd())
 * @returns Absolute path to .opencode/profiles/
 */
export function getLocalProfilesDir(cwd = process.cwd()): string {
	const localConfigDir = findLocalConfigDir(cwd)
	if (localConfigDir) {
		return path.join(localConfigDir, "profiles")
	}
	return path.join(cwd, LOCAL_CONFIG_DIR, "profiles")
}

/**
 * Get a specific global profile's directory path.
 * @param name - Profile name
 * @returns Absolute path to the global profile directory
 */
export function getProfileDir(name: string): string {
	return path.join(getProfilesDir(), name)
}

/**
 * Get a specific local profile's directory path.
 * Used only for detecting local profile presence (guard in getLayered).
 * @param name - Profile name
 * @param cwd - Working directory (defaults to process.cwd())
 * @returns Absolute path to the local profile directory
 */
export function getLocalProfileDir(name: string, cwd = process.cwd()): string {
	return path.join(getLocalProfilesDir(cwd), name)
}

/**
 * Get the path to a profile's ocx.jsonc file.
 * @param name - Profile name
 * @returns Absolute path to ocx.jsonc
 */
export function getProfileOcxConfig(name: string): string {
	return path.join(getProfileDir(name), "ocx.jsonc")
}

/**
 * Get the path to a profile's opencode.jsonc file.
 * @param name - Profile name
 * @returns Absolute path to opencode.jsonc
 */
export function getProfileOpencodeConfig(name: string): string {
	return path.join(getProfileDir(name), "opencode.jsonc")
}

/**
 * Get the path to a profile's AGENTS.md file.
 * @param name - Profile name
 * @returns Absolute path to AGENTS.md
 */
export function getProfileAgents(name: string): string {
	return path.join(getProfileDir(name), "AGENTS.md")
}

// =============================================================================
// LOCAL CONFIG DISCOVERY
// =============================================================================

/**
 * Find the local config directory by walking up from cwd.
 * Stops at first .opencode/ directory or git root.
 * @param cwd - Starting directory
 * @returns Path to .opencode/ directory, or null if not found
 */
export function findLocalConfigDir(cwd: string): string | null {
	let currentDir = cwd

	while (true) {
		// Check for .opencode/ directory at this level
		const configDir = path.join(currentDir, LOCAL_CONFIG_DIR)
		if (existsSync(configDir) && statSync(configDir).isDirectory()) {
			return configDir
		}

		// Check if we've hit the git root (.git directory)
		const gitDir = path.join(currentDir, ".git")
		if (existsSync(gitDir)) {
			// At git root, stop searching
			return null
		}

		// Move up one directory
		const parentDir = path.dirname(currentDir)
		if (parentDir === currentDir) {
			// Reached filesystem root
			return null
		}
		currentDir = parentDir
	}
}

// =============================================================================
// GLOBAL CONFIG HELPERS
// =============================================================================

/**
 * Get the global base ocx.jsonc path.
 * @returns Path to ~/.config/opencode/ocx.jsonc
 */
export function getGlobalConfig(): string {
	return path.join(getGlobalOpencodeRoot(), OCX_CONFIG_FILE)
}

/**
 * Read global ocx.jsonc as a required file.
 * Missing targets and directory targets fail loudly.
 */
export async function readRequiredGlobalOcxConfig(
	options: GlobalPathResolutionOptions = {},
): Promise<{ path: string; content: string }> {
	const configPath = path.join(getGlobalOpencodeRoot(options), OCX_CONFIG_FILE)

	let configStats: Awaited<ReturnType<typeof stat>>
	try {
		configStats = await stat(configPath)
	} catch (error) {
		const errorCode = (error as NodeJS.ErrnoException).code
		if (errorCode === "ENOENT" || errorCode === "ENOTDIR") {
			throw new RequiredGlobalConfigReadError("missing", configPath)
		}
		throw new RequiredGlobalConfigReadError(
			"read-failed",
			configPath,
			error instanceof Error ? error.message : String(error),
		)
	}

	if (!configStats.isFile()) {
		throw new RequiredGlobalConfigReadError("not-file", configPath)
	}

	try {
		const content = await readFile(configPath, "utf8")
		return { path: configPath, content }
	} catch (error) {
		throw new RequiredGlobalConfigReadError(
			"read-failed",
			configPath,
			error instanceof Error ? error.message : String(error),
		)
	}
}

/**
 * Profile Installation from Registry
 *
 * Installs a profile package from a registry, including:
 * - Profile files (ocx.jsonc, opencode.jsonc, AGENTS.md) -> flat in profile dir
 * - Dependencies (agents, skills, etc.) -> profile's .opencode/ subdirectory
 * - Lock file creation for reproducible installs
 */

import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { ConfigProvider } from "../../config/provider"
import { getProfileDir, getProfilesDir } from "../../profile/paths"
import { profileNameSchema } from "../../profile/schema"
import { fetchComponent, fetchFileContent, fetchRegistryIndex } from "../../registry/fetcher"
import type { RegistryConfig } from "../../schemas/config"
import { type OcxLock, writeOcxLock } from "../../schemas/config"
import { normalizeComponentManifest } from "../../schemas/registry"
import { ConflictError, NotFoundError, ValidationError } from "../../utils/errors"
import { createSpinner, logger } from "../../utils/index"
import { runAddCore } from "../add"

// =============================================================================
// TYPES
// =============================================================================

export interface InstallProfileOptions {
	/** Registry namespace (e.g., "kdco") */
	namespace: string
	/** Component name (e.g., "minimal") */
	component: string
	/** Local profile name (e.g., "work") */
	profileName: string
	/** Resolved registry URL */
	registryUrl: string
	/** All configured registries (for dependency resolution) */
	registries: Record<string, RegistryConfig>
	/** Suppress output */
	quiet?: boolean
}

// =============================================================================
// HASHING UTILITIES
// =============================================================================

function hashContent(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex")
}

function hashBundle(files: { path: string; content: Buffer }[]): string {
	// Sort files for deterministic hashing
	const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))

	// Create a manifest of file hashes
	const manifestParts: string[] = []
	for (const file of sorted) {
		const hash = hashContent(file.content)
		manifestParts.push(`${file.path}:${hash}`)
	}

	// Hash the manifest itself
	return hashContent(manifestParts.join("\n"))
}

// =============================================================================
// MAIN INSTALLATION FUNCTION
// =============================================================================

/**
 * Install a profile from a registry.
 *
 * Flow:
 * 1. Fetch and validate the profile component manifest
 * 2. Fetch all profile files from registry
 * 3. Create staging directory for atomic install
 * 4. Write profile files (flat in profile dir)
 * 5. Create ocx.lock with installedFrom metadata
 * 6. Move staging dir to final profile location
 * 7. Install dependencies via runAddCore (if any)
 *
 * @throws ValidationError if component is not type "ocx:profile"
 * @throws NotFoundError if component doesn't exist
 * @throws ConflictError if profile exists and force is not set
 */
export async function installProfileFromRegistry(options: InstallProfileOptions): Promise<void> {
	const { namespace, component, profileName, registryUrl, registries, quiet } = options

	// ==========================================================================
	// Guard: Validate profile name at boundary (Law 2: Parse Don't Validate)
	// ==========================================================================

	const parseResult = profileNameSchema.safeParse(profileName)
	if (!parseResult.success) {
		throw new ValidationError(
			`Invalid profile name: "${profileName}". ` +
				`Profile names must start with a letter and contain only alphanumeric characters, dots, underscores, or hyphens.`,
		)
	}

	const profileDir = getProfileDir(profileName)
	const qualifiedName = `${namespace}/${component}`
	const profileExists = existsSync(profileDir)

	// ==========================================================================
	// Guard: Profile already exists
	// ==========================================================================

	if (profileExists) {
		throw new ConflictError(
			`Profile "${profileName}" already exists. Remove it first with 'ocx profile rm ${profileName}'.`,
		)
	}

	// ==========================================================================
	// Phase 1: Fetch and validate the profile component
	// ==========================================================================

	const fetchSpin = quiet ? null : createSpinner({ text: `Fetching ${qualifiedName}...` })
	fetchSpin?.start()

	let manifest: Awaited<ReturnType<typeof fetchComponent>>
	try {
		manifest = await fetchComponent(registryUrl, component)
	} catch (error) {
		fetchSpin?.fail(`Failed to fetch ${qualifiedName}`)
		if (error instanceof NotFoundError) {
			throw new NotFoundError(
				`Profile component "${qualifiedName}" not found in registry.\n\n` +
					`Check the component name and ensure the registry is configured.`,
			)
		}
		throw error
	}

	// Guard: Must be a profile type component
	if (manifest.type !== "ocx:profile") {
		fetchSpin?.fail(`Invalid component type`)
		throw new ValidationError(
			`Component "${qualifiedName}" is type "${manifest.type}", not "ocx:profile".\n\n` +
				`Only profile components can be installed with 'ocx profile add --from'.`,
		)
	}

	// Normalize the manifest (expand Cargo-style shorthands)
	const normalized = normalizeComponentManifest(manifest)

	fetchSpin?.succeed(`Fetched ${qualifiedName}`)

	// ==========================================================================
	// Phase 2: Fetch all profile files
	// ==========================================================================

	const filesSpin = quiet ? null : createSpinner({ text: "Downloading profile files..." })
	filesSpin?.start()

	const profileFiles: { path: string; target: string; content: Buffer }[] = []
	const embeddedFiles: { path: string; target: string; content: Buffer }[] = []

	for (const file of normalized.files) {
		const content = await fetchFileContent(registryUrl, component, file.path)
		const fileEntry = {
			path: file.path,
			target: file.target,
			content: Buffer.from(content),
		}

		// Route files: .opencode/ prefix goes to subdir, everything else goes flat
		if (file.target.startsWith(".opencode/")) {
			embeddedFiles.push(fileEntry)
		} else {
			profileFiles.push(fileEntry)
		}
	}

	filesSpin?.succeed(`Downloaded ${normalized.files.length} files`)

	// ==========================================================================
	// Phase 3: Create staging directory
	// Use profiles directory as parent to ensure same filesystem (avoids EXDEV on rename)
	// ==========================================================================

	const profilesDir = getProfilesDir()
	await mkdir(profilesDir, { recursive: true, mode: 0o700 })
	const stagingDir = await mkdtemp(join(profilesDir, ".staging-"))

	try {
		// ==========================================================================
		// Phase 4: Write profile files (flat in staging dir)
		// ==========================================================================

		const writeSpin = quiet ? null : createSpinner({ text: "Writing profile files..." })
		writeSpin?.start()

		for (const file of profileFiles) {
			const targetPath = join(stagingDir, file.target)
			const targetDir = dirname(targetPath)

			if (!existsSync(targetDir)) {
				await mkdir(targetDir, { recursive: true })
			}

			await writeFile(targetPath, file.content)
		}

		// Write embedded files flat (strip .opencode/ prefix for profile mode)
		for (const file of embeddedFiles) {
			// Strip .opencode/ prefix since profiles are flat
			const target = file.target.startsWith(".opencode/")
				? file.target.slice(".opencode/".length)
				: file.target
			const targetPath = join(stagingDir, target)
			const targetDir = dirname(targetPath)

			if (!existsSync(targetDir)) {
				await mkdir(targetDir, { recursive: true })
			}

			await writeFile(targetPath, file.content)
		}

		writeSpin?.succeed(`Wrote ${profileFiles.length + embeddedFiles.length} profile files`)

		// ==========================================================================
		// Phase 5: Create ocx.lock in staging directory
		// ==========================================================================

		const profileHash = hashBundle(profileFiles.map((f) => ({ path: f.path, content: f.content })))

		// Get registry version for the lock file
		const registryIndex = await fetchRegistryIndex(registryUrl)

		const lock: OcxLock = {
			lockVersion: 1,
			installedFrom: {
				registry: namespace,
				component,
				version: registryIndex.version,
				hash: profileHash,
				installedAt: new Date().toISOString(),
			},
			installed: {},
		}

		await writeOcxLock(stagingDir, lock, join(stagingDir, "ocx.lock"))

		// ==========================================================================
		// Phase 6: Move staging to final profile directory
		// ==========================================================================

		const renameSpin = quiet ? null : createSpinner({ text: "Moving to profile directory..." })
		renameSpin?.start()

		// Ensure parent directory exists
		const profilesDir = dirname(profileDir)
		if (!existsSync(profilesDir)) {
			await mkdir(profilesDir, { recursive: true, mode: 0o700 })
		}

		await rename(stagingDir, profileDir)
		renameSpin?.succeed("Profile installed")

		// ==========================================================================
		// Phase 7: Install dependencies via runAddCore
		// ==========================================================================

		if (manifest.dependencies.length > 0) {
			const depsSpin = quiet ? null : createSpinner({ text: "Installing dependencies..." })
			depsSpin?.start()

			try {
				const depRefs = manifest.dependencies.map((dep) =>
					dep.includes("/") ? dep : `${namespace}/${dep}`,
				)

				// Create provider for the installed profile (same pattern as GlobalConfigProvider)
				const provider: ConfigProvider = {
					cwd: profileDir,
					getRegistries: () => registries,
					getComponentPath: () => "", // Flat install - no .opencode/ prefix
				}

				await runAddCore(depRefs, { profile: profileName }, provider)
				depsSpin?.succeed(`Installed ${manifest.dependencies.length} dependencies`)
			} catch (error) {
				depsSpin?.fail("Failed to install dependencies")
				throw error
			}
		}

		// ==========================================================================
		// Summary
		// ==========================================================================

		if (!quiet) {
			logger.info("")
			logger.success(`Installed profile "${profileName}" from ${qualifiedName}`)
			logger.info("")
			logger.info("Profile contents:")
			for (const file of profileFiles) {
				logger.info(`  ${file.target}`)
			}
			for (const file of embeddedFiles) {
				const target = file.target.startsWith(".opencode/")
					? file.target.slice(".opencode/".length)
					: file.target
				logger.info(`  ${target}`)
			}
		}
	} catch (error) {
		// Cleanup staging directory on failure
		try {
			if (existsSync(stagingDir)) {
				await rm(stagingDir, { recursive: true })
			}
		} catch {
			// Ignore cleanup errors
		}
		throw error
	}
}

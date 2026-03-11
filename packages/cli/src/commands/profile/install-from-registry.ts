/**
 * Profile Installation from Registry
 *
 * Installs a profile package from a registry, including:
 * - Profile files (ocx.jsonc, opencode.jsonc, AGENTS.md) -> flat in profile dir
 * - Dependencies (agents, skills, etc.) via runAddCore in flat profile root
 * - V2 receipt initialization (.ocx/receipt.jsonc)
 */

import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { parse } from "jsonc-parser"
import type { ConfigProvider } from "../../config/provider"
import { getProfileDir, getProfilesDir } from "../../profile/paths"
import { profileNameSchema } from "../../profile/schema"
import { fetchComponent, fetchFileContent } from "../../registry/fetcher"
import { resolveHeadersForRegistry } from "../../registry/headers"
import type { RegistryConfig } from "../../schemas/config"
import { writeReceipt } from "../../schemas/config"
import { profileOcxConfigSchema } from "../../schemas/ocx"
import { normalizeComponentManifest } from "../../schemas/registry"
import { resolveComponentTargetRoot } from "../../utils/component-root-resolution"
import { ConfigError, ConflictError, NotFoundError, ValidationError } from "../../utils/errors"
import { createSpinner, logger } from "../../utils/index"
import { PathValidationError, validatePath } from "../../utils/path-security"
import { registerPlannedWriteOrThrow } from "../../utils/planned-writes"
import { isPlainObject } from "../../utils/type-guards"
import { runAddCore } from "../add"

// =============================================================================
// TYPES
// =============================================================================

export interface InstallProfileOptions {
	/** Registry name (configured alias, e.g., "kdco"). Required for identity resolution. */
	namespace?: string
	/** Component name (e.g., "minimal") */
	component: string
	/** Local profile name (e.g., "work") */
	profileName: string
	/** Resolved registry URL */
	registryUrl: string
	/** Full registry config (headers, source). Falls back to { url: registryUrl } for ephemeral registries. */
	registryConfig?: RegistryConfig
	/** Suppress output */
	quiet?: boolean
}

function formatProfileRollbackCleanupWarning(
	action: string,
	targetPath: string,
	error: unknown,
): string {
	const errorMessage = error instanceof Error ? error.message : String(error)
	return `${action} "${targetPath}" (${errorMessage})`
}

/**
 * Resolve an embedded .opencode/* profile target to a safe staging-relative path.
 * Re-validates containment after stripping the legacy prefix.
 */
export function resolveEmbeddedProfileTarget(rawTarget: string, stagingDir: string): string {
	if (!rawTarget.startsWith(".opencode/")) {
		throw new ValidationError(
			`Invalid embedded target "${rawTarget}": expected .opencode/ prefix for embedded profile files.`,
		)
	}

	const strippedTarget = rawTarget.slice(".opencode/".length)
	if (!strippedTarget) {
		throw new ValidationError(
			`Invalid embedded target "${rawTarget}": missing path after .opencode/ prefix.`,
		)
	}

	let safeAbsolutePath: string
	try {
		safeAbsolutePath = validatePath(stagingDir, strippedTarget)
	} catch (error) {
		if (error instanceof PathValidationError) {
			throw new ValidationError(`Invalid embedded target "${rawTarget}": ${error.message}`)
		}
		throw error
	}

	const safeRelativeTarget = relative(stagingDir, safeAbsolutePath).replace(/\\/g, "/")
	if (safeRelativeTarget === "." || safeRelativeTarget === "") {
		throw new ValidationError(
			`Invalid embedded target "${rawTarget}": target must resolve to a file path.`,
		)
	}

	return safeRelativeTarget
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
 * 5. Initialize V2 receipt (.ocx/receipt.jsonc)
 * 6. Move staging dir to final profile location
 * 7. Install dependencies via runAddCore (if any)
 *
 * @throws ValidationError if component is not type "profile"
 * @throws NotFoundError if component doesn't exist
 * @throws ConflictError if profile exists and force is not set
 */
export async function installProfileFromRegistry(options: InstallProfileOptions): Promise<void> {
	const {
		namespace: providedNamespace,
		component,
		profileName,
		registryUrl,
		registryConfig: providedRegistryConfig,
		quiet,
	} = options

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

	// ==========================================================================
	// Phase 0: Resolve registry name (required — cannot derive from index)
	// ==========================================================================

	let namespace: string
	if (providedNamespace) {
		namespace = providedNamespace
	} else {
		// Cannot derive from index — registry name must be provided by caller
		throw new ValidationError(
			`Registry name is required for URL-based profile installs.\n\n` +
				`Use a qualified component reference (e.g., 'my-registry/${component}') ` +
				`or specify --name to provide a registry alias.`,
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
			`Profile "${profileName}" already exists. Remove it first with 'ocx profile rm ${profileName} --global'.`,
		)
	}

	// ==========================================================================
	// Phase 1: Fetch and validate the profile component
	// ==========================================================================

	const fetchSpin = quiet ? null : createSpinner({ text: `Fetching ${qualifiedName}...` })
	fetchSpin?.start()

	const resolvedConfig = providedRegistryConfig ?? { url: registryUrl }
	const headers = await resolveHeadersForRegistry(resolvedConfig)

	let manifest: Awaited<ReturnType<typeof fetchComponent>>
	try {
		manifest = await fetchComponent(registryUrl, component, headers)
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

	// Guard: Must be canonical profile type component
	if (manifest.type !== "profile") {
		fetchSpin?.fail(`Invalid component type`)
		throw new ValidationError(
			`Component "${qualifiedName}" is type "${manifest.type}", not "profile".\n\n` +
				`Only profile components can be installed with 'ocx profile add --source <ns/comp> --global'.`,
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
		const content = await fetchFileContent(registryUrl, component, file.path, headers)
		const fileEntry = {
			path: file.path,
			target: file.target,
			content: Buffer.from(content),
		}

		// Route files: .opencode/ prefix marks embedded files for profile flattening
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
	let profilePromoted = false
	let installCommitted = false

	try {
		// ==========================================================================
		// Phase 4: Write profile files (flat in staging dir)
		// ==========================================================================

		const writeSpin = quiet ? null : createSpinner({ text: "Writing profile files..." })
		writeSpin?.start()

		const plannedWrites = new Map<
			string,
			{
				absolutePath: string
				relativePath: string
				content: Buffer
				source: string
			}
		>()

		for (const file of profileFiles) {
			const resolvedTarget = resolveComponentTargetRoot(file.target, stagingDir)
			const targetPath = join(stagingDir, resolvedTarget)

			registerPlannedWriteOrThrow(plannedWrites, {
				absolutePath: targetPath,
				relativePath: resolvedTarget,
				content: file.content,
				source: `${component}:${file.path}`,
			})
		}

		// Write embedded files flat (strip .opencode/ prefix for profile mode)
		for (const file of embeddedFiles) {
			const target = resolveEmbeddedProfileTarget(file.target, stagingDir)
			const resolvedTarget = resolveComponentTargetRoot(target, stagingDir)
			const targetPath = join(stagingDir, resolvedTarget)

			registerPlannedWriteOrThrow(plannedWrites, {
				absolutePath: targetPath,
				relativePath: resolvedTarget,
				content: file.content,
				source: `${component}:${file.path}`,
			})
		}

		for (const plannedWrite of plannedWrites.values()) {
			const targetPath = plannedWrite.absolutePath
			const targetDir = dirname(targetPath)

			if (!existsSync(targetDir)) {
				await mkdir(targetDir, { recursive: true })
			}

			await writeFile(targetPath, plannedWrite.content)
		}

		writeSpin?.succeed(`Wrote ${plannedWrites.size} profile files`)

		// ==========================================================================
		// Phase 5: Initialize V2 receipt in staging directory
		// ==========================================================================

		await writeReceipt(stagingDir, {
			version: 1,
			root: profileDir,
			installed: {},
		})

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
		profilePromoted = true
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

				// ========================================================================
				// Law 2: Parse Don't Validate - Extract and validate profile's registries
				// ========================================================================

				// 1. Parse the profile's ocx.jsonc to get its registry declarations
				const profileOcxConfigPath = join(profileDir, "ocx.jsonc")
				let profileRegistries: Record<string, RegistryConfig> = {}

				if (existsSync(profileOcxConfigPath)) {
					const profileOcxFile = Bun.file(profileOcxConfigPath)
					const profileOcxContent = await profileOcxFile.text()
					const profileOcxRaw = parse(profileOcxContent)

					// Validate registries with Zod
					const parseResult = profileOcxConfigSchema.safeParse(profileOcxRaw)
					if (parseResult.success) {
						profileRegistries = parseResult.data.registries ?? {}
					} else if (isPlainObject(profileOcxRaw) && "registries" in profileOcxRaw) {
						// registries field exists but is invalid - fail loud (Law 4)
						throw new ConfigError(
							`Invalid registries in profile "${profileName}": ${parseResult.error.message}`,
						)
					}
					// If parse fails and no registries field, just use empty {} (already initialized)
				}

				// Create provider with FULL profile registries
				// Pass all registries from the profile's ocx.jsonc to support transitive dependencies.
				// The profile's ocx.jsonc should declare all registries needed (including transitive).
				const provider: ConfigProvider = {
					cwd: profileDir,
					getRegistries: () => profileRegistries,
					getComponentPath: () => "", // Flat install - no .opencode/ prefix
				}

				await runAddCore(depRefs, { profile: profileName, quiet }, provider)
				depsSpin?.succeed(`Installed ${manifest.dependencies.length} dependencies`)
			} catch (error) {
				depsSpin?.fail("Failed to install dependencies")
				throw error
			}
		}

		installCommitted = true

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
				const target = resolveEmbeddedProfileTarget(file.target, profileDir)
				logger.info(`  ${target}`)
			}
		}
	} catch (error) {
		const cleanupWarnings: string[] = []

		// Cleanup staging directory on failure
		try {
			if (existsSync(stagingDir)) {
				await rm(stagingDir, { recursive: true })
			}
		} catch (cleanupError) {
			cleanupWarnings.push(
				formatProfileRollbackCleanupWarning(
					"Profile add rollback cleanup warning: failed to remove staging directory",
					stagingDir,
					cleanupError,
				),
			)
		}

		// Roll back promoted profile when dependency install (or later commit work) fails.
		// This keeps failure deterministic: command failure leaves no blocking partial profile.
		if (profilePromoted && !installCommitted) {
			try {
				if (existsSync(profileDir)) {
					await rm(profileDir, { recursive: true, force: true })
				}
			} catch (cleanupError) {
				cleanupWarnings.push(
					formatProfileRollbackCleanupWarning(
						"Profile add rollback cleanup warning: failed to remove promoted profile",
						profileDir,
						cleanupError,
					),
				)
			}
		}

		if (!quiet) {
			for (const warning of cleanupWarnings) {
				logger.warn(warning)
			}
		}
		throw error
	}
}

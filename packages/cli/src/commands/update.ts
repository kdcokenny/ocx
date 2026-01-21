/**
 * OCX CLI - update command
 * Update installed components from registries
 */

import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import type { Command } from "commander"
import { type ConfigProvider, LocalConfigProvider } from "../config/provider"
import { fetchComponentVersion, fetchFileContent } from "../registry/fetcher"
import { findOcxLock, type OcxLock, readOcxLock, writeOcxLock } from "../schemas/config"
import {
	type ComponentFileObject,
	normalizeComponentManifest,
	parseQualifiedComponent,
} from "../schemas/registry"
import { ConfigError, NotFoundError, ValidationError } from "../utils/errors"
import { createSpinner, handleError, logger } from "../utils/index"

// =============================================================================
// TYPES
// =============================================================================

export interface UpdateOptions {
	all?: boolean
	registry?: string
	dryRun?: boolean
	cwd?: string
	quiet?: boolean
	verbose?: boolean
	json?: boolean
}

interface ComponentSpec {
	component: string
	version?: string
}

interface UpdateResult {
	qualifiedName: string
	oldVersion: string
	newVersion: string
	status: "updated" | "up-to-date" | "would-update"
}

// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerUpdateCommand(program: Command): void {
	program
		.command("update [components...]")
		.description(
			"Update installed components (use @version suffix to pin, e.g., kdco/agents@1.2.0)",
		)
		.option("--all", "Update all installed components")
		.option("--registry <name>", "Update all components from a specific registry")
		.option("--dry-run", "Preview changes without applying")
		.option("--cwd <path>", "Working directory", process.cwd())
		.option("-q, --quiet", "Suppress output")
		.option("-v, --verbose", "Verbose output")
		.option("--json", "Output as JSON")
		.action(async (components: string[], options: UpdateOptions) => {
			try {
				await runUpdate(components, options)
			} catch (error) {
				handleError(error, { json: options.json })
			}
		})
}

// =============================================================================
// MAIN UPDATE LOGIC
// =============================================================================

async function runUpdate(componentNames: string[], options: UpdateOptions): Promise<void> {
	const cwd = options.cwd ?? process.cwd()
	const provider = await LocalConfigProvider.requireInitialized(cwd)
	await runUpdateCore(componentNames, options, provider)
}

/**
 * Core update logic shared between local and profile modes.
 * Accepts a ConfigProvider to abstract config source.
 */
export async function runUpdateCore(
	componentNames: string[],
	options: UpdateOptions,
	provider: ConfigProvider,
): Promise<void> {
	const { path: lockPath } = findOcxLock(provider.cwd)
	const registries = provider.getRegistries()

	// -------------------------------------------------------------------------
	// Guard clauses (Law 1: Early Exit)
	// -------------------------------------------------------------------------

	// Guard: No lock file (nothing installed yet)
	const lock = await readOcxLock(provider.cwd)
	if (!lock || Object.keys(lock.installed).length === 0) {
		throw new ValidationError("Nothing installed yet. Run 'ocx add <component>' first.")
	}

	// Guard: No args and no flags
	const hasComponents = componentNames.length > 0
	const hasAll = options.all === true
	const hasRegistry = options.registry !== undefined
	if (!hasComponents && !hasAll && !hasRegistry) {
		throw new ValidationError(
			"Specify components, use --all, or use --registry <name>.\n\n" +
				"Examples:\n" +
				"  ocx update kdco/agents           # Update specific component\n" +
				"  ocx update --all                 # Update all installed components\n" +
				"  ocx update --registry kdco       # Update all from a registry",
		)
	}

	// Guard: --all with components
	if (hasAll && hasComponents) {
		throw new ValidationError(
			"Cannot specify components with --all.\n" +
				"Use either 'ocx update --all' or 'ocx update <components>'.",
		)
	}

	// Guard: --registry with components
	if (hasRegistry && hasComponents) {
		throw new ValidationError(
			"Cannot specify components with --registry.\n" +
				"Use either 'ocx update --registry <name>' or 'ocx update <components>'.",
		)
	}

	// Guard: --all with --registry
	if (hasAll && hasRegistry) {
		throw new ValidationError(
			"Cannot use --all with --registry.\n" +
				"Use either 'ocx update --all' or 'ocx update --registry <name>'.",
		)
	}

	// -------------------------------------------------------------------------
	// Parse component specs and validate versions
	// -------------------------------------------------------------------------

	const parsedComponents = componentNames.map(parseComponentSpec)

	// Guard: Invalid version specifier (e.g., kdco/agents@ or kdco/agents@@1.2.0)
	for (const spec of parsedComponents) {
		if (spec.version !== undefined && spec.version === "") {
			throw new ValidationError(
				`Invalid version specifier in '${spec.component}@'.` +
					"\nVersion cannot be empty. Use 'kdco/agents@1.2.0' or omit the version for latest.",
			)
		}
	}

	// -------------------------------------------------------------------------
	// Determine which components to update
	// -------------------------------------------------------------------------

	const componentsToUpdate = resolveComponentsToUpdate(lock, parsedComponents, options)

	// Guard: No matching components
	if (componentsToUpdate.length === 0) {
		if (hasRegistry) {
			throw new NotFoundError(`No installed components from registry '${options.registry}'.`)
		}
		throw new NotFoundError("No matching components found to update.")
	}

	// -------------------------------------------------------------------------
	// Fetch and compare
	// -------------------------------------------------------------------------

	const spin = options.quiet ? null : createSpinner({ text: "Checking for updates..." })
	spin?.start()

	const results: UpdateResult[] = []
	const updates: {
		qualifiedName: string
		component: ReturnType<typeof normalizeComponentManifest>
		files: { path: string; content: Buffer }[]
		newHash: string
		newVersion: string
		baseUrl: string
	}[] = []

	try {
		for (const spec of componentsToUpdate) {
			const qualifiedName = spec.component
			const lockEntry = lock.installed[qualifiedName]
			// Guard: component must exist in lock (already validated in resolveComponentsToUpdate)
			if (!lockEntry) {
				throw new NotFoundError(`Component '${qualifiedName}' not found in lock file.`)
			}

			const { namespace, component: componentName } = parseQualifiedComponent(qualifiedName)

			// Get registry config
			const regConfig = registries[namespace]
			if (!regConfig) {
				throw new ConfigError(
					`Registry '${namespace}' not configured. Component '${qualifiedName}' cannot be updated.`,
				)
			}

			// Fetch component (specific version or latest)
			const fetchResult = await fetchComponentVersion(regConfig.url, componentName, spec.version)
			const manifest = fetchResult.manifest
			const version = fetchResult.version

			const normalizedManifest = normalizeComponentManifest(manifest)

			// Fetch all files and compute hash
			const files: { path: string; content: Buffer }[] = []
			for (const file of normalizedManifest.files) {
				const content = await fetchFileContent(regConfig.url, componentName, file.path)
				files.push({ path: file.path, content: Buffer.from(content) })
			}

			const newHash = await hashBundle(files)

			// Compare hashes
			if (newHash === lockEntry.hash) {
				results.push({
					qualifiedName,
					oldVersion: lockEntry.version,
					newVersion: version,
					status: "up-to-date",
				})
			} else if (options.dryRun) {
				results.push({
					qualifiedName,
					oldVersion: lockEntry.version,
					newVersion: version,
					status: "would-update",
				})
			} else {
				results.push({
					qualifiedName,
					oldVersion: lockEntry.version,
					newVersion: version,
					status: "updated",
				})
				updates.push({
					qualifiedName,
					component: normalizedManifest,
					files,
					newHash,
					newVersion: version,
					baseUrl: regConfig.url,
				})
			}
		}

		spin?.succeed(`Checked ${componentsToUpdate.length} component(s)`)

		// -------------------------------------------------------------------------
		// Dry-run output
		// -------------------------------------------------------------------------

		if (options.dryRun) {
			outputDryRun(results, options)
			return
		}

		// -------------------------------------------------------------------------
		// Apply updates
		// -------------------------------------------------------------------------

		if (updates.length === 0) {
			if (!options.quiet && !options.json) {
				logger.info("")
				logger.success("All components are up to date.")
			}
			if (options.json) {
				console.log(JSON.stringify({ success: true, updated: [], upToDate: results }, null, 2))
			}
			return
		}

		const installSpin = options.quiet ? null : createSpinner({ text: "Updating components..." })
		installSpin?.start()

		for (const update of updates) {
			// Write files
			for (const file of update.files) {
				const fileObj = update.component.files.find(
					(f: ComponentFileObject) => f.path === file.path,
				)
				if (!fileObj) continue

				const targetPath = join(provider.cwd, fileObj.target)
				const targetDir = dirname(targetPath)

				if (!existsSync(targetDir)) {
					await mkdir(targetDir, { recursive: true })
				}

				await writeFile(targetPath, file.content)

				if (options.verbose) {
					logger.info(`  ✓ Updated ${fileObj.target}`)
				}
			}

			// Update lock entry - we know it exists because we validated in resolveComponentsToUpdate
			const existingEntry = lock.installed[update.qualifiedName]
			if (!existingEntry) {
				throw new NotFoundError(`Component '${update.qualifiedName}' not found in lock file.`)
			}
			lock.installed[update.qualifiedName] = {
				registry: existingEntry.registry,
				version: update.newVersion,
				hash: update.newHash,
				files: existingEntry.files,
				installedAt: existingEntry.installedAt,
				updatedAt: new Date().toISOString(),
			}
		}

		installSpin?.succeed(`Updated ${updates.length} component(s)`)

		// Save lock file
		await writeOcxLock(provider.cwd, lock, lockPath)

		// -------------------------------------------------------------------------
		// Output results
		// -------------------------------------------------------------------------

		if (options.json) {
			console.log(
				JSON.stringify(
					{
						success: true,
						updated: results.filter((r) => r.status === "updated"),
						upToDate: results.filter((r) => r.status === "up-to-date"),
					},
					null,
					2,
				),
			)
		} else if (!options.quiet) {
			logger.info("")
			for (const result of results) {
				if (result.status === "updated") {
					logger.info(`  ✓ ${result.qualifiedName} (${result.oldVersion} → ${result.newVersion})`)
				} else if (result.status === "up-to-date" && options.verbose) {
					logger.info(`  ○ ${result.qualifiedName} (already up to date)`)
				}
			}
			logger.info("")
			logger.success(`Done! Updated ${updates.length} component(s).`)
		}
	} catch (error) {
		spin?.fail("Failed to check for updates")
		throw error
	}
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Parse a component specifier into component name and optional version.
 * Uses lastIndexOf to handle edge cases like kdco@agents@1.2.0.
 * Law 2: Parse at boundary, trust internally.
 *
 * @example
 * parseComponentSpec("kdco/agents@1.2.0") // { component: "kdco/agents", version: "1.2.0" }
 * parseComponentSpec("kdco/agents")       // { component: "kdco/agents" }
 */
function parseComponentSpec(spec: string): ComponentSpec {
	const atIndex = spec.lastIndexOf("@")
	// @ at start or not found means no version
	if (atIndex <= 0) {
		return { component: spec }
	}
	return {
		component: spec.slice(0, atIndex),
		version: spec.slice(atIndex + 1),
	}
}

/**
 * Resolve which components to update based on args and flags.
 * Law 4: Fail fast if component not found in lock.
 */
function resolveComponentsToUpdate(
	lock: OcxLock,
	parsedComponents: ComponentSpec[],
	options: UpdateOptions,
): ComponentSpec[] {
	const installedComponents = Object.keys(lock.installed)

	// --all: update all installed components (no version override)
	if (options.all) {
		return installedComponents.map((c) => ({ component: c }))
	}

	// --registry: filter by registry namespace (no version override)
	if (options.registry) {
		return installedComponents
			.filter((name) => {
				const entry = lock.installed[name]
				return entry?.registry === options.registry
			})
			.map((c) => ({ component: c }))
	}

	// Specific components: validate they exist
	const result: ComponentSpec[] = []
	for (const spec of parsedComponents) {
		const name = spec.component
		// Validate format (must be qualified)
		if (!name.includes("/")) {
			const suggestions = installedComponents.filter((installed) => installed.endsWith(`/${name}`))
			if (suggestions.length === 1) {
				throw new ValidationError(
					`Ambiguous component '${name}'. Did you mean '${suggestions[0]}'?`,
				)
			}
			if (suggestions.length > 1) {
				throw new ValidationError(
					`Ambiguous component '${name}'. Found in multiple registries:\n` +
						suggestions.map((s) => `  - ${s}`).join("\n") +
						"\n\nPlease use a fully qualified name (registry/component).",
				)
			}
			throw new ValidationError(
				`Component '${name}' must include a registry prefix (e.g., 'kdco/${name}').`,
			)
		}

		// Check if installed
		if (!lock.installed[name]) {
			throw new NotFoundError(
				`Component '${name}' is not installed.\nRun 'ocx add ${name}' to install it first.`,
			)
		}

		result.push(spec)
	}

	return result
}

/**
 * Output dry-run results.
 */
function outputDryRun(results: UpdateResult[], options: UpdateOptions): void {
	const wouldUpdate = results.filter((r) => r.status === "would-update")
	const upToDate = results.filter((r) => r.status === "up-to-date")

	if (options.json) {
		console.log(JSON.stringify({ dryRun: true, wouldUpdate, upToDate }, null, 2))
		return
	}

	if (!options.quiet) {
		logger.info("")

		if (wouldUpdate.length > 0) {
			logger.info("Would update:")
			for (const result of wouldUpdate) {
				logger.info(`  ${result.qualifiedName} (${result.oldVersion} → ${result.newVersion})`)
			}
		}

		if (upToDate.length > 0 && options.verbose) {
			logger.info("")
			logger.info("Already up to date:")
			for (const result of upToDate) {
				logger.info(`  ${result.qualifiedName}`)
			}
		}

		if (wouldUpdate.length > 0) {
			logger.info("")
			logger.info("Run without --dry-run to apply changes.")
		} else {
			logger.info("All components are up to date.")
		}
	}
}

/**
 * Compute SHA-256 hash of file content.
 */
async function hashContent(content: string | Buffer): Promise<string> {
	return createHash("sha256").update(content).digest("hex")
}

/**
 * Compute deterministic hash for a bundle of files.
 * Files are sorted by path for consistent hashing.
 */
async function hashBundle(files: { path: string; content: Buffer }[]): Promise<string> {
	const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))

	const manifestParts: string[] = []
	for (const file of sorted) {
		const hash = await hashContent(file.content)
		manifestParts.push(`${file.path}:${hash}`)
	}

	return hashContent(manifestParts.join("\n"))
}

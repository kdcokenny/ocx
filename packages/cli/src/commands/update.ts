/**
 * OCX CLI - update command
 * Update installed components from registries
 */

import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import type { Command } from "commander"
import { type ConfigProvider, GlobalConfigProvider, LocalConfigProvider } from "../config/provider"
import { fetchComponentVersion, fetchFileContent } from "../registry/fetcher"
import { parseCanonicalId, type Receipt, readReceipt, writeReceipt } from "../schemas/config"
import {
	type ComponentFileObject,
	normalizeComponentManifest,
	parseQualifiedComponent,
} from "../schemas/registry"
import { type DryRunAction, type DryRunResult, outputDryRun } from "../utils/dry-run"
import { ConfigError, NotFoundError, ValidationError } from "../utils/errors"
import { handleError } from "../utils/handle-error"
import { logger } from "../utils/logger"
import { resolveTargetPath } from "../utils/paths"
import { registerPlannedWriteOrThrow } from "../utils/planned-writes"
import { hashBundle, hashContent } from "../utils/receipt"
import { addCommonOptions, addGlobalOption, addVerboseOption } from "../utils/shared-options"
import { createSpinner } from "../utils/spinner"

// =============================================================================
// TYPES
// =============================================================================

export interface UpdateOptions {
	all?: boolean
	registry?: string
	dryRun?: boolean
	global?: boolean
	cwd?: string
	quiet?: boolean
	verbose?: boolean
	json?: boolean
}

interface ComponentSpec {
	component: string
}

interface UpdateResult {
	qualifiedName: string
	oldVersion: string
	newVersion: string
	status: "updated" | "up-to-date" | "would-update"
}

interface PreparedUpdateFile {
	resolvedTarget: string
	targetPath: string
	content: Buffer
}

interface PendingUpdate {
	canonicalId: string
	component: ReturnType<typeof normalizeComponentManifest>
	files: { path: string; content: Buffer }[]
	newHash: string
	newVersion: string
	baseUrl: string
	registryName: string
	name: string
}

interface PreparedUpdate {
	update: PendingUpdate
	preparedFiles: PreparedUpdateFile[]
}

interface AppliedWrite {
	targetPath: string
	backupPath: string | null
}

interface AppliedWriteTransaction {
	commit: () => Promise<void>
	rollback: () => Promise<void>
}

interface UpdateFileOps {
	rename?: (oldPath: string, newPath: string) => Promise<void>
}

type UpdateFailurePhase = "check" | "apply"

function formatAddCommandHint(component: string, options: UpdateOptions): string {
	return `ocx add${options.global ? " --global" : ""} ${component}`
}

export function resolveUpdateFailureMessage(phase: UpdateFailurePhase): string {
	return phase === "apply" ? "Failed to update components" : "Failed to check for updates"
}

// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerUpdateCommand(program: Command): void {
	const cmd = program.command("update [components...]").description("Update installed components")

	addCommonOptions(cmd)
	addVerboseOption(cmd)
	addGlobalOption(cmd)

	cmd
		.option("--all", "Update all installed components")
		.option("--registry <name>", "Update all components from a specific registry")
		.option("--dry-run", "Preview changes without applying")
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
	const provider = options.global
		? await GlobalConfigProvider.requireInitialized()
		: await LocalConfigProvider.requireInitialized(cwd)
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
	fileOps?: UpdateFileOps,
): Promise<void> {
	const registries = provider.getRegistries()
	const componentPath = provider.getComponentPath()
	const isFlattened = componentPath === "" || componentPath === "."

	// -------------------------------------------------------------------------
	// Parse component specs (Law 2: Parse at boundary before any logic)
	// -------------------------------------------------------------------------

	const parsedComponents = componentNames.map(parseComponentSpec)

	// -------------------------------------------------------------------------
	// Guard clauses (Law 1: Early Exit)
	// -------------------------------------------------------------------------

	// Guard: No receipt file (nothing installed yet)
	const receipt = await readReceipt(provider.cwd)
	if (!receipt || Object.keys(receipt.installed).length === 0) {
		// If user specified components, give specific error
		if (componentNames.length > 0) {
			const requestedComponent = componentNames[0]
			if (!requestedComponent) {
				throw new Error("Unexpected: component name missing despite non-empty componentNames")
			}
			throw new NotFoundError(
				`Component '${requestedComponent}' is not installed. Run '${formatAddCommandHint(requestedComponent, options)}' first.`,
			)
		}
		// Generic case for --all or --registry
		throw new NotFoundError(
			`No components installed. Run '${formatAddCommandHint("<component>", options)}' first.`,
		)
	}

	// Guard: No args and no flags
	const hasComponents = componentNames.length > 0
	const hasAll = options.all === true
	const hasRegistry = options.registry !== undefined
	if (!hasComponents && !hasAll && !hasRegistry) {
		throw new ValidationError(
			"Specify components, use --all, or use --registry <name>.\n\n" +
				"Examples:\n" +
				"  ocx update alias/component        # Update specific component\n" +
				"  ocx update --all                   # Update all installed components\n" +
				"  ocx update --registry my-alias     # Update all from a registry",
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
	// Determine which components to update
	// -------------------------------------------------------------------------

	const componentsToUpdate = resolveComponentsToUpdate(receipt, parsedComponents, options)

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
	let installSpin: ReturnType<typeof createSpinner> | null = null
	let failurePhase: UpdateFailurePhase = "check"
	let appliedWriteTransaction: AppliedWriteTransaction | null = null

	const results: UpdateResult[] = []
	const updates: PendingUpdate[] = []

	try {
		for (const spec of componentsToUpdate) {
			const canonicalId = spec.component
			const entry = receipt.installed[canonicalId]
			// Guard: component must exist in receipt (already validated in resolveComponentsToUpdate)
			if (!entry) {
				throw new NotFoundError(`Component '${canonicalId}' not found in receipt.`)
			}

			const registryName = entry.registryName
			const componentName = entry.name

			// Get registry config by alias
			const regConfig = registries[registryName]
			if (!regConfig) {
				throw new ConfigError(
					`Registry alias '${registryName}' not configured. Component '${canonicalId}' cannot be updated.`,
				)
			}

			// Fetch component (latest version)
			const fetchResult = await fetchComponentVersion(regConfig.url, componentName, undefined)
			const manifest = fetchResult.manifest

			const normalizedManifest = normalizeComponentManifest(manifest)

			// Fetch all files and compute hash
			const files: { path: string; content: Buffer }[] = []
			for (const file of normalizedManifest.files) {
				const content = await fetchFileContent(regConfig.url, componentName, file.path)
				files.push({ path: file.path, content: Buffer.from(content) })
			}

			const newHash = await hashBundle(files)
			const newVersion = `sha256:${newHash}` // Use hash as version/revision

			// Compare hashes
			if (newHash === entry.hash) {
				results.push({
					qualifiedName: canonicalId,
					oldVersion: entry.revision,
					newVersion: newVersion,
					status: "up-to-date",
				})
			} else if (options.dryRun) {
				results.push({
					qualifiedName: canonicalId,
					oldVersion: entry.revision,
					newVersion: newVersion,
					status: "would-update",
				})
			} else {
				results.push({
					qualifiedName: canonicalId,
					oldVersion: entry.revision,
					newVersion: newVersion,
					status: "updated",
				})
				updates.push({
					canonicalId,
					component: normalizedManifest,
					files,
					newHash,
					newVersion: newVersion,
					baseUrl: regConfig.url,
					registryName,
					name: componentName,
				})
			}
		}

		spin?.succeed(`Checked ${componentsToUpdate.length} component(s)`)

		// -------------------------------------------------------------------------
		// Dry-run output
		// -------------------------------------------------------------------------

		if (options.dryRun) {
			outputUpdateDryRun(results, options)
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

		failurePhase = "apply"
		installSpin = options.quiet ? null : createSpinner({ text: "Updating components..." })
		installSpin?.start()

		const plannedWrites = new Map<
			string,
			{
				absolutePath: string
				relativePath: string
				content: Buffer
				source: string
			}
		>()

		const preparedUpdates: PreparedUpdate[] = []

		for (const update of updates) {
			const preparedFiles: PreparedUpdateFile[] = []

			for (const file of update.files) {
				const fileObj = update.component.files.find(
					(f: ComponentFileObject) => f.path === file.path,
				)
				if (!fileObj) {
					throw new ValidationError(
						`File "${file.path}" not found in component manifest for "${update.registryName}/${update.name}".`,
					)
				}

				const resolvedTarget = resolveTargetPath(fileObj.target, isFlattened, provider.cwd)
				const targetPath = join(provider.cwd, resolvedTarget)

				registerPlannedWriteOrThrow(plannedWrites, {
					absolutePath: targetPath,
					relativePath: resolvedTarget,
					content: file.content,
					source: `${update.registryName}/${update.name}:${fileObj.path}`,
				})

				preparedFiles.push({
					resolvedTarget,
					targetPath,
					content: file.content,
				})
			}

			preparedUpdates.push({ update, preparedFiles })
		}

		appliedWriteTransaction = await applyPreparedUpdatesAtomically(preparedUpdates, {
			verbose: options.verbose,
			quiet: options.quiet,
			fileOps,
		})

		for (const prepared of preparedUpdates) {
			const { update, preparedFiles } = prepared

			// Update receipt entry - we know it exists because we validated in resolveComponentsToUpdate
			const existingEntry = receipt.installed[update.canonicalId]
			if (!existingEntry) {
				throw new NotFoundError(`Component '${update.canonicalId}' not found in receipt.`)
			}

			// Compute individual file hashes
			const fileHashes: Array<{ path: string; hash: string }> = []
			for (const preparedFile of preparedFiles) {
				fileHashes.push({
					path: preparedFile.resolvedTarget,
					hash: hashContent(preparedFile.content),
				})
			}

			receipt.installed[update.canonicalId] = {
				registryUrl: existingEntry.registryUrl,
				registryName: existingEntry.registryName,
				name: existingEntry.name,
				revision: update.newVersion,
				hash: update.newHash,
				files: fileHashes,
				installedAt: existingEntry.installedAt,
				updatedAt: new Date().toISOString(),
				// Update opencode config if component provides it
				...(update.component.opencode && {
					opencode: update.component.opencode as Record<string, unknown>,
				}),
			}
		}

		// Save receipt file
		await writeReceipt(provider.cwd, receipt)
		if (!appliedWriteTransaction) {
			throw new Error("Internal error: missing applied write transaction after update apply phase.")
		}
		await appliedWriteTransaction.commit()
		appliedWriteTransaction = null

		installSpin?.succeed(`Updated ${updates.length} component(s)`)

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
		if (failurePhase === "apply") {
			if (appliedWriteTransaction) {
				await appliedWriteTransaction.rollback()
				appliedWriteTransaction = null
			}
			installSpin?.fail(resolveUpdateFailureMessage("apply"))
		} else {
			spin?.fail(resolveUpdateFailureMessage("check"))
		}
		throw error
	}
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

async function applyPreparedUpdatesAtomically(
	preparedUpdates: PreparedUpdate[],
	options: { verbose?: boolean; quiet?: boolean; fileOps?: UpdateFileOps },
): Promise<AppliedWriteTransaction> {
	const appliedWrites: AppliedWrite[] = []
	const tempPaths = new Set<string>()
	let finalized = false
	const renameFile = options.fileOps?.rename ?? rename

	const rollback = async (): Promise<void> => {
		if (finalized) {
			return
		}

		finalized = true

		for (const tempPath of tempPaths) {
			try {
				await rm(tempPath, { force: true })
			} catch {
				// best-effort cleanup
			}
		}

		for (const appliedWrite of [...appliedWrites].reverse()) {
			try {
				if (appliedWrite.backupPath) {
					if (existsSync(appliedWrite.targetPath)) {
						await rm(appliedWrite.targetPath, { force: true, recursive: true })
					}
					if (existsSync(appliedWrite.backupPath)) {
						await renameFile(appliedWrite.backupPath, appliedWrite.targetPath)
					}
				} else if (existsSync(appliedWrite.targetPath)) {
					await rm(appliedWrite.targetPath, { force: true, recursive: true })
				}
			} catch {
				// best-effort rollback
			}
		}
	}

	const commit = async (): Promise<void> => {
		if (finalized) {
			return
		}

		finalized = true

		for (const appliedWrite of appliedWrites) {
			if (!appliedWrite.backupPath) {
				continue
			}

			if (existsSync(appliedWrite.backupPath)) {
				try {
					await rm(appliedWrite.backupPath, { force: true })
				} catch (error) {
					if (!options.quiet) {
						const errorMessage = error instanceof Error ? error.message : String(error)
						logger.warn(
							`Post-update cleanup warning: failed to remove backup "${appliedWrite.backupPath}" (${errorMessage})`,
						)
					}
				}
			}
		}
	}

	try {
		for (const prepared of preparedUpdates) {
			for (const preparedFile of prepared.preparedFiles) {
				const targetDir = dirname(preparedFile.targetPath)

				if (!existsSync(targetDir)) {
					await mkdir(targetDir, { recursive: true })
				}

				if (existsSync(preparedFile.targetPath)) {
					const currentTargetStats = await stat(preparedFile.targetPath)
					if (currentTargetStats.isDirectory()) {
						throw new ValidationError(
							`Cannot update "${preparedFile.resolvedTarget}": target path is a directory.`,
						)
					}
				}

				const tempPath = `${preparedFile.targetPath}.ocx-update-tmp-${randomUUID()}`
				await writeFile(tempPath, preparedFile.content)
				tempPaths.add(tempPath)

				let backupPath: string | null = null
				if (existsSync(preparedFile.targetPath)) {
					backupPath = `${preparedFile.targetPath}.ocx-update-backup-${randomUUID()}`
					await renameFile(preparedFile.targetPath, backupPath)
					appliedWrites.push({
						targetPath: preparedFile.targetPath,
						backupPath,
					})
				}

				await renameFile(tempPath, preparedFile.targetPath)
				tempPaths.delete(tempPath)

				if (!backupPath) {
					appliedWrites.push({
						targetPath: preparedFile.targetPath,
						backupPath: null,
					})
				}

				if (options.verbose) {
					logger.info(`  ✓ Updated ${preparedFile.resolvedTarget}`)
				}
			}
		}

		return { commit, rollback }
	} catch (error) {
		await rollback()
		throw error
	}
}

/**
 * Parse and validate a component specifier.
 * Law 2: Parse at boundary, trust internally.
 * Law 4: Fail fast on malformed specifiers before receipt lookup.
 *
 * Rejects trailing `@` (empty version) since update always fetches latest.
 *
 * @example
 * parseComponentSpec("kdco/agents") // { component: "kdco/agents" }
 * parseComponentSpec("kdco/agents@") // throws ConfigError
 */
function parseComponentSpec(spec: string): ComponentSpec {
	if (spec.endsWith("@")) {
		throw new ConfigError(
			`Invalid version specifier '${spec}'. The trailing '@' has no version.\n` +
				`Use '${spec.slice(0, -1)}' to update to the latest version.`,
		)
	}

	return { component: spec }
}

/**
 * Resolve which components to update based on args and flags.
 * Law 4: Fail fast if component not found in receipt.
 */
function resolveComponentsToUpdate(
	receipt: Receipt,
	parsedComponents: ComponentSpec[],
	options: UpdateOptions,
): ComponentSpec[] {
	const installedComponents = Object.keys(receipt.installed)

	// --all: update all installed components (no version override)
	if (options.all) {
		return installedComponents.map((c) => ({ component: c }))
	}

	// --registry: filter by registry alias (no version override)
	if (options.registry) {
		return installedComponents
			.filter((canonicalId) => {
				const entry = receipt.installed[canonicalId]
				return entry?.registryName === options.registry
			})
			.map((c) => ({ component: c }))
	}

	// Specific components: validate they exist
	// User provides qualified names like "alias/component"
	// We need to find the matching canonical ID in the receipt
	const result: ComponentSpec[] = []
	for (const spec of parsedComponents) {
		const name = spec.component
		// Validate format (must be qualified)
		if (!name.includes("/")) {
			const suggestions = installedComponents
				.map((id) => {
					const parsed = parseCanonicalId(id)
					return `${parsed.registryName}/${parsed.name}`
				})
				.filter((qualified) => qualified.endsWith(`/${name}`))
			if (suggestions.length === 1) {
				throw new ValidationError(
					`Ambiguous component '${name}'. Did you mean '${suggestions[0]}'?`,
				)
			}
			if (suggestions.length > 1) {
				throw new ValidationError(
					`Ambiguous component '${name}'. Found in multiple registries:\n` +
						suggestions.map((s) => `  - ${s}`).join("\n") +
						"\n\nPlease use a fully qualified name (alias/component).",
				)
			}
			throw new ValidationError(
				`Component '${name}' must include a registry alias (e.g., 'kdco/${name}').`,
			)
		}

		// Find matching canonical ID
		const { namespace: prefix, component } = parseQualifiedComponent(name)
		const matchingIds = installedComponents.filter((id) => {
			const parsed = parseCanonicalId(id)
			return parsed.registryName === prefix && parsed.name === component
		})

		if (matchingIds.length === 0) {
			throw new NotFoundError(
				`Component '${name}' is not installed.\nRun '${formatAddCommandHint(name, options)}' to install it first.`,
			)
		}

		// Use the first matching canonical ID (there should only be one per alias/name pair)
		const canonicalId = matchingIds[0]
		if (!canonicalId) {
			throw new Error(`Unexpected: matchingIds has length but first element is undefined`)
		}
		result.push({ component: canonicalId })
	}

	return result
}

/**
 * Output dry-run results using shared utility.
 */
function outputUpdateDryRun(results: UpdateResult[], options: UpdateOptions): void {
	const wouldUpdate = results.filter((r) => r.status === "would-update")

	const actions: DryRunAction[] = wouldUpdate.map((result) => ({
		action: "update",
		target: result.qualifiedName,
		details: { from: result.oldVersion, to: result.newVersion },
	}))

	const dryRunResult: DryRunResult = {
		dryRun: true,
		command: "update",
		wouldPerform: actions,
		validation: { passed: true },
		summary:
			wouldUpdate.length > 0
				? `Would update ${wouldUpdate.length} component(s)`
				: "All components are up to date",
	}

	outputDryRun(dryRunResult, { json: options.json, quiet: options.quiet })
}

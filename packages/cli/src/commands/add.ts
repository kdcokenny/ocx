/**
 * OCX CLI - add command
 * Install components from registries
 */

import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { lstat, mkdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

import type { Command } from "commander"
import type { ConfigProvider } from "../config/provider"
import { GlobalConfigProvider, LocalConfigProvider } from "../config/provider"
import { ConfigResolver } from "../config/resolver"
import { CLI_VERSION, GITHUB_REPO } from "../constants"
import { getProfileDir } from "../profile/paths"
import { fetchFileContent, fetchRegistryIndex } from "../registry/fetcher"
import type { ResolvedComponent } from "../registry/resolver"
import { resolveDependencies } from "../registry/resolver"
import {
	createCanonicalId,
	findReceipt,
	type Receipt,
	readReceipt,
	writeReceipt,
} from "../schemas/config"
import type { ComponentFileObject, RegistryIndex } from "../schemas/registry"
import { parseQualifiedComponent } from "../schemas/registry"
import {
	findOpencodeConfig,
	readOpencodeJsonConfig,
	updateOpencodeJsonConfig,
} from "../updaters/update-opencode-config"
import { isContentIdentical } from "../utils/content"
import {
	buildInvalidationDryRunAction,
	computeDependencyDelta,
	type DepUpdateResult,
	invalidateNodeModules,
} from "../utils/dep-invalidation"
import { type DryRunAction, type DryRunResult, outputDryRun } from "../utils/dry-run"
import { ConfigError, ConflictError, IntegrityError, ValidationError } from "../utils/errors"
import { handleError } from "../utils/handle-error"
import { outputJson } from "../utils/json-output"
import { logger } from "../utils/logger"
import {
	extractPackageName,
	fetchPackageVersion,
	formatPluginEntry,
	isNpmSpecifier,
	parseNpmSpecifier,
	validateNpmPackage,
	validateOpenCodePlugin,
} from "../utils/npm-registry"
import { PathValidationError, validatePath } from "../utils/path-security"
import { resolveTargetPath } from "../utils/paths"
import { registerPlannedWriteOrThrow } from "../utils/planned-writes"
import { hashBundle, hashContent } from "../utils/receipt"
import { addCommonOptions, addGlobalOption, addVerboseOption } from "../utils/shared-options"
import { createSpinner } from "../utils/spinner"
import { normalizeRegistryUrl } from "../utils/url"
import { collectCompatIssues, warnCompatIssues } from "../utils/version-compat"

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Find the component that owns a given file path in the receipt.
 * Returns the component's canonical ID or null if not found.
 *
 * @param receipt - The receipt to search
 * @param filePath - The file path to look up (resolved target path)
 * @returns Canonical ID if found, null otherwise
 */
function findOwningComponent(receipt: Receipt | null, filePath: string): string | null {
	// Guard: no receipt or empty installed map
	if (!receipt?.installed) return null

	// Search all installed components for the file
	for (const [canonicalId, entry] of Object.entries(receipt.installed)) {
		if (entry.files?.some((f) => f.path === filePath)) {
			return canonicalId
		}
	}

	return null
}

/**
 * Extract a human-readable component name from a canonical ID.
 * Canonical ID format: "registryUrl::alias/component@revision"
 *
 * @param canonicalId - The canonical ID to parse
 * @returns Component name in "alias/component" format
 */
function extractComponentName(canonicalId: string): string {
	// Parse canonical ID: registryUrl::alias/component@revision
	const afterDelimiter = canonicalId.split("::")[1]
	if (!afterDelimiter) return canonicalId // Fallback to full ID

	// Extract alias/component (before @)
	const beforeVersion = afterDelimiter.split("@")[0]
	return beforeVersion || canonicalId // Fallback to full ID
}

// =============================================================================
// ADD INPUT TYPES (Discriminated Union)
// =============================================================================

/**
 * Parsed add input - discriminated union for type-safe routing.
 * Parsed at the boundary (Law 2: Parse Don't Validate).
 */
export type AddInput =
	| { type: "npm"; name: string; version?: string }
	| { type: "registry"; namespace: string; component: string; version?: string }

/**
 * Parse a component input string into a typed AddInput.
 * Routes between npm: protocol and registry component references.
 *
 * @throws ValidationError for invalid input format
 */
export function parseAddInput(input: string): AddInput {
	// Guard: empty input
	if (!input?.trim()) {
		throw new ValidationError("Component name cannot be empty")
	}

	const trimmed = input.trim()

	// Route npm: specifiers
	if (isNpmSpecifier(trimmed)) {
		const parsed = parseNpmSpecifier(trimmed)
		return { type: "npm", name: parsed.name, version: parsed.version }
	}

	// Route registry components
	// Check if it's a qualified reference (alias/component)
	if (trimmed.includes("/")) {
		const { namespace, component } = parseQualifiedComponent(trimmed)
		return { type: "registry", namespace, component }
	}

	// Bare component name - needs registry resolution
	// For now, treat as registry component without alias
	// The resolver will handle alias inference from config
	return { type: "registry", namespace: "", component: trimmed }
}

export interface AddOptions {
	dryRun?: boolean
	cwd?: string
	quiet?: boolean
	verbose?: boolean
	json?: boolean
	skipCompatCheck?: boolean
	trust?: boolean
	global?: boolean
	profile?: string
	from?: string
}

interface NpmAddResult {
	plugins: string[]
	dryRun: boolean
}

interface RegistryAddResult {
	installed: string[]
	opencode: boolean
	dryRun: boolean
}

interface AppliedAddWrite {
	targetPath: string
	backupPath: string | null
}

interface AddWriteTransaction {
	writeFileAtomically: (params: {
		targetPath: string
		resolvedTarget: string
		content: Buffer
	}) => Promise<void>
	rollback: () => Promise<void>
	commit: () => Promise<void>
}

interface AddManifestSideEffectTransaction {
	rollback: () => Promise<void>
	commit: () => void
}

interface FileSnapshot {
	path: string
	existed: boolean
	content: string
}

export function registerAddCommand(program: Command): void {
	const cmd = program
		.command("add")
		.description(
			"Add components or npm plugins to your project.\n\n" +
				"  Registry components:  ocx add alias/component\n" +
				"  npm plugins:          ocx add npm:package-name[@version]",
		)
		.argument("<components...>", "Components to install (alias/component or npm:package[@version])")
		.option("--dry-run", "Show what would be installed without making changes")
		.option("--skip-compat-check", "Skip version compatibility checks")
		.option("--trust", "Skip npm plugin validation (for packages that don't follow conventions)")
		.option("-p, --profile <name>", "Use specific profile")
		.option("--from <url>", "Use ephemeral registry (does not persist)")

	addCommonOptions(cmd)
	addVerboseOption(cmd)
	addGlobalOption(cmd)

	cmd.action(async (components: string[], options: AddOptions) => {
		try {
			const runtimeOptions = options.json ? { ...options, quiet: true, verbose: false } : options

			// Create appropriate provider based on flags
			let provider: ConfigProvider

			if (runtimeOptions.profile) {
				// Use ConfigResolver with profile - cwd is the profile directory
				const resolver = await ConfigResolver.create(runtimeOptions.cwd ?? process.cwd(), {
					profile: runtimeOptions.profile,
				})
				// Profile mode: install to profile directory, not working directory
				const profileDir = getProfileDir(runtimeOptions.profile)
				provider = {
					cwd: profileDir,
					getRegistries: () => resolver.getRegistries(),
					getComponentPath: () => resolver.getComponentPath(),
				}
			} else if (runtimeOptions.global) {
				provider = await GlobalConfigProvider.requireInitialized()
			} else {
				provider = await LocalConfigProvider.requireInitialized(runtimeOptions.cwd ?? process.cwd())
			}

			await runAddCore(components, runtimeOptions, provider)
		} catch (error) {
			handleError(error, { json: options.json })
		}
	})
}

/**
 * Core add logic that accepts a ConfigProvider.
 * This enables reuse across both standard and profile modes.
 *
 * Routes inputs to appropriate handlers:
 * - npm: specifiers -> handleNpmPlugins
 * - registry components -> existing registry flow
 */
export async function runAddCore(
	componentNames: string[],
	options: AddOptions,
	provider: ConfigProvider,
): Promise<void> {
	const cwd = provider.cwd

	// Parse all inputs at boundary (Law 2: Parse Don't Validate)
	const parsedInputs = componentNames.map(parseAddInput)

	// Separate npm and registry inputs
	const npmInputs = parsedInputs.filter((i): i is AddInput & { type: "npm" } => i.type === "npm")
	const registryInputs = parsedInputs.filter(
		(i): i is AddInput & { type: "registry" } => i.type === "registry",
	)

	const shouldAggregateJson = Boolean(
		options.json && npmInputs.length > 0 && registryInputs.length > 0,
	)
	const executionOptions = shouldAggregateJson
		? { ...options, json: false, quiet: true, verbose: false }
		: options

	let npmResult: NpmAddResult | undefined
	let registryResult: RegistryAddResult | undefined

	// Handle npm plugins first
	if (npmInputs.length > 0) {
		npmResult = await handleNpmPlugins(npmInputs, executionOptions, cwd, !shouldAggregateJson)
	}

	// Handle registry components (existing flow)
	if (registryInputs.length > 0) {
		// Reconstruct component names for registry resolver
		const registryComponentNames = registryInputs.map((i) =>
			i.namespace ? `${i.namespace}/${i.component}` : i.component,
		)
		registryResult = await runRegistryAddCore(
			registryComponentNames,
			executionOptions,
			provider,
			!shouldAggregateJson,
		)
	}

	if (shouldAggregateJson) {
		outputJson({
			success: true,
			plugins: npmResult?.plugins ?? [],
			installed: registryResult?.installed ?? [],
			opencode: registryResult?.opencode ?? false,
			dryRun: Boolean(npmResult?.dryRun || registryResult?.dryRun),
		})
	}
}

/**
 * Handle npm plugin additions.
 * Validates packages exist on npm and updates opencode.json plugin array.
 */
async function handleNpmPlugins(
	inputs: Array<{ type: "npm"; name: string; version?: string }>,
	options: AddOptions,
	cwd: string,
	emitJson = true,
): Promise<NpmAddResult> {
	const spin = options.quiet ? null : createSpinner({ text: "Validating npm packages..." })
	spin?.start()

	try {
		const allWarnings: string[] = []

		// Validate all packages exist on npm registry and are valid OpenCode plugins
		for (const input of inputs) {
			// Always validate package exists
			await validateNpmPackage(input.name)

			// Skip plugin validation if --trust flag is set
			if (!options.trust) {
				try {
					const versionData = await fetchPackageVersion(input.name, input.version)
					const result = validateOpenCodePlugin(versionData)
					allWarnings.push(...result.warnings)
				} catch (error) {
					// Enhance error with hints for ValidationError
					if (error instanceof ValidationError) {
						spin?.fail("Plugin validation failed")
						// Wrap with hints - handleError will log this message
						throw new ValidationError(
							`${error.message}\n` +
								`hint  OpenCode plugins must be ESM modules with an entry point\n` +
								`hint  Use \`--trust\` to add anyway`,
						)
					}
					throw error
				}
			}
		}

		spin?.succeed(`Validated ${inputs.length} npm package(s)`)

		// Show warnings for soft checks
		if (allWarnings.length > 0 && !options.quiet) {
			logger.info("")
			for (const warning of allWarnings) {
				logger.warn(warning)
			}
		}

		// Read existing opencode config
		const existingConfig = await readOpencodeJsonConfig(cwd)
		const existingPlugins: string[] = existingConfig?.config.plugin ?? []

		// Build a map of existing plugin names (without version) for conflict detection
		const existingPluginMap = new Map<string, string>()
		for (const plugin of existingPlugins) {
			const name = extractPackageName(plugin)
			existingPluginMap.set(name, plugin)
		}

		// Check for conflicts and build new plugin list
		const pluginsToAdd: string[] = []
		const conflicts: string[] = []

		for (const input of inputs) {
			const existingEntry = existingPluginMap.get(input.name)

			if (existingEntry) {
				// Conflict: package already exists
				conflicts.push(input.name)
			} else {
				// New package
				pluginsToAdd.push(formatPluginEntry(input.name, input.version))
			}
		}

		// Fail fast on conflicts (Law 4)
		if (conflicts.length > 0) {
			throw new ConflictError(
				`Plugin(s) already exist in opencode.json: ${conflicts.join(", ")}.\n` +
					"Remove the existing entry manually or use 'ocx update' if it's an installed component.",
			)
		}

		// Build final plugin array
		const finalPlugins = [...existingPluginMap.values(), ...pluginsToAdd]

		// Dry run: just log what would happen
		if (options.dryRun) {
			const actions: DryRunAction[] = inputs.map((input) => ({
				action: "add",
				target: formatPluginEntry(input.name, input.version),
				details: { type: "npm plugin" },
			}))

			const dryRunResult: DryRunResult = {
				dryRun: true,
				command: "add",
				wouldPerform: actions,
				validation: { passed: true },
				summary: `Would add ${inputs.length} npm plugin(s)`,
			}

			if (emitJson || !options.json) {
				outputDryRun(dryRunResult, { json: options.json, quiet: options.quiet })
			}
			return {
				plugins: inputs.map((input) => formatPluginEntry(input.name, input.version)),
				dryRun: true,
			}
		}

		// Update opencode.json with new plugins
		await updateOpencodeJsonConfig(cwd, { plugin: finalPlugins })

		if (!options.quiet) {
			logger.info("")
			logger.success(`Added ${inputs.length} npm plugin(s) to opencode.json`)
			for (const input of inputs) {
				logger.info(`  ✓ ${formatPluginEntry(input.name, input.version)}`)
			}
		}

		const addedPlugins = inputs.map((input) => formatPluginEntry(input.name, input.version))

		if (options.json && emitJson) {
			outputJson({
				success: true,
				plugins: addedPlugins,
			})
		}

		return { plugins: addedPlugins, dryRun: false }
	} catch (error) {
		spin?.fail("Failed to add npm plugins")
		throw error
	}
}

/**
 * Registry component add logic (original runAddCore implementation).
 * Handles component installation from configured registries.
 */
async function runRegistryAddCore(
	componentNames: string[],
	options: AddOptions,
	provider: ConfigProvider,
	emitJson = true,
): Promise<RegistryAddResult> {
	const suppressHumanOutput = Boolean(options.quiet || options.json)
	const cwd = provider.cwd
	// V2: Determine if we're in flattened mode (profile/global vs local)
	const isFlattened = !!(options.global || options.profile)
	const registries = provider.getRegistries()

	// V2: Handle --from flag for ephemeral registry
	let effectiveRegistries = registries
	if (options.from) {
		// Validate --from URL
		const fromUrl = options.from.trim()
		if (!fromUrl) {
			throw new ValidationError("--from URL cannot be empty")
		}

		// Parse URL to validate format
		try {
			new URL(fromUrl)
		} catch {
			throw new ValidationError(`Invalid --from URL: ${fromUrl}`)
		}

		// Parse component references to extract prefixes
		const requestedPrefixes = new Set<string>()
		for (const name of componentNames) {
			const { namespace } = parseQualifiedComponent(name)
			requestedPrefixes.add(namespace)
		}

		// Validate all requested components use the same prefix
		if (requestedPrefixes.size > 1) {
			const prefixes = Array.from(requestedPrefixes).join(", ")
			throw new ValidationError(
				`Mixed registry prefixes in --from call: ${prefixes}.\n` +
					`When using --from, all components must use the same prefix.`,
			)
		}

		// Use the single prefix as the ephemeral registry name
		const ephemeralName = Array.from(requestedPrefixes)[0]
		if (!ephemeralName) {
			throw new ValidationError("No valid component references provided")
		}

		// Fetch registry index to validate the URL serves a valid registry (alias-first: ignore its namespace)
		await fetchRegistryIndex(fromUrl)

		// Create ephemeral registry config (does not persist)
		effectiveRegistries = {
			...registries,
			[ephemeralName]: {
				url: fromUrl,
			},
		}
	}

	// V1: Load or create receipt
	let receipt: Receipt = { version: 1, root: cwd, installed: {} }
	const existingReceipt = await readReceipt(cwd)
	if (existingReceipt) {
		receipt = existingReceipt
	}

	const spin = suppressHumanOutput ? null : createSpinner({ text: "Resolving dependencies..." })
	spin?.start()
	let writeTransaction: AddWriteTransaction | null = null
	let manifestSideEffectTransaction: AddManifestSideEffectTransaction | null = null

	try {
		// Pre-validate registry indexes before resolution (fail fast on incompatible formats)
		// This catches legacy/incompatible registries before individual component fetches,
		// providing actionable errors instead of confusing packument parse failures.
		const requestedRegistries = new Set<string>()
		for (const name of componentNames) {
			const { namespace } = parseQualifiedComponent(name)
			requestedRegistries.add(namespace)
		}

		for (const registryAlias of requestedRegistries) {
			const registryConfig = effectiveRegistries[registryAlias]
			if (registryConfig) {
				await fetchRegistryIndex(registryConfig.url)
			}
		}

		// Resolve all dependencies across all configured registries
		const resolved = await resolveDependencies(effectiveRegistries, componentNames)

		if (options.verbose) {
			logger.info("Install order:")
			for (const name of resolved.installOrder) {
				logger.info(`  - ${name}`)
			}
		}

		// Fetch registry indexes once (Law 2: Parse at boundary)
		const registryIndexes = new Map<string, RegistryIndex>()
		const uniqueBaseUrls = new Map<string, string>() // alias -> baseUrl

		for (const component of resolved.components) {
			if (!uniqueBaseUrls.has(component.registryName)) {
				uniqueBaseUrls.set(component.registryName, component.baseUrl)
			}
		}

		for (const [namespace, baseUrl] of uniqueBaseUrls) {
			const index = await fetchRegistryIndex(baseUrl)
			registryIndexes.set(namespace, index)
		}

		spin?.succeed(
			`Resolved ${resolved.components.length} components from ${registryIndexes.size} registries`,
		)

		// Version compatibility check (skip if disabled via flag)
		const skipCompat = options.skipCompatCheck
		if (!skipCompat && !suppressHumanOutput) {
			for (const [namespace, index] of registryIndexes) {
				const issues = collectCompatIssues({
					registry: { opencode: index.opencode, ocx: index.ocx },
					ocxVersion: CLI_VERSION,
				})
				warnCompatIssues(namespace, issues)
			}
		}

		if (options.dryRun) {
			const actions: DryRunAction[] = resolved.components.map((component) => ({
				action: "add",
				target: `${component.registryName}/${component.name}`,
				details: { type: component.type },
			}))

			// Add planned invalidation action if npm deps would change.
			// NOTE: This may over-report in the edge case where the declared deps
			// already match the existing package.json (no actual delta). This is
			// acceptable for dry-run — it signals intent rather than guaranteeing
			// change, and the real path uses computeDependencyDelta for precision.
			if (resolved.npmDependencies.length > 0 || resolved.npmDevDependencies.length > 0) {
				const packageDir = options.global || options.profile ? cwd : join(cwd, ".opencode")
				const depNames = [...resolved.npmDependencies, ...resolved.npmDevDependencies]
				const dryDeltaEntries = depNames.map((spec) => {
					const lastAt = spec.lastIndexOf("@")
					const name = lastAt > 0 ? spec.slice(0, lastAt) : spec
					const version = lastAt > 0 ? spec.slice(lastAt + 1) : "*"
					return { name, from: null as string | null, to: version }
				})
				actions.push(buildInvalidationDryRunAction(packageDir, dryDeltaEntries))
			}

			const dryRunResult: DryRunResult = {
				dryRun: true,
				command: "add",
				wouldPerform: actions,
				validation: { passed: true },
				summary: `Would add ${resolved.components.length} component(s)`,
			}

			if (emitJson || !options.json) {
				outputDryRun(dryRunResult, { json: options.json, quiet: options.quiet })
			}
			return {
				installed: resolved.installOrder,
				opencode: Boolean(resolved.opencode),
				dryRun: true,
			}
		}

		// Phase 1: Fetch all files and perform pre-flight checks (Law 4: Fail Fast)
		// We check ALL conflicts BEFORE writing ANY files to ensure atomic behavior
		const fetchSpin = suppressHumanOutput ? null : createSpinner({ text: "Fetching components..." })
		fetchSpin?.start()

		const componentBundles: {
			component: ResolvedComponent
			files: { path: string; content: Buffer }[]
			computedHash: string
			canonicalId: string
		}[] = []

		for (const component of resolved.components) {
			// Fetch component files and compute bundle hash
			const files: { path: string; content: Buffer }[] = []
			for (const file of component.files) {
				const content = await fetchFileContent(component.baseUrl, component.name, file.path)
				files.push({ path: file.path, content: Buffer.from(content) })
			}

			const computedHash = await hashBundle(files)

			// Layer 2 path safety: Verify all target paths are inside cwd (runtime containment)
			for (const file of component.files) {
				// V2: Resolve target path based on mode (flattened vs local)
				const resolvedTarget = resolveTargetPath(file.target, isFlattened, cwd)
				const targetPath = join(cwd, resolvedTarget)
				try {
					validatePath(cwd, resolvedTarget)
				} catch (error) {
					if (error instanceof PathValidationError) {
						throw new ValidationError(`Invalid path "${targetPath}": ${error.message}`)
					}
					throw error
				}
			}

			// V2: Check if already installed with canonical ID (use hash as revision)
			// Integrity check: Look for ANY existing entry for this component (any revision)
			// If found with different hash, fail - registry content changed unexpectedly
			const existingEntries = Object.entries(receipt.installed).filter(
				([_id, entry]) =>
					normalizeRegistryUrl(entry.registryUrl) === normalizeRegistryUrl(component.baseUrl) &&
					entry.registryName === component.registryName &&
					entry.name === component.name,
			)

			if (existingEntries.length > 0) {
				const existingPair = existingEntries[0]
				if (existingPair) {
					const [existingId, existingEntry] = existingPair
					if (existingEntry.hash !== computedHash) {
						fetchSpin?.fail("Integrity check failed")
						throw new IntegrityError(existingId, existingEntry.hash, computedHash)
					}
					// Hash matches - component already installed, will be skipped later
				}
			}

			// V2: Create canonical ID with hash-based revision
			const canonicalId = createCanonicalId(
				component.baseUrl,
				component.registryName,
				component.name,
				`sha256:${computedHash}`,
			)

			componentBundles.push({ component, files, computedHash, canonicalId })
		}

		fetchSpin?.succeed(`Fetched ${resolved.components.length} components`)

		// Phase 2: Pre-flight conflict detection (check ALL files before writing ANY)
		// This ensures atomic behavior: either all files install or none do
		const plannedWrites = new Map<
			string,
			{
				absolutePath: string
				relativePath: string
				content: Buffer
				source: string
			}
		>()

		for (const { component, files } of componentBundles) {
			for (const file of files) {
				const componentFile = component.files.find((f: ComponentFileObject) => f.path === file.path)
				if (!componentFile) continue

				const resolvedTarget = resolveTargetPath(componentFile.target, isFlattened, cwd)
				const targetPath = join(cwd, resolvedTarget)

				registerPlannedWriteOrThrow(plannedWrites, {
					absolutePath: targetPath,
					relativePath: resolvedTarget,
					content: file.content,
					source: `${component.registryName}/${component.name}:${componentFile.path}`,
				})
			}
		}

		const allConflicts: Array<{ path: string; owningComponent: string | null }> = []

		for (const plannedWrite of plannedWrites.values()) {
			if (!existsSync(plannedWrite.absolutePath)) {
				continue
			}

			const existingContent = await Bun.file(plannedWrite.absolutePath).text()
			const incomingContent = plannedWrite.content.toString("utf-8")

			if (!isContentIdentical(existingContent, incomingContent)) {
				// Find which component owns this file (if any)
				const owningComponent = findOwningComponent(receipt, plannedWrite.relativePath)
				allConflicts.push({ path: plannedWrite.relativePath, owningComponent })
			}
		}

		// Fail fast on conflicts BEFORE any writes (Law 4)
		if (allConflicts.length > 0) {
			// Group conflicts by ownership
			const ownedConflicts = allConflicts.filter((c) => c.owningComponent !== null)
			const unownedConflicts = allConflicts.filter((c) => c.owningComponent === null)

			if (!suppressHumanOutput) {
				logger.error("")
				logger.error("File conflicts detected:")

				// Show owned conflicts with update suggestions
				if (ownedConflicts.length > 0) {
					logger.error("")
					logger.error("Files from installed components (use 'ocx update' or 'ocx remove'):")
					for (const conflict of ownedConflicts) {
						// owningComponent is guaranteed non-null in ownedConflicts
						if (conflict.owningComponent) {
							const componentName = extractComponentName(conflict.owningComponent)
							logger.error(`  ✗ ${conflict.path} (from ${componentName})`)
						}
					}
				}

				// Show unowned conflicts with manual resolution hint
				if (unownedConflicts.length > 0) {
					logger.error("")
					logger.error("Files not managed by OCX (resolve manually):")
					for (const conflict of unownedConflicts) {
						logger.error(`  ✗ ${conflict.path}`)
					}
				}

				logger.error("")
			}

			// Build context-aware error message
			let errorMessage = `${allConflicts.length} file(s) have conflicts.\n`

			if (ownedConflicts.length > 0) {
				// Extract unique component names
				const uniqueComponents = new Set(
					ownedConflicts
						.filter((c) => c.owningComponent !== null)
						.map((c) => extractComponentName(c.owningComponent as string)),
				)
				errorMessage += `For OCX-managed files, use 'ocx update ${Array.from(uniqueComponents).join(" ")}' or 'ocx remove ${Array.from(uniqueComponents).join(" ")}'.\n`
			}

			if (unownedConflicts.length > 0) {
				errorMessage +=
					"For unmanaged files, resolve conflicts manually by renaming or removing them."
			}

			throw new ConflictError(errorMessage.trim())
		}

		// Phase 3: Install all components (no conflicts possible at this point)
		const installSpin = suppressHumanOutput
			? null
			: createSpinner({ text: "Installing components..." })
		installSpin?.start()
		manifestSideEffectTransaction = await createAddManifestSideEffectTransaction({
			cwd,
			isFlattened,
			trackOpencodeConfig: Boolean(resolved.opencode && Object.keys(resolved.opencode).length > 0),
			trackNpmManifests:
				resolved.npmDependencies.length > 0 || resolved.npmDevDependencies.length > 0,
			quiet: options.quiet,
		})
		const installWriteTransaction = createAddWriteTransaction({ quiet: options.quiet })
		writeTransaction = installWriteTransaction

		for (const { component, files, computedHash, canonicalId } of componentBundles) {
			// Install component
			const installResult = await installComponent(
				component,
				files,
				cwd,
				isFlattened,
				installWriteTransaction,
				{
					verbose: options.verbose,
				},
			)

			// Log results in verbose mode
			if (options.verbose) {
				for (const f of installResult.skipped) {
					logger.info(`  ○ Skipped ${f} (unchanged)`)
				}
				for (const f of installResult.overwritten) {
					logger.info(`  ✓ Overwrote ${f}`)
				}
				for (const f of installResult.written) {
					logger.info(`  ✓ Wrote ${f}`)
				}
			}

			// Use cached registry index
			const index = registryIndexes.get(component.registryName)
			if (!index) {
				throw new ValidationError(
					`Registry index not found for "${component.registryName}". ` +
						`This is an internal error - please report it at https://github.com/${GITHUB_REPO}/issues`,
				)
			}

			// Compute individual file hashes (store resolved paths in receipt)
			const fileHashes: Array<{ path: string; hash: string }> = []
			for (const file of files) {
				const componentFile = component.files.find((f: ComponentFileObject) => f.path === file.path)
				if (!componentFile) throw new Error(`File ${file.path} not found in component manifest`)
				const resolvedTarget = resolveTargetPath(componentFile.target, isFlattened, cwd)
				fileHashes.push({
					path: resolvedTarget, // Resolved path (with .opencode/ prefix if local mode)
					hash: hashContent(file.content),
				})
			}

			receipt.installed[canonicalId] = {
				registryUrl: component.baseUrl,
				registryName: component.registryName,
				name: component.name,
				revision: `sha256:${computedHash}`,
				hash: computedHash,
				files: fileHashes,
				installedAt: new Date().toISOString(),
				// Store component's opencode config for runtime instruction path resolution
				...(component.opencode && { opencode: component.opencode as Record<string, unknown> }),
			}
		}

		installSpin?.succeed(`Installed ${resolved.components.length} components`)

		// Apply opencode.json changes (ShadCN-style: component wins, user uses git)
		if (resolved.opencode && Object.keys(resolved.opencode).length > 0) {
			const result = await updateOpencodeJsonConfig(cwd, resolved.opencode)

			if (!options.quiet && result.changed) {
				if (result.created) {
					logger.info(`Created ${result.path}`)
				} else {
					logger.info(`Updated ${result.path}`)
				}
			}
		}

		// Update package.json with npm dependencies
		// Global or profile mode: writes to cwd/package.json
		// Local mode: writes to .opencode/package.json
		const hasNpmDeps = resolved.npmDependencies.length > 0
		const hasNpmDevDeps = resolved.npmDevDependencies.length > 0
		const packageJsonPath =
			options.global || options.profile
				? join(cwd, "package.json")
				: join(cwd, ".opencode/package.json")

		if (hasNpmDeps || hasNpmDevDeps) {
			const npmSpin = suppressHumanOutput
				? null
				: createSpinner({ text: `Updating ${packageJsonPath}...` })
			npmSpin?.start()

			try {
				// V2: Pass isFlattened based on mode (profile/global vs local)
				const isFlattened = !!(options.global || options.profile)
				const depResult = await updateOpencodePackageDeps(
					cwd,
					resolved.npmDependencies,
					resolved.npmDevDependencies,
					{ isFlattened },
				)
				const totalDeps = resolved.npmDependencies.length + resolved.npmDevDependencies.length
				npmSpin?.succeed(`Added ${totalDeps} dependencies to ${packageJsonPath}`)

				// Invalidate node_modules if dependencies changed to force reinstall
				if (depResult.changed) {
					const invResult = await invalidateNodeModules(depResult.packageDir)
					if (invResult.success && invResult.action !== "none") {
						if (!suppressHumanOutput) {
							logger.info(
								`Invalidated ${join(depResult.packageDir, "node_modules")} to force reinstall`,
							)
						}
					} else if (!invResult.success) {
						// Warn but do not fail the command (Law 5: intentional naming for remediation)
						const nodeModulesPath = join(depResult.packageDir, "node_modules")
						logger.warn(
							`Could not invalidate ${nodeModulesPath}: ${invResult.error?.message ?? "unknown error"}. ` +
								`Run \`rm -rf "${nodeModulesPath}"\` manually to force reinstall.`,
						)
					}
				}
			} catch (error) {
				npmSpin?.fail(`Failed to update ${packageJsonPath}`)
				throw error
			}
		}

		// V1: Save receipt file
		await writeReceipt(cwd, receipt)
		if (!writeTransaction) {
			throw new Error("Internal error: missing add write transaction after install phase.")
		}
		await writeTransaction.commit()
		writeTransaction = null
		manifestSideEffectTransaction?.commit()
		manifestSideEffectTransaction = null

		if (options.json && emitJson) {
			outputJson({
				success: true,
				installed: resolved.installOrder,
				opencode: !!resolved.opencode,
			})
		} else if (!options.quiet) {
			logger.info("")
			logger.success(`Done! Installed ${resolved.components.length} components.`)
		}

		return {
			installed: resolved.installOrder,
			opencode: !!resolved.opencode,
			dryRun: false,
		}
	} catch (error) {
		if (writeTransaction) {
			await writeTransaction.rollback()
			writeTransaction = null
		}
		if (manifestSideEffectTransaction) {
			await manifestSideEffectTransaction.rollback()
			manifestSideEffectTransaction = null
		}

		// Only fail the resolve spinner if it's still running (error during resolution)
		// Other spinners handle their own failures
		if (spin && !spin.isSpinning) {
			// Spinner already stopped - error happened after resolution
		} else {
			spin?.fail("Failed to add components")
		}
		throw error
	}
}

/**
 * Build a consistent warning message for rollback cleanup failures.
 */
function formatRollbackCleanupWarning(action: string, targetPath: string, error: unknown): string {
	const errorMessage = error instanceof Error ? error.message : String(error)
	return `${action} "${targetPath}" (${errorMessage})`
}

/**
 * Returns true when candidate path is inside boundary directory.
 */
function isWithinBoundary(candidatePath: string, boundaryPath: string): boolean {
	const rel = relative(boundaryPath, candidatePath)
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

/**
 * Remove empty parent directories up to (but not including) boundary.
 */
async function removeEmptyParentDirectories(startDir: string, boundaryDir: string): Promise<void> {
	let currentDir = resolve(startDir)
	const boundary = resolve(boundaryDir)

	while (isWithinBoundary(currentDir, boundary)) {
		let currentEntryExists = true
		try {
			const currentEntryStats = await lstat(currentDir)
			if (!currentEntryStats.isDirectory()) {
				// Never remove non-directory paths during cleanup.
				break
			}
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code
			if (code === "ENOENT") {
				currentEntryExists = false
			} else {
				throw error
			}
		}

		try {
			if (currentEntryExists) {
				await rm(currentDir, { recursive: false })
			}
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code
			if (code === "ENOENT") {
				// Already gone; continue walking upward.
			} else if (code === "ENOTEMPTY" || code === "EEXIST" || code === "EBUSY") {
				// Stop at first non-empty/in-use directory.
				break
			} else if (code === "ENOTDIR") {
				// Path changed to non-directory between lstat and rm.
				break
			} else {
				throw error
			}
		}

		const parentDir = dirname(currentDir)
		if (parentDir === currentDir) {
			break
		}
		currentDir = parentDir
	}
}

/**
 * Capture the current state of a file path for rollback.
 */
async function captureFileSnapshot(filePath: string): Promise<FileSnapshot> {
	if (!existsSync(filePath)) {
		return {
			path: filePath,
			existed: false,
			content: "",
		}
	}

	return {
		path: filePath,
		existed: true,
		content: await Bun.file(filePath).text(),
	}
}

/**
 * Restore a file path to its captured state.
 */
async function restoreFileSnapshot(snapshot: FileSnapshot, cwd: string): Promise<void> {
	if (snapshot.existed) {
		await mkdir(dirname(snapshot.path), { recursive: true })
		await Bun.write(snapshot.path, snapshot.content)
		return
	}

	if (existsSync(snapshot.path)) {
		await rm(snapshot.path, { force: true, recursive: true })
	}

	await removeEmptyParentDirectories(dirname(snapshot.path), cwd)
}

/**
 * Snapshot manifest-side effect files so add can roll back atomically on failure.
 */
async function createAddManifestSideEffectTransaction(options: {
	cwd: string
	isFlattened: boolean
	trackOpencodeConfig: boolean
	trackNpmManifests: boolean
	quiet?: boolean
}): Promise<AddManifestSideEffectTransaction> {
	const snapshots: FileSnapshot[] = []
	const trackedPaths = new Set<string>()
	let finalized = false

	const trackPath = async (filePath: string): Promise<void> => {
		if (trackedPaths.has(filePath)) {
			return
		}
		trackedPaths.add(filePath)
		snapshots.push(await captureFileSnapshot(filePath))
	}

	if (options.trackOpencodeConfig) {
		const opencodeConfigPath = findOpencodeConfig(options.cwd).path
		await trackPath(opencodeConfigPath)
	}

	if (options.trackNpmManifests) {
		const packageDir = options.isFlattened ? options.cwd : join(options.cwd, ".opencode")
		await trackPath(join(packageDir, "package.json"))
		if (!options.isFlattened) {
			await trackPath(join(packageDir, ".gitignore"))
		}
	}

	await trackPath(findReceipt(options.cwd).path)

	const rollback = async (): Promise<void> => {
		if (finalized) {
			return
		}

		finalized = true
		const rollbackWarnings: string[] = []

		for (const snapshot of [...snapshots].reverse()) {
			try {
				await restoreFileSnapshot(snapshot, options.cwd)
			} catch (error) {
				rollbackWarnings.push(
					formatRollbackCleanupWarning(
						"Add rollback cleanup warning: failed to restore",
						snapshot.path,
						error,
					),
				)
			}
		}

		if (!options.quiet) {
			for (const warning of rollbackWarnings) {
				logger.warn(warning)
			}
		}
	}

	const commit = (): void => {
		finalized = true
	}

	return { rollback, commit }
}

/**
 * Creates an atomic write transaction for add installs.
 * Files are swapped via temp+rename and can be rolled back on failure.
 */
function createAddWriteTransaction(options: { quiet?: boolean }): AddWriteTransaction {
	const appliedWrites: AppliedAddWrite[] = []
	const tempPaths = new Set<string>()
	let finalized = false

	const rollback = async (): Promise<void> => {
		if (finalized) {
			return
		}

		finalized = true
		const rollbackWarnings: string[] = []

		for (const tempPath of tempPaths) {
			try {
				await rm(tempPath, { force: true })
			} catch (error) {
				rollbackWarnings.push(
					formatRollbackCleanupWarning(
						"Add rollback cleanup warning: failed to remove temp file",
						tempPath,
						error,
					),
				)
			}
		}

		for (const appliedWrite of [...appliedWrites].reverse()) {
			try {
				if (appliedWrite.backupPath) {
					if (existsSync(appliedWrite.targetPath)) {
						await rm(appliedWrite.targetPath, { force: true, recursive: true })
					}
					if (existsSync(appliedWrite.backupPath)) {
						await rename(appliedWrite.backupPath, appliedWrite.targetPath)
					}
				} else if (existsSync(appliedWrite.targetPath)) {
					await rm(appliedWrite.targetPath, { force: true, recursive: true })
				}
			} catch (error) {
				rollbackWarnings.push(
					formatRollbackCleanupWarning(
						"Add rollback cleanup warning: failed to restore target",
						appliedWrite.targetPath,
						error,
					),
				)
			}
		}

		if (!options.quiet) {
			for (const warning of rollbackWarnings) {
				logger.warn(warning)
			}
		}
	}

	const commit = async (): Promise<void> => {
		if (finalized) {
			return
		}

		finalized = true

		for (const appliedWrite of appliedWrites) {
			if (!appliedWrite.backupPath || !existsSync(appliedWrite.backupPath)) {
				continue
			}

			try {
				await rm(appliedWrite.backupPath, { force: true })
			} catch (error) {
				if (!options.quiet) {
					const errorMessage = error instanceof Error ? error.message : String(error)
					logger.warn(
						`Post-add cleanup warning: failed to remove backup "${appliedWrite.backupPath}" (${errorMessage})`,
					)
				}
			}
		}
	}

	const writeFileAtomically: AddWriteTransaction["writeFileAtomically"] = async ({
		targetPath,
		resolvedTarget,
		content,
	}) => {
		const targetDir = dirname(targetPath)
		if (!existsSync(targetDir)) {
			await mkdir(targetDir, { recursive: true })
		}

		if (existsSync(targetPath)) {
			const targetStats = await stat(targetPath)
			if (targetStats.isDirectory()) {
				throw new ValidationError(`Cannot install "${resolvedTarget}": target path is a directory.`)
			}
		}

		const tempPath = `${targetPath}.ocx-add-tmp-${randomUUID()}`
		await writeFile(tempPath, content)
		tempPaths.add(tempPath)

		let backupPath: string | null = null
		if (existsSync(targetPath)) {
			backupPath = `${targetPath}.ocx-add-backup-${randomUUID()}`
			await rename(targetPath, backupPath)
			appliedWrites.push({ targetPath, backupPath })
		}

		await rename(tempPath, targetPath)
		tempPaths.delete(tempPath)

		if (!backupPath) {
			appliedWrites.push({ targetPath, backupPath: null })
		}
	}

	return {
		writeFileAtomically,
		rollback,
		commit,
	}
}

/**
 * Writes component files to disk.
 * Pre-flight conflict detection happens before this function is called,
 * so we can safely write all files without additional conflict checks.
 */
async function installComponent(
	component: ResolvedComponent,
	files: { path: string; content: Buffer }[],
	cwd: string,
	isFlattened: boolean,
	writeTransaction: AddWriteTransaction,
	_options: { verbose?: boolean },
): Promise<{ written: string[]; skipped: string[]; overwritten: string[] }> {
	const result = {
		written: [] as string[],
		skipped: [] as string[],
		overwritten: [] as string[],
	}

	for (const file of files) {
		const componentFile = component.files.find((f: ComponentFileObject) => f.path === file.path)
		if (!componentFile) continue

		// V2: Resolve target path based on mode (flattened vs local)
		const resolvedTarget = resolveTargetPath(componentFile.target, isFlattened, cwd)
		const targetPath = join(cwd, resolvedTarget)
		// Check if file exists
		if (existsSync(targetPath)) {
			// Read existing content and compare
			const existingContent = await Bun.file(targetPath).text()
			const incomingContent = file.content.toString("utf-8")

			if (isContentIdentical(existingContent, incomingContent)) {
				// Content is identical - skip silently
				result.skipped.push(resolvedTarget)
				continue
			}

			// Content differs - overwrite (conflicts already checked in pre-flight)
			result.overwritten.push(resolvedTarget)
		} else {
			result.written.push(resolvedTarget)
		}

		await writeTransaction.writeFileAtomically({
			targetPath,
			resolvedTarget,
			content: file.content,
		})
	}

	return result
}

// ============================================================================
// NPM Dependency Management
// ============================================================================

interface NpmDependency {
	name: string
	version: string
}

interface OpencodePackageJson {
	name?: string
	private?: boolean
	type?: string
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
}

const DEFAULT_PACKAGE_JSON: OpencodePackageJson = {
	name: "opencode-plugins",
	private: true,
	type: "module",
}

/**
 * Parses an npm dependency spec into name and version.
 * Handles: "lodash", "lodash@4.0.0", "@types/node", "@types/node@1.0.0"
 */
function parseNpmDependency(spec: string): NpmDependency {
	// Guard: invalid input
	if (!spec?.trim()) {
		throw new ValidationError(`Invalid npm dependency: expected non-empty string, got "${spec}"`)
	}

	const trimmed = spec.trim()
	const lastAt = trimmed.lastIndexOf("@")

	// Has version: "lodash@4.0.0" or "@types/node@1.0.0"
	if (lastAt > 0) {
		const name = trimmed.slice(0, lastAt)
		const version = trimmed.slice(lastAt + 1)
		if (!version) {
			throw new ValidationError(`Invalid npm dependency: missing version after @ in "${spec}"`)
		}
		return { name, version }
	}

	// No version: "lodash" or "@types/node" → use "*"
	return { name: trimmed, version: "*" }
}

/**
 * Merges new dependencies into the dependencies field.
 * Pure function: same inputs always produce same output.
 */
function mergeProdDependencies(
	existing: OpencodePackageJson,
	newDeps: NpmDependency[],
): OpencodePackageJson {
	const merged: Record<string, string> = { ...existing.dependencies }
	for (const dep of newDeps) {
		merged[dep.name] = dep.version
	}
	return { ...existing, dependencies: merged }
}

/**
 * Merges new devDependencies into the devDependencies field.
 * Pure function: same inputs always produce same output.
 */
function mergeDevDependencies(
	existing: OpencodePackageJson,
	newDeps: NpmDependency[],
): OpencodePackageJson {
	const merged: Record<string, string> = { ...existing.devDependencies }
	for (const dep of newDeps) {
		merged[dep.name] = dep.version
	}
	return { ...existing, devDependencies: merged }
}

/**
 * Reads package.json from the given directory, or returns default structure if missing.
 */
async function readOpencodePackageJson(opencodeDir: string): Promise<OpencodePackageJson> {
	const pkgPath = join(opencodeDir, "package.json")

	// Guard: file doesn't exist - return default
	if (!existsSync(pkgPath)) {
		return { ...DEFAULT_PACKAGE_JSON }
	}

	// Try to parse, fail fast on invalid JSON
	try {
		const content = await Bun.file(pkgPath).text()
		return JSON.parse(content) as OpencodePackageJson
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e)
		throw new ConfigError(`Invalid ${pkgPath}: ${message}`)
	}
}

/**
 * Modifies .opencode/.gitignore to ensure package.json and bun.lock are tracked.
 * Creates the file with sensible defaults if missing.
 */
async function ensureManifestFilesAreTracked(opencodeDir: string): Promise<void> {
	const gitignorePath = join(opencodeDir, ".gitignore")
	const filesToTrack = new Set(["package.json", "bun.lock"])
	const requiredIgnores = ["node_modules"]

	// Read existing lines or start fresh
	let lines: string[] = []
	if (existsSync(gitignorePath)) {
		const content = await Bun.file(gitignorePath).text()
		lines = content
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)
	}

	// Remove entries that should be tracked (not ignored)
	lines = lines.filter((line) => !filesToTrack.has(line))

	// Ensure required ignores are present
	for (const ignore of requiredIgnores) {
		if (!lines.includes(ignore)) {
			lines.push(ignore)
		}
	}

	await Bun.write(gitignorePath, `${lines.join("\n")}\n`)
}

/**
 * Updates package.json with new dependencies.
 * For local mode: writes to .opencode/package.json and ensures git tracking.
 * For flattened mode (global or profile): writes directly to cwd/package.json.
 *
 * Returns metadata about what changed for downstream invalidation logic.
 *
 * @throws ConflictError if same package appears in both prod and dev deps
 */
async function updateOpencodePackageDeps(
	cwd: string,
	npmDeps: string[],
	npmDevDeps: string[],
	options: { isFlattened?: boolean } = {},
): Promise<DepUpdateResult> {
	// Flattened mode: write directly to cwd, no .opencode prefix
	// Local mode: write to .opencode subdirectory
	const packageDir = options.isFlattened ? cwd : join(cwd, ".opencode")

	// Guard: no deps to process
	if (npmDeps.length === 0 && npmDevDeps.length === 0) {
		return { changed: false, packageDir, delta: [] }
	}

	// Ensure directory exists
	await mkdir(packageDir, { recursive: true })

	// Parse all deps - fails fast on invalid (Law 4)
	const prodDeps = npmDeps.map(parseNpmDependency)
	const devDeps = npmDevDeps.map(parseNpmDependency)

	// Law 4 (Fail Loud): Check for conflicts - same package in both lists
	const prodNames = new Set(prodDeps.map((d) => d.name))
	const conflicts = devDeps.filter((d) => prodNames.has(d.name))
	if (conflicts.length > 0) {
		throw new ConflictError(
			`Package(s) appear in both dependencies and devDependencies: ${conflicts.map((c) => c.name).join(", ")}.\n` +
				"A package cannot be in both fields. Remove from one list manually before adding.",
		)
	}

	// Read → merge → write
	const existing = await readOpencodePackageJson(packageDir)
	const beforeDeps = { ...existing.dependencies, ...existing.devDependencies }

	let updated = existing
	updated = mergeProdDependencies(updated, prodDeps)
	updated = mergeDevDependencies(updated, devDeps)
	await Bun.write(join(packageDir, "package.json"), `${JSON.stringify(updated, null, 2)}\n`)

	const afterDeps = { ...updated.dependencies, ...updated.devDependencies }
	const delta = computeDependencyDelta(beforeDeps, afterDeps)

	// Ensure manifest files are tracked by git (only for local mode)
	if (!options.isFlattened) {
		await ensureManifestFilesAreTracked(packageDir)
	}

	return {
		changed: delta.changed,
		packageDir,
		delta: delta.entries,
	}
}

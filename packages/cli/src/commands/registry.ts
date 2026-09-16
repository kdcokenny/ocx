import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import type { Command } from "commander"
import { resolveMetadata, withMetadataLock } from "../config/scope"
import { atomicWrite } from "../profile/atomic"
import type { RegistryConfig } from "../schemas/config"
import { aliasSchema } from "../schemas/registry"
import { type DryRunResult, outputDryRun } from "../utils/dry-run"
import { RegistryExistsError, ValidationError } from "../utils/errors"
import { handleError } from "../utils/handle-error"
import { outputJson } from "../utils/json-output"
import { normalizeRegistryUrl } from "../utils/url"

export interface RegistryOptions {
	cwd: string
	json?: boolean
	quiet?: boolean
	global?: boolean
	profile?: string
	project?: boolean
}

export interface RegistryAddOptions extends RegistryOptions {
	name: string // Always present — enforced by Commander .requiredOption()
	dryRun?: boolean
}

// =============================================================================
// CORE FUNCTIONS (used by both standard and profile commands)
// =============================================================================

/**
 * Core logic for adding a registry.
 * @param url Registry URL
 * @param options Options including optional name, version
 * @param callbacks Callbacks for reading/writing config
 */
export async function runRegistryAddCore(
	url: string,
	options: RegistryAddOptions,
	callbacks: {
		getRegistries: () => Record<string, RegistryConfig>
		isLocked?: () => boolean
		setRegistry: (name: string, config: RegistryConfig) => Promise<void>
		targetLabel?: string // For dry-run summary
	},
): Promise<
	{ name: string; url: string; updated: boolean; alreadyConfigured: boolean } | DryRunResult
> {
	// Guard: Check registries aren't locked
	if (callbacks.isLocked?.()) {
		throw new Error("Registries are locked. Cannot add.")
	}

	// Validate and parse URL
	const trimmedUrl = url.trim()
	if (!trimmedUrl) {
		throw new ValidationError("Registry URL is required")
	}
	try {
		const parsed = new URL(trimmedUrl)
		if (!["http:", "https:", "file:"].includes(parsed.protocol)) {
			throw new ValidationError(
				`Invalid registry URL: ${trimmedUrl} (must use http, https, or file)`,
			)
		}
	} catch (error) {
		if (error instanceof ValidationError) throw error
		throw new ValidationError(`Invalid registry URL: ${trimmedUrl}`)
	}

	const normalizedUrl = normalizeRegistryUrl(trimmedUrl)

	const name = aliasSchema.parse(options.name)
	const registries = callbacks.getRegistries()
	const existingByName = registries[name]

	// URL uniqueness check: find any existing registry with the same normalized URL
	const existingByUrl = findRegistryByUrl(registries, normalizedUrl)

	// Fetch registry index to validate the URL serves a valid registry
	const { fetchRegistryIndex } = await import("../registry/fetcher")
	await fetchRegistryIndex(normalizedUrl, existingByUrl?.config)

	// -------------------------------------------------------------------------
	// Conflict resolution matrix (alias-first model)
	// Rule 1: New name + new URL => add
	// Rule 2: Same name + same URL => idempotent no-op
	// Rule 3: Same name + different URL => fail (name conflict)
	// Rule 4: Different name + same URL => fail (URL conflict)
	// -------------------------------------------------------------------------

	const nameExists = existingByName !== undefined
	const urlExists = existingByUrl !== null
	const sameUrl = nameExists && normalizeRegistryUrl(existingByName.url) === normalizedUrl
	const urlOwnedByDifferentName = urlExists && existingByUrl.name !== name

	// Dry-run mode: report what would happen
	if (options.dryRun) {
		const warnings: string[] = []

		if (nameExists && !sameUrl) {
			warnings.push(
				`Registry '${name}' already exists with a different URL (${existingByName.url}). ` +
					`Run 'ocx registry remove ${name}' first, then re-add.`,
			)
		} else if (urlOwnedByDifferentName) {
			warnings.push(
				`URL '${normalizedUrl}' is already registered under name '${existingByUrl.name}'. ` +
					`Run 'ocx registry remove ${existingByUrl.name}' first, then re-add.`,
			)
		}

		const isConflict = (nameExists && !sameUrl) || urlOwnedByDifferentName
		const isIdempotent = nameExists && sameUrl
		const targetLabel = callbacks.targetLabel || "config"

		const dryRunResult: DryRunResult = {
			dryRun: true,
			command: "registry add",
			wouldPerform: isIdempotent
				? []
				: [
						{
							action: "add",
							target: `registry:${name}`,
							details: {
								url: normalizedUrl,
							},
						},
					],
			validation: {
				passed: !isConflict,
				warnings: warnings.length > 0 ? warnings : undefined,
			},
			summary: isConflict
				? `Would fail: conflict detected for registry '${name}'`
				: isIdempotent
					? `Registry '${name}' already configured with same URL (no-op)`
					: `Would add registry '${name}' to ${targetLabel}`,
		}

		return dryRunResult
	}

	// Rule 3: Same name + different URL => fail
	if (nameExists && !sameUrl) {
		throw new RegistryExistsError(name, existingByName.url, normalizedUrl, callbacks.targetLabel)
	}

	// Rule 4: Different name + same URL => fail
	if (urlOwnedByDifferentName) {
		throw new RegistryExistsError(
			name,
			normalizedUrl,
			normalizedUrl,
			callbacks.targetLabel,
			existingByUrl.name,
		)
	}

	// Rule 2: Same name + same URL => idempotent no-op
	if (nameExists && sameUrl) {
		return { name, url: normalizedUrl, updated: false, alreadyConfigured: true }
	}

	// Rule 1: New name + new URL => add
	await callbacks.setRegistry(name, {
		url: normalizedUrl,
	})

	return { name, url: normalizedUrl, updated: false, alreadyConfigured: false }
}

/**
 * Find an existing registry entry by normalized URL.
 * Returns the entry name and config if found, null otherwise.
 */
function findRegistryByUrl(
	registries: Record<string, RegistryConfig>,
	normalizedUrl: string,
): { name: string; config: RegistryConfig } | null {
	for (const [name, config] of Object.entries(registries)) {
		if (normalizeRegistryUrl(config.url) === normalizedUrl) {
			return { name, config }
		}
	}
	return null
}

/**
 * Core logic for removing a registry.
 * @param name Registry name to remove
 * @param callbacks Callbacks for reading/writing config
 */
export async function runRegistryRemoveCore(
	name: string,
	callbacks: {
		getRegistries: () => Record<string, RegistryConfig>
		isLocked?: () => boolean
		removeRegistry: (name: string) => Promise<void>
	},
): Promise<{ removed: string }> {
	// Guard: Check registries aren't locked
	if (callbacks.isLocked?.()) {
		throw new Error("Registries are locked. Cannot remove.")
	}

	const registries = callbacks.getRegistries()
	if (!(name in registries)) {
		throw new Error(`Registry '${name}' not found.`)
	}

	await callbacks.removeRegistry(name)
	return { removed: name }
}

/**
 * Core logic for listing registries.
 * @param callbacks Callbacks for reading config
 */
export function runRegistryListCore(callbacks: {
	getRegistries: () => Record<string, RegistryConfig>
	isLocked?: () => boolean
}): { registries: Array<{ name: string; url: string }>; locked: boolean } {
	const registries = callbacks.getRegistries()
	const locked = callbacks.isLocked?.() ?? false

	const list = Object.entries(registries).map(([name, cfg]) => ({
		name,
		url: cfg.url,
	}))

	return { registries: list, locked }
}

export function registerRegistryCommand(program: Command): void {
	const parent = program.command("registry").description("Manage registry sources")
	for (const action of ["add", "remove", "list"] as const) {
		const command = parent
			.command(action === "add" ? "add <url>" : action === "remove" ? "remove <name>" : "list")
			.option("--global", "Use global sources for profile creation")
			.option("-p, --profile <name>", "Use a profile's sources")
			.option("--project", "Use project sources")
			.option("--cwd <directory>", "Project directory", process.cwd())
			.option("--json", "Output JSON")
		if (action === "add")
			command
				.requiredOption("--name <alias>", "Registry alias")
				.option("--dry-run", "Preview without writing")
		if (action === "remove") command.alias("rm")
		if (action === "list") command.alias("ls")
		command.action(async (...args: unknown[]) => {
			const value = action === "list" ? undefined : (args[0] as string)
			const options = args[action === "list" ? 0 : 1] as RegistryAddOptions
			try {
				const run = async () => {
					const target = await resolveMetadata(options)
					const config = target.config
					const callbacks = {
						getRegistries: () => config.registries,
						isLocked: () => "lockRegistries" in config && config.lockRegistries,
						targetLabel: target.path,
						setRegistry: async (name: string, entry: RegistryConfig) => {
							config.registries[name] = entry
							await mkdir(dirname(target.path), { recursive: true, mode: 0o700 })
							await atomicWrite(target.path, config)
						},
						removeRegistry: async (name: string) => {
							delete config.registries[name]
							await atomicWrite(target.path, config)
						},
					}
					const result =
						action === "add"
							? await runRegistryAddCore(value as string, options, callbacks)
							: action === "remove"
								? await runRegistryRemoveCore(value as string, callbacks)
								: runRegistryListCore(callbacks)
					if ("dryRun" in result) outputDryRun(result, { json: options.json })
					else if (options.json) outputJson({ success: true, ...result })
					else if ("registries" in result)
						console.log(
							result.registries.map((entry) => `${entry.name}\t${entry.url}`).join("\n") ||
								"No registries configured.",
						)
					else if ("removed" in result) console.log(`Removed registry "${result.removed}"`)
					else
						console.log(
							`Registry "${result.name}": ${result.url}${result.alreadyConfigured ? " (already configured)" : ""}`,
						)
				}
				if (action === "list" || options.dryRun) await run()
				else await withMetadataLock(options, run)
			} catch (error) {
				handleError(error, { json: options.json })
			}
		})
	}
}

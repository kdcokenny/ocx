import { type ParseError, parse } from "jsonc-parser"
import type { ConfigProvider } from "../config/provider"
import {
	createCanonicalId,
	type InstalledComponent,
	type Receipt,
	type RegistryConfig,
	readReceipt,
} from "../schemas/config"
import { profileOcxConfigSchema } from "../schemas/ocx"
import { parseQualifiedComponent } from "../schemas/registry"
import { resolveInstalledComponentRefs } from "../utils/component-ref-resolver"
import { ConflictError, IntegrityError, NotFoundError, ValidationError } from "../utils/errors"
import {
	applyFileChanges,
	type FileChange,
	readManagedFile,
	withInstallLock,
} from "../utils/file-transaction"
import { hashBundle, hashContent } from "../utils/receipt"
import { normalizeRegistryUrl } from "../utils/url"
import { fetchFileContent } from "./fetcher"
import { resolveDependencies } from "./resolver"

export interface InstallOptions {
	mode: "add" | "update"
	dryRun?: boolean
	force?: boolean
	from?: string
	/** Failure injection is used by transaction tests, never exposed in the CLI. */
	beforeWrite?: (index: number) => Promise<void>
}
export interface InstallationResult {
	components: string[]
	changes: { path: string; action: "add" | "update" | "delete" }[]
	dryRun: boolean
}

function qualified(entry: InstalledComponent): string {
	return `${entry.registryName}/${entry.name}`
}

function installedByName(receipt: Receipt): Map<string, { id: string; entry: InstalledComponent }> {
	const names = new Map<string, { id: string; entry: InstalledComponent }>()
	const paths = new Map<string, string>()
	for (const [id, entry] of Object.entries(receipt.installed)) {
		const name = qualified(entry)
		if (names.has(name)) throw new ValidationError(`Receipt has multiple installations of ${name}`)
		names.set(name, { id, entry })
		for (const file of entry.files) {
			const portablePath = file.path.normalize("NFC").replace(/\\/g, "/").toLowerCase()
			if (paths.has(portablePath))
				throw new ConflictError(
					`Receipt assigns ${file.path} to both ${paths.get(portablePath)} and ${name}`,
				)
			paths.set(portablePath, name)
		}
	}
	return names
}

function registrySources(
	provider: ConfigProvider,
	receipt: Receipt,
	references: string[],
	from?: string,
): Record<string, RegistryConfig> {
	const sources = { ...provider.getRegistries() }
	// Ephemeral installs retain their origin in the receipt so updates can find it.
	for (const entry of Object.values(receipt.installed))
		sources[entry.registryName] ??= { url: entry.registryUrl }
	if (!from) return sources
	const aliases = new Set(references.map((ref) => parseQualifiedComponent(ref).namespace))
	if (aliases.size !== 1)
		throw new ValidationError("All --from references must use one registry alias")
	const alias = [...aliases][0]
	if (!alias) throw new ValidationError("Specify a component for --from")
	sources[alias] = { url: from }
	return sources
}

async function receiptChange(root: string, receipt: Receipt): Promise<FileChange> {
	const path = ".ocx/receipt.jsonc"
	const previous = await readManagedFile(root, path)
	return {
		path,
		content: Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`),
		beforeHash: previous === null ? null : hashContent(previous),
	}
}

function summarize(
	components: string[],
	changes: FileChange[],
	dryRun?: boolean,
): InstallationResult {
	return {
		components,
		changes: changes
			.filter((item) => item.path !== ".ocx/receipt.jsonc")
			.map((item) => ({
				path: item.path,
				action: item.content === null ? "delete" : item.beforeHash === null ? "add" : "update",
			})),
		dryRun: Boolean(dryRun),
	}
}

export async function installComponents(
	references: string[],
	provider: ConfigProvider,
	options: InstallOptions,
): Promise<InstallationResult> {
	for (const reference of references) parseQualifiedComponent(reference)
	if (references.length === 0) throw new ValidationError("Specify at least one component")
	const run = () => prepareInstallation(references, provider, options)
	return options.dryRun ? run() : withInstallLock(provider.cwd, run)
}

async function prepareInstallation(
	references: string[],
	provider: ConfigProvider,
	options: InstallOptions,
): Promise<InstallationResult> {
	await provider.assertCurrent?.()
	const root = provider.cwd
	const receipt = (await readReceipt(root)) ?? { version: 1, installed: {} }
	const previous = installedByName(receipt)
	if (options.mode === "update") {
		for (const reference of references)
			if (!previous.has(reference))
				throw new NotFoundError(`Component ${reference} is not installed`)
	}
	const sources = registrySources(provider, receipt, references, options.from)
	const resolved = await resolveDependencies(sources, references)
	const next: Receipt = { version: 1, installed: { ...receipt.installed } }
	const incoming = new Map<string, { owner: string; content: Buffer }>()
	const replaced = new Set<string>()
	for (const component of resolved.components) {
		const name = `${component.registryName}/${component.name}`
		const old = previous.get(name)
		if (
			old &&
			normalizeRegistryUrl(old.entry.registryUrl) !== normalizeRegistryUrl(component.baseUrl)
		)
			throw new ConflictError(
				`Source URL for ${name} differs from its receipt. Remove the old installation before switching sources.`,
			)
		const files = await Promise.all(
			component.files.map(async (file) => ({
				path: file.target,
				content: await fetchFileContent(
					component.baseUrl,
					component.name,
					file.path,
					sources[component.registryName],
				),
			})),
		)
		for (const file of files) {
			if (!["ocx.jsonc", "opencode.json", "opencode.jsonc", "cli.json"].includes(file.path))
				continue
			const errors: ParseError[] = []
			const value: unknown = parse(file.content.toString("utf8"), errors, {
				allowTrailingComma: true,
			})
			if (errors.length || !value || typeof value !== "object" || Array.isArray(value))
				throw new ValidationError(`Invalid JSONC object in profile file ${file.path}`)
			if (file.path === "ocx.jsonc") profileOcxConfigSchema.parse(value)
		}
		const dependencies = component.dependencies
			.map((ref) => (ref.includes("/") ? ref : `${component.registryName}/${ref}`))
			.sort()
		// Include target paths and dependency edges; renamed files and changed dependencies are updates.
		const hash = hashContent(`${await hashBundle(files)}\n${JSON.stringify(dependencies)}`)
		if (old && options.mode === "add" && old.entry.hash !== hash)
			throw new IntegrityError(
				`${name} changed upstream. Use 'ocx update' to review and apply the update.`,
			)
		const id = createCanonicalId(
			component.baseUrl,
			component.registryName,
			component.name,
			`sha256:${hash}`,
		)
		if (old) delete next.installed[old.id]
		next.installed[id] = {
			registryUrl: component.baseUrl,
			registryName: component.registryName,
			name: component.name,
			revision: `sha256:${hash}`,
			hash,
			dependencies,
			files: files.map((file) => ({ path: file.path, hash: hashContent(file.content) })),
			installedAt: old?.entry.installedAt ?? new Date().toISOString(),
			...(old && old.entry.hash !== hash
				? { updatedAt: new Date().toISOString() }
				: old?.entry.updatedAt
					? { updatedAt: old.entry.updatedAt }
					: {}),
		}
		replaced.add(name)
		for (const file of files) {
			if (incoming.has(file.path))
				throw new ConflictError(
					`Two components write ${file.path}: ${incoming.get(file.path)?.owner} and ${name}`,
				)
			incoming.set(file.path, { owner: name, content: file.content })
		}
	}
	installedByName(next) // Also rejects collisions with installed components outside this update.
	const changes: FileChange[] = []
	for (const [path, file] of incoming) {
		const current = await readManagedFile(root, path)
		const currentHash = current === null ? null : hashContent(current)
		const old = previous.get(file.owner)?.entry
		const baseline = old?.files.find((item) => item.path === path)
		if (current?.equals(file.content)) continue
		if (baseline && currentHash !== baseline.hash && !options.force) {
			// A normal update preserves local edits when the upstream file is unchanged.
			if (
				options.mode === "update" &&
				current !== null &&
				hashContent(file.content) === baseline.hash
			)
				continue
			throw new IntegrityError(
				`Owned file ${path} was edited or removed locally. Use --force --dry-run to preview replacing it.`,
			)
		}
		if (!baseline && current !== null)
			throw new ConflictError(`Unmanaged file would be overwritten: ${path}`)
		changes.push({ path, content: file.content, beforeHash: currentHash })
	}
	for (const { entry } of previous.values()) {
		if (!replaced.has(qualified(entry))) continue
		for (const file of entry.files) {
			if (incoming.has(file.path)) continue
			const current = await readManagedFile(root, file.path)
			if (current === null) continue
			const currentHash = hashContent(current)
			if (currentHash !== file.hash && !options.force)
				throw new IntegrityError(
					`Obsolete upstream file ${file.path} has local edits. Use --force --dry-run to preview its deletion.`,
				)
			changes.push({ path: file.path, content: null, beforeHash: currentHash })
		}
	}
	const metadataChanged = JSON.stringify(receipt.installed) !== JSON.stringify(next.installed)
	if (metadataChanged || changes.length > 0) changes.push(await receiptChange(root, next))
	if (!options.dryRun) await applyFileChanges(root, changes, options.beforeWrite)
	return summarize(resolved.installOrder, changes, options.dryRun)
}

export async function removeComponents(
	references: string[],
	provider: ConfigProvider,
	options: { force?: boolean; dryRun?: boolean; beforeWrite?: (index: number) => Promise<void> },
): Promise<InstallationResult> {
	const run = async () => {
		await provider.assertCurrent?.()
		const receipt = await readReceipt(provider.cwd)
		if (!receipt) throw new NotFoundError("No components installed")
		const previous = installedByName(receipt)
		const selected = new Set(
			resolveInstalledComponentRefs(references, receipt).map((id) => {
				const entry = receipt.installed[id]
				if (!entry) throw new NotFoundError(`Component ${id} is not installed`)
				return qualified(entry)
			}),
		)
		for (const reference of selected)
			if (!previous.has(reference))
				throw new NotFoundError(`Component ${reference} is not installed`)
		for (const { entry } of previous.values()) {
			if (selected.has(qualified(entry))) continue
			const dependency = entry.dependencies.find((ref) => selected.has(ref))
			if (dependency)
				throw new ConflictError(
					`${qualified(entry)} still depends on ${dependency}. Remove both explicitly to continue.`,
				)
		}
		const changes: FileChange[] = []
		for (const reference of selected) {
			const found = previous.get(reference)
			if (!found) throw new NotFoundError(`Component ${reference} is not installed`)
			for (const file of found.entry.files) {
				const current = await readManagedFile(provider.cwd, file.path)
				if (current === null) continue
				const hash = hashContent(current)
				if (hash !== file.hash && !options.force)
					throw new IntegrityError(
						`Owned file ${file.path} has local edits. Use --force --dry-run to preview deletion.`,
					)
				changes.push({ path: file.path, content: null, beforeHash: hash })
			}
			delete receipt.installed[found.id]
		}
		changes.push(await receiptChange(provider.cwd, receipt))
		if (!options.dryRun) await applyFileChanges(provider.cwd, changes, options.beforeWrite)
		return summarize([...selected], changes, options.dryRun)
	}
	return options.dryRun ? run() : withInstallLock(provider.cwd, run)
}

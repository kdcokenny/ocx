import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { normalizeFile } from "../schemas/registry"
import type { DryRunResult } from "../utils/dry-run"
import { readManagedFile } from "../utils/file-transaction"
import { logger } from "../utils/logger"
import { runCompleteValidation } from "./validation-runner"

export interface BuildRegistryOptions {
	source: string
	out: string
	dryRun?: boolean
}

export interface BuildRegistryResult {
	componentsCount: number
	outputPath: string
}

export class BuildRegistryError extends Error {
	constructor(
		message: string,
		public readonly errors: string[] = [],
	) {
		super(message)
		this.name = "BuildRegistryError"
	}
}

/** Validate and stage the complete registry before replacing any published output. */
export async function buildRegistry(
	options: BuildRegistryOptions,
): Promise<BuildRegistryResult | DryRunResult> {
	const source = resolve(options.source)
	const out = resolve(options.out)
	const sourceFromOutput = relative(out, source)
	if (
		!sourceFromOutput ||
		(sourceFromOutput !== ".." &&
			!sourceFromOutput.startsWith(`..${sep}`) &&
			!isAbsolute(sourceFromOutput))
	)
		throw new BuildRegistryError("Output must not contain the registry source directory")
	const validation = await runCompleteValidation(source)
	if (!validation.success || !validation.registry)
		throw new BuildRegistryError("Registry validation failed", validation.errors)
	const registry = validation.registry
	const files = new Map<string, Buffer>()
	const addJson = (path: string, value: unknown) =>
		files.set(path, Buffer.from(JSON.stringify(value, null, 2)))
	for (const component of registry.components) {
		const version = component.version ?? registry.version
		addJson(`components/${component.name}.json`, {
			name: component.name,
			versions: { [version]: component },
			"dist-tags": { latest: version },
		})
		for (const rawFile of component.files) {
			const file = normalizeFile(rawFile, component.type)
			const bytes = await readManagedFile(source, `files/${file.path}`)
			if (!bytes) throw new BuildRegistryError(`Source file disappeared: ${file.path}`)
			files.set(`components/${component.name}/${file.path}`, bytes)
		}
	}
	addJson("index.json", {
		$schema: registry.$schema,
		name: registry.name,
		version: registry.version,
		author: registry.author,
		...(registry.opencode && { opencode: registry.opencode }),
		...(registry.ocx && { ocx: registry.ocx }),
		components: registry.components.map(({ name, type, description }) => ({
			name,
			type,
			description,
		})),
	})
	addJson(".well-known/ocx.json", { registry: "/index.json" })
	if (options.dryRun)
		return {
			dryRun: true,
			command: "build",
			wouldPerform: [...files.keys()].map((path) => ({ action: "create", target: `file:${path}` })),
			validation: { passed: true },
			summary: `Would build ${registry.components.length} components, ${files.size} files to ${out}`,
		}
	await mkdir(dirname(out), { recursive: true })
	const stage = await mkdtemp(join(dirname(out), ".ocx-build-"))
	const candidate = join(stage, "candidate")
	const backup = join(stage, "previous")
	let hadPrevious = false
	let preserveBackup = false
	try {
		for (const [path, bytes] of files) {
			const target = join(candidate, path)
			await mkdir(dirname(target), { recursive: true })
			await writeFile(target, bytes)
		}
		try {
			const info = await lstat(out)
			if (!info.isDirectory() || info.isSymbolicLink())
				throw new BuildRegistryError("Output must be a real directory")
			await rename(out, backup)
			hadPrevious = true
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		}
		try {
			await rename(candidate, out)
		} catch (error) {
			if (hadPrevious) {
				try {
					await rename(backup, out)
				} catch (restoreError) {
					preserveBackup = true
					throw new AggregateError([error, restoreError], `Previous registry remains at ${backup}`)
				}
			}
			throw error
		}
	} finally {
		if (!preserveBackup)
			await rm(stage, { recursive: true, force: true }).catch((error) =>
				logger.warn(`Could not remove build staging directory ${stage}: ${error}`),
			)
	}
	return { componentsCount: registry.components.length, outputPath: out }
}

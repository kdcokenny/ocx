import { lstat, mkdir, realpath, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { normalizeFile } from "../schemas/registry"
import type { DryRunResult } from "../utils/dry-run"
import { readManagedFile } from "../utils/file-transaction"
import { publishDirectory } from "../utils/publish-directory"
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
	try {
		const info = await lstat(source)
		if (!info.isDirectory() || info.isSymbolicLink())
			throw new BuildRegistryError("Registry source must be a real directory")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			throw new BuildRegistryError("Registry validation failed", [
				`Source directory does not exist: ${source}`,
			])
		throw error
	}
	const out = resolve(options.out)
	const canonical = async (path: string): Promise<string> => {
		try {
			return await realpath(path)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			return join(await canonical(dirname(path)), basename(path))
		}
	}
	const contains = (parent: string, child: string) => {
		const path = relative(parent, child)
		return !path || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
	}
	const canonicalOut = await canonical(out)
	const canonicalSource = await realpath(source)
	const sourceFiles = await canonical(join(source, "files"))
	if (
		contains(canonicalOut, canonicalSource) ||
		contains(canonicalOut, sourceFiles) ||
		contains(sourceFiles, canonicalOut)
	)
		throw new BuildRegistryError(
			"Output must not contain or overlap the registry source directory or files tree",
		)
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
	await publishDirectory(out, async (candidate) => {
		for (const [path, bytes] of files) {
			const target = join(candidate, path)
			await mkdir(dirname(target), { recursive: true })
			await writeFile(target, bytes)
		}
	})
	return { componentsCount: registry.components.length, outputPath: out }
}

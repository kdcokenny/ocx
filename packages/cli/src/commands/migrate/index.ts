import { mkdir, readdir, stat, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import type { Command } from "commander"
import { applyEdits, modify, type ParseError, parse } from "jsonc-parser"
import { ProfileManager } from "../../profile/manager"
import { getProfileDir } from "../../profile/paths"
import { profileNameSchema } from "../../profile/schema"
import { profileOcxConfigSchema } from "../../schemas/ocx"
import { ConfigError, ValidationError } from "../../utils/errors"
import { readManagedFile } from "../../utils/file-transaction"
import { handleError } from "../../utils/handle-error"
import { outputJson } from "../../utils/json-output"
import { hashContent } from "../../utils/receipt"

export interface MigrateOptions {
	from: string
	profile: string
	projectConfig?: "ignore" | "inherit"
	omitPlugins?: boolean
	omitInstructions?: boolean
	acceptGuidance?: boolean
	apply?: boolean
	json?: boolean
}
interface ImportItem {
	path: string
	action: "copy" | "convert" | "omit"
	reason?: string
	sha256?: string
}
interface ImportReport {
	source: string
	destination: string
	items: ImportItem[]
	warnings: string[]
	unresolved: string[]
	applied: boolean
}

const OMIT_DIRECTORIES = new Set(["node_modules", ".git", ".cache", ".ocx", ".opencode"])
const OMIT_FILES = new Set([
	"package.json",
	"package-lock.json",
	"bun.lock",
	"bun.lockb",
	"pnpm-lock.yaml",
	"yarn.lock",
	"ocx.lock",
	"auth.json",
	"service.json",
	"tui.json",
	"tui.jsonc",
])
const RETIRED_PACKAGES = new Set([
	"opencode-background-agents",
	"opencode-notify",
	"opencode-worktree",
	"opencode-workspace",
])
const OLD_TOOLS =
	/\b(?:delegate|delegation_read|delegation_list|plan_save|plan_read|plan_find|worktree_create|worktree_delete)\b/

function objectConfig(bytes: Buffer, path: string): Record<string, unknown> {
	const errors: ParseError[] = []
	const value: unknown = parse(bytes.toString("utf8"), errors, { allowTrailingComma: true })
	if (errors.length || !value || typeof value !== "object" || Array.isArray(value))
		throw new ConfigError(`Invalid JSONC object: ${path}`)
	return value as Record<string, unknown>
}

function pluginPackage(entry: unknown): string | undefined {
	const target =
		typeof entry === "string"
			? entry
			: Array.isArray(entry)
				? entry[0]
				: typeof entry === "object" && entry && "package" in entry
					? entry.package
					: undefined
	if (typeof target !== "string") return undefined
	// Only exact unscoped package IDs are identified; paths and other namespaces stay unresolved.
	return target.replace(/@[^@/]+$/, "")
}

/** Preview by default; application publishes a separate profile only after all decisions are explicit. */
export async function importLegacy(options: MigrateOptions): Promise<ImportReport> {
	profileNameSchema.parse(options.profile)
	if (options.projectConfig !== undefined && !["ignore", "inherit"].includes(options.projectConfig))
		throw new ValidationError("--project-config must be ignore or inherit")
	let source = resolve(options.from)
	if (
		!(await Bun.file(join(source, "ocx.jsonc")).exists()) &&
		(await Bun.file(join(source, ".opencode", "ocx.jsonc")).exists())
	)
		source = join(source, ".opencode")
	if (!(await stat(source)).isDirectory())
		throw new ValidationError("--from must be a legacy profile or project configuration directory")
	const metadata = await readManagedFile(source, "ocx.jsonc")
	if (!metadata)
		throw new ValidationError(
			`No legacy ocx.jsonc at ${source}. Point --from at the profile or project configuration directory.`,
		)
	const oldMetadata = objectConfig(metadata, "ocx.jsonc")
	const report: ImportReport = {
		source,
		destination: getProfileDir(options.profile),
		items: [],
		warnings: [],
		unresolved: [],
		applied: false,
	}
	const candidate = new Map<string, Buffer>()
	const filterKeys = ["include", "exclude"].filter(
		(key) => Array.isArray(oldMetadata[key]) && (oldMetadata[key] as unknown[]).length > 0,
	)
	if (filterKeys.length && options.projectConfig === undefined)
		report.unresolved.push(
			"Legacy include/exclude filters cannot be translated exactly. Choose --project-config ignore or inherit.",
		)
	if (filterKeys.length)
		report.warnings.push(
			"Project filtering becomes one native switch. Nested AGENTS.md can still load during reads in either mode, as in V1.",
		)
	if (oldMetadata.registries && typeof oldMetadata.registries === "object")
		report.warnings.push(
			"Legacy registry sources are omitted. Add schema 3 sources after import; the original sources remain unchanged.",
		)
	const newMetadata = profileOcxConfigSchema.parse({
		registries: {},
		projectConfig: options.projectConfig ?? "ignore",
		...(typeof oldMetadata.bin === "string" ? { bin: oldMetadata.bin } : {}),
	})
	candidate.set("ocx.jsonc", Buffer.from(`${JSON.stringify(newMetadata, null, 2)}\n`))
	report.items.push({
		path: "ocx.jsonc",
		action: "convert",
		reason:
			"Keep binary selection; replace filtering with native project mode; start with no legacy registry sources",
		sha256: hashContent(metadata),
	})
	const addedInstructions: string[] = []
	async function walk(directory: string, prefix = "") {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = prefix ? `${prefix}/${entry.name}` : entry.name
			if (path === "ocx.jsonc") continue
			if (entry.isSymbolicLink()) {
				report.unresolved.push(
					`Symlink ${path} must be replaced with a portable file before import.`,
				)
				continue
			}
			if (entry.isDirectory() && !prefix && ["plugin", "plugins"].includes(entry.name)) {
				report.items.push({
					path,
					action: "omit",
					reason: "Omit the complete V1 runtime directory to prevent native plugin autodiscovery",
				})
				if (!options.omitPlugins)
					report.unresolved.push(
						`Runtime directory ${path}: use --omit-plugins to leave it out of the new profile.`,
					)
				continue
			}
			if (entry.isDirectory() && OMIT_DIRECTORIES.has(entry.name)) {
				report.items.push({
					path,
					action: "omit",
					reason: "Generated state, legacy receipt, nested configuration, or repository internals",
				})
				continue
			}
			if (entry.isDirectory()) {
				await walk(join(directory, entry.name), path)
				continue
			}
			if (!entry.isFile()) {
				report.unresolved.push(`Unsupported special file: ${path}`)
				continue
			}
			const bytes = await readManagedFile(source, path)
			if (!bytes) throw new ValidationError(`Source file disappeared during import: ${path}`)
			const sha256 = hashContent(bytes)
			if (OMIT_FILES.has(path) || entry.name === ".env" || entry.name.startsWith(".env.")) {
				report.items.push({
					path,
					action: "omit",
					reason:
						"Legacy package management, credentials, service state, or terminal config; preserve original for manual migration",
					sha256,
				})
				continue
			}
			if (/^(?:plugins?|tools?)\//.test(path) && /\.(?:[cm]?[jt]sx?)$/.test(path)) {
				report.items.push({
					path,
					action: "omit",
					reason: "V1 runtime implementation requires a V2 port",
					sha256,
				})
				if (!options.omitPlugins)
					report.unresolved.push(
						`Runtime file ${path}: use --omit-plugins to leave it out of the new profile.`,
					)
				continue
			}
			let converted = bytes
			if (["opencode.json", "opencode.jsonc", "cli.json"].includes(path)) {
				const config = objectConfig(bytes, path)
				let text = bytes.toString("utf8")
				for (const field of ["plugin", "plugins"]) {
					if (config[field] === undefined) continue
					const entries = Array.isArray(config[field])
						? (config[field] as unknown[])
						: [config[field]]
					const unknown = entries.filter((item) => !RETIRED_PACKAGES.has(pluginPackage(item) ?? ""))
					if (unknown.length && !options.omitPlugins)
						report.unresolved.push(
							`${path}: ${unknown.length} unverified plugin entry(s). Use --omit-plugins to exclude them; V1 implementations cannot run in V2.`,
						)
					text = applyEdits(text, modify(text, [field], undefined, {}))
					report.warnings.push(
						`${path}: removed ${entries.length} plugin entry(s) from the candidate; originals remain in the source.`,
					)
				}
				if (config.instructions !== undefined) {
					const entries = Array.isArray(config.instructions) ? config.instructions : []
					if (!Array.isArray(config.instructions) && !options.omitInstructions)
						report.unresolved.push(
							`${path}: instructions is not an array; use --omit-instructions to omit it.`,
						)
					for (const instruction of entries) {
						if (options.omitInstructions) continue
						if (typeof instruction !== "string" || /[{}*?[\]]|^\w+:/.test(instruction)) {
							report.unresolved.push(
								`${path}: an instruction reference cannot be copied automatically. Use --omit-instructions or replace it with a local file.`,
							)
							continue
						}
						const local = relative(source, resolve(source, instruction)).replace(/\\/g, "/")
						try {
							const contents = await readManagedFile(source, local)
							if (!contents) throw new Error("missing file")
							addedInstructions.push(
								`\n\n<!-- Imported from ${local} -->\n${contents.toString("utf8")}`,
							)
						} catch {
							report.unresolved.push(
								`${path}: instruction ${instruction} is missing or outside the source. Use --omit-instructions to omit it.`,
							)
						}
					}
					text = applyEdits(text, modify(text, ["instructions"], undefined, {}))
				}
				converted = Buffer.from(text)
			}
			if (/\.md$/i.test(path) && OLD_TOOLS.test(bytes.toString("utf8"))) {
				report.warnings.push(
					`${path} mentions retired runtime tools; review its instructions before use.`,
				)
				if (!options.acceptGuidance)
					report.unresolved.push(
						`${path}: rewrite the old tool guidance or pass --accept-guidance to keep it for manual editing.`,
					)
			}
			candidate.set(path, converted)
			report.items.push({ path, action: converted.equals(bytes) ? "copy" : "convert", sha256 })
		}
	}
	await walk(source)
	if (!candidate.has("AGENTS.md") && candidate.has("CLAUDE.md")) {
		candidate.set("AGENTS.md", candidate.get("CLAUDE.md") as Buffer)
		report.items.push({
			path: "AGENTS.md",
			action: "convert",
			reason: "Preserve the former CLAUDE.md fallback using native AGENTS.md discovery",
		})
	}
	if (addedInstructions.length) {
		candidate.set(
			"AGENTS.md",
			Buffer.concat([
				candidate.get("AGENTS.md") ?? Buffer.alloc(0),
				Buffer.from(addedInstructions.join("")),
			]),
		)
		report.items.push({
			path: "AGENTS.md",
			action: "convert",
			reason: "Embed local instructions because V2 does not resolve the instructions array",
		})
	}
	if (!options.apply) return report
	if (report.unresolved.length)
		throw new ValidationError(
			`Import needs explicit decisions. Run without --apply to review:\n${report.unresolved.join("\n")}`,
		)
	await ProfileManager.create().createStaged(options.profile, async (stage) => {
		for (const [path, bytes] of candidate) {
			const target = join(stage, path)
			await mkdir(dirname(target), { recursive: true, mode: 0o700 })
			await writeFile(target, bytes, { mode: 0o600, flag: "wx" })
		}
		await mkdir(join(stage, ".ocx"), { recursive: true })
		await writeFile(
			join(stage, ".ocx/import.json"),
			`${JSON.stringify({ ...report, applied: true }, null, 2)}\n`,
			{ mode: 0o600 },
		)
	})
	report.applied = true
	return report
}

export function registerMigrateCommand(program: Command): void {
	program
		.command("migrate")
		.description("Preview an import from legacy OCX into a separate V2 profile")
		.requiredOption("--from <directory>", "Legacy profile or project configuration directory")
		.requiredOption("-p, --profile <name>", "New profile name")
		.option("--project-config <mode>", "Choose ignore or inherit for project configuration")
		.option("--omit-plugins", "Exclude all unverified V1 plugin entries and runtime files")
		.option(
			"--omit-instructions",
			"Omit instructions-array references instead of embedding local files",
		)
		.option("--accept-guidance", "Keep text mentioning retired tools for manual editing")
		.option("--apply", "Publish the new profile after resolving every reported decision")
		.option("--json", "Output the import report as JSON")
		.action(async (options: MigrateOptions) => {
			try {
				const report = await importLegacy(options)
				if (options.json) outputJson(report)
				else {
					console.log(
						`${report.applied ? "Imported" : "Import preview"}: ${report.source}\nDestination: ${report.destination}`,
					)
					for (const item of report.items)
						console.log(`  ${item.action}: ${item.path}${item.reason ? ` — ${item.reason}` : ""}`)
					for (const warning of report.warnings) console.log(`Warning: ${warning}`)
					for (const decision of report.unresolved) console.log(`Decision required: ${decision}`)
				}
			} catch (error) {
				handleError(error, { json: options.json })
			}
		})
}

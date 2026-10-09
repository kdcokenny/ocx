import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { access, lstat, writeFile } from "node:fs/promises"
import { extname, join } from "node:path"
import type { Command } from "commander"
import { readGlobalConfig } from "../../config/files"
import { DEFAULT_OCX_CONFIG_TEMPLATE, ProfileManager } from "../../profile/manager"
import { getProfileDir } from "../../profile/paths"
import { fetchComponent } from "../../registry/fetcher"
import { parseQualifiedComponent } from "../../schemas/registry"
import { ConfigError, ValidationError } from "../../utils/errors"
import { handleError } from "../../utils/handle-error"
import { outputJson } from "../../utils/json-output"
import { runAddCore } from "../add"

interface OutputOptions {
	json?: boolean
}
interface ProfileAddOptions extends OutputOptions {
	clone?: string
	source?: string
	from?: string
}

export async function addProfile(name: string, options: ProfileAddOptions): Promise<void> {
	if (options.clone && (options.source || options.from))
		throw new ValidationError("Use --clone or --source, not both.")
	if (options.from && !options.source)
		throw new ValidationError("--from requires --source <alias/component>.")
	const manager = ProfileManager.create()
	if (options.clone) return manager.clone(name, options.clone)
	if (!options.source) return manager.add(name)
	const source = options.source
	const { namespace, component } = parseQualifiedComponent(source)
	const registries = { ...(await readGlobalConfig()).registries }
	if (options.from) registries[namespace] = { url: options.from }
	const registry = registries[namespace]
	if (!registry)
		throw new ConfigError(
			`Configure source "${namespace}" with 'ocx registry add <url> --name ${namespace} --global', or pass --from <url>.`,
		)
	const recipe = await fetchComponent(registry.url, component, registry)
	if (recipe.type !== "profile") throw new ValidationError(`${source} is not a profile component.`)
	await manager.createStaged(name, async (stage) => {
		await runAddCore(
			[source],
			{ profile: name, quiet: true },
			{
				cwd: stage,
				getRegistries: () => registries,
				getComponentPath: () => "",
			},
		)
		const metadata = join(stage, "ocx.jsonc")
		if (!(await Bun.file(metadata).exists()))
			await writeFile(metadata, DEFAULT_OCX_CONFIG_TEMPLATE, { mode: 0o600 })
	})
}

async function resolveDoctorPath(selected: string): Promise<string> {
	const doctor = join(getProfileDir(selected), "doctor")
	if (process.platform !== "win32") return doctor
	try {
		if ((await lstat(`${doctor}.exe`)).isFile()) return `${doctor}.exe`
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
	return doctor
}

async function assertDoctorFile(selected: string, doctor: string): Promise<void> {
	let stats: Awaited<ReturnType<typeof lstat>>
	try {
		stats = await lstat(doctor)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			throw new ConfigError(`Profile "${selected}" has no executable doctor script at ${doctor}.`)
		throw error
	}
	if (!stats.isFile()) throw new ConfigError(`Profile doctor must be a regular file: ${doctor}`)
	if (process.platform === "win32") return
	try {
		await access(doctor, constants.X_OK)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EACCES")
			throw new ConfigError(`Profile doctor is not executable: ${doctor}`)
		throw error
	}
}

export interface ProfileDoctorResult {
	exitCode: number
	stdout: string
	stderr: string
}

function quoteCmdPath(path: string): string {
	const quoted = `"${path.replaceAll('"', '""')}"`
	return `""${quoted}"`
}

function collectStream(stream: NodeJS.ReadableStream | null, chunks: Buffer[]): void {
	stream?.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)))
}

export async function runProfileDoctor(
	name: string | undefined,
	options: { json?: boolean } = {},
): Promise<ProfileDoctorResult> {
	const manager = ProfileManager.create()
	const selected = await manager.resolveProfile(name)
	const doctor = await resolveDoctorPath(selected)
	await assertDoctorFile(selected, doctor)
	const windowsScript = process.platform === "win32" && extname(doctor).toLowerCase() !== ".exe"
	const stdout: Buffer[] = []
	const stderr: Buffer[] = []
	const stdio = options.json ? (["ignore", "pipe", "pipe"] as const) : ("inherit" as const)
	return await new Promise((resolve, reject) => {
		const child = windowsScript
			? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", quoteCmdPath(doctor)], {
					stdio,
					windowsVerbatimArguments: true,
				})
			: spawn(doctor, { stdio })
		collectStream(child.stdout, stdout)
		collectStream(child.stderr, stderr)
		child.on("error", reject)
		child.on("close", (code) =>
			resolve({
				exitCode: code ?? 1,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			}),
		)
	})
}

export function registerProfileCommand(program: Command): void {
	const parent = program.command("profile").alias("p").description("Manage portable named profiles")
	parent
		.command("add <name>")
		.description("Create, clone, or install a profile")
		.option("--clone <name>", "Copy all editable files from a profile")
		.option("--source <alias/component>", "Install a profile recipe")
		.option("--from <url>", "Use an ephemeral registry for the recipe")
		.option("--json", "Output JSON")
		.action(async (name: string, options: ProfileAddOptions) => {
			try {
				await addProfile(name, options)
				if (options.json) outputJson({ success: true, name, path: getProfileDir(name) })
				else console.log(`Created profile "${name}" at ${getProfileDir(name)}`)
			} catch (error) {
				handleError(error, { json: options.json })
			}
		})
	parent
		.command("list")
		.alias("ls")
		.description("List profiles")
		.option("--json", "Output JSON")
		.action(async (options: OutputOptions) => {
			try {
				const profiles = await ProfileManager.create().list()
				const config = await readGlobalConfig()
				if (options.json) outputJson({ profiles, defaultProfile: config.defaultProfile ?? null })
				else
					console.log(
						profiles
							.map((name) => `${name}${name === config.defaultProfile ? " (default)" : ""}`)
							.join("\n") || "No profiles. Create one with 'ocx profile add <name>'.",
					)
			} catch (error) {
				handleError(error, { json: options.json })
			}
		})
	parent
		.command("show [name]")
		.description("Show profile metadata and native config")
		.option("--json", "Output JSON")
		.action(async (name: string | undefined, options: OutputOptions) => {
			try {
				const manager = ProfileManager.create()
				const selected = await manager.resolveProfile(name)
				outputJson({ ...(await manager.get(selected)), path: getProfileDir(selected) })
			} catch (error) {
				handleError(error, { json: options.json })
			}
		})
	parent
		.command("remove <name>")
		.alias("rm")
		.description("Remove a profile and all its files")
		.option("--json", "Output JSON")
		.action(async (name: string, options: OutputOptions) => {
			try {
				await ProfileManager.create().remove(name)
				if (options.json) outputJson({ success: true, removed: name })
				else console.log(`Removed profile "${name}"`)
			} catch (error) {
				handleError(error, { json: options.json })
			}
		})
	parent
		.command("move <name> <newName>")
		.alias("mv")
		.description("Rename a profile")
		.option("--json", "Output JSON")
		.action(async (name: string, newName: string, options: OutputOptions) => {
			try {
				const result = await ProfileManager.create().move(name, newName)
				if (options.json) outputJson({ success: true, name: newName, ...result })
				else {
					console.log(`Renamed "${name}" to "${newName}"`)
					if (result.warnActiveProfile)
						console.error(`Update OCX_PROFILE to "${newName}" in your shell.`)
				}
			} catch (error) {
				handleError(error, { json: options.json })
			}
		})
	parent
		.command("doctor")
		.description("Run the profile-owned doctor script")
		.option("-p, --profile <name>", "Profile to check")
		.option("--json", "Output JSON")
		.action(async (options: OutputOptions & { profile?: string }) => {
			try {
				if (!options.profile) throw new ValidationError("Usage: ocx profile doctor --profile <name>")
				const selected = await ProfileManager.create().resolveProfile(options.profile)
				const result = await runProfileDoctor(selected, { json: options.json })
				if (options.json)
					outputJson({
						success: result.exitCode === 0,
						profile: selected,
						exitCode: result.exitCode,
						stdout: result.stdout,
						stderr: result.stderr,
					})
				if (result.exitCode !== 0) {
					await new Promise((resolve) => process.stdout.write("", resolve))
					process.exit(result.exitCode)
				}
			} catch (error) {
				handleError(error, { json: options.json })
			}
		})
	parent
		.command("use [name]")
		.description("Set the explicit default profile")
		.option("--clear", "Remove the default selection")
		.option("--json", "Output JSON")
		.action(async (name: string | undefined, options: OutputOptions & { clear?: boolean }) => {
			try {
				if ((name !== undefined) === Boolean(options.clear))
					throw new ValidationError("Provide a profile name or --clear.")
				await ProfileManager.create().setDefault(name)
				if (options.json) outputJson({ success: true, defaultProfile: name ?? null })
				else console.log(name ? `Default profile: ${name}` : "Default profile cleared")
			} catch (error) {
				handleError(error, { json: options.json })
			}
		})
}

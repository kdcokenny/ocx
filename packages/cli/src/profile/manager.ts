import { copyFile, lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { readGlobalConfig, readJsoncObject } from "../config/files"
import { readReceipt, writeReceipt } from "../schemas/config"
import { type ProfileOcxConfig, profileOcxConfigSchema } from "../schemas/ocx"
import { ConfigError, ProfileExistsError, ProfileNotFoundError } from "../utils/errors"
import { assertNoInterruptedTransaction, withInstallLock } from "../utils/file-transaction"
import { assertProfileRoots, realDirectoryExists, withProfileLock } from "./lock"

export { withProfileLock } from "./lock"

import { atomicWrite } from "./atomic"
import { getGlobalConfig, getGlobalOcxRoot, getProfileDir, getProfilesDir } from "./paths"
import { type Profile, profileNameSchema } from "./schema"

export const DEFAULT_OCX_CONFIG: ProfileOcxConfig = {
	$schema: "https://ocx.kdco.dev/schemas/v3/profile.json",
	registries: {},
	projectConfig: "ignore",
}
export const DEFAULT_OCX_CONFIG_TEMPLATE = `${JSON.stringify(DEFAULT_OCX_CONFIG, null, 2)}\n`

/** Copy editable profile files, excluding generated dependencies and repository internals. */
export async function copyProfileFiles(source: string, destination: string): Promise<void> {
	await mkdir(destination, { recursive: true, mode: 0o700 })
	for (const entry of await readdir(source, { withFileTypes: true })) {
		if (["node_modules", ".git", ".cache", ".locks"].includes(entry.name)) continue
		const from = join(source, entry.name)
		const to = join(destination, entry.name)
		if (entry.isDirectory()) await copyProfileFiles(from, to)
		else if (entry.isFile()) await copyFile(from, to)
		else
			throw new ConfigError(
				`Cannot copy special file or symlink ${from}. Replace it with a portable file first.`,
			)
	}
}

export class ProfileManager {
	static create(_cwd?: string): ProfileManager {
		return new ProfileManager()
	}
	static async requireInitialized(): Promise<ProfileManager> {
		return new ProfileManager()
	}
	async isInitialized(): Promise<boolean> {
		await assertProfileRoots()
		return realDirectoryExists(getProfilesDir())
	}
	async list(): Promise<string[]> {
		if (!(await this.isInitialized())) return []
		const entries = await readdir(getProfilesDir(), { withFileTypes: true })
		const names: string[] = []
		for (const entry of entries) {
			if (!profileNameSchema.safeParse(entry.name).success) continue
			if (entry.isDirectory() && (await this.exists(entry.name))) names.push(entry.name)
		}
		return names.sort()
	}
	async exists(name: string): Promise<boolean> {
		await assertProfileRoots()
		return realDirectoryExists(getProfileDir(name))
	}
	async get(name: string): Promise<Profile> {
		if (!(await this.exists(name))) throw new ProfileNotFoundError(name)
		const root = getProfileDir(name)
		const metadata = join(root, "ocx.jsonc")
		if (!(await Bun.file(metadata).exists()))
			throw new ConfigError(`Profile "${name}" is missing ${metadata}`)
		const ocx = profileOcxConfigSchema.parse(await readJsoncObject(metadata))
		// Native settings are read only for inspection; OpenCode performs their normalization.
		const jsonc = join(root, "opencode.jsonc")
		const json = join(root, "opencode.json")
		const nativePath = (await Bun.file(jsonc).exists()) ? jsonc : json
		const opencode = (await Bun.file(nativePath).exists())
			? await readJsoncObject(nativePath)
			: undefined
		return { name, ocx, opencode, hasAgents: await Bun.file(join(root, "AGENTS.md")).exists() }
	}
	async createStaged(name: string, populate: (directory: string) => Promise<void>): Promise<void> {
		await withProfileLock(name, async () => {
			const destination = getProfileDir(name)
			try {
				await lstat(destination)
				throw new ProfileExistsError(name)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			}
			const stage = await mkdtemp(join(getProfilesDir(), ".stage-"))
			try {
				await populate(stage)
				profileOcxConfigSchema.parse(await readJsoncObject(join(stage, "ocx.jsonc")))
				const receipt = await readReceipt(stage)
				if (receipt)
					await writeReceipt(stage, { version: receipt.version, installed: receipt.installed })
				await rename(stage, destination)
			} finally {
				await rm(stage, { recursive: true, force: true })
			}
		})
	}
	async add(name: string): Promise<void> {
		await this.createStaged(name, async (stage) => {
			await writeFile(join(stage, "ocx.jsonc"), DEFAULT_OCX_CONFIG_TEMPLATE, { mode: 0o600 })
			await writeFile(join(stage, "opencode.jsonc"), "{}\n", { mode: 0o600 })
			await writeFile(join(stage, "AGENTS.md"), "# Profile instructions\n", { mode: 0o600 })
		})
	}
	async clone(name: string, source: string): Promise<void> {
		await this.get(source)
		if (name === source) throw new ProfileExistsError(name)
		await withProfileLock(source, async () => {
			await assertNoInterruptedTransaction(getProfileDir(source))
			await this.createStaged(name, (stage) => copyProfileFiles(getProfileDir(source), stage))
		})
	}
	async remove(name: string): Promise<void> {
		await withInstallLock(getGlobalOcxRoot(), () =>
			withProfileLock(name, async () => {
				if (!(await this.exists(name))) throw new ProfileNotFoundError(name)
				const config = await readGlobalConfig()
				if (config.defaultProfile === name)
					throw new ConfigError(
						`"${name}" is the default profile. Select another with 'ocx profile use <name>' or clear it with 'ocx profile use --clear'.`,
					)
				await assertNoInterruptedTransaction(getProfileDir(name))
				if (await Bun.file(join(getGlobalOcxRoot(), ".ocx/profile-move.json")).exists())
					throw new ConfigError("Finish the interrupted profile move before deleting profiles")
				await rm(getProfileDir(name), { recursive: true })
			}),
		)
	}
	async move(oldName: string, newName: string): Promise<{ warnActiveProfile: boolean }> {
		profileNameSchema.parse(newName)
		if (oldName === newName) {
			await this.get(oldName)
			return { warnActiveProfile: false }
		}
		await withInstallLock(getGlobalOcxRoot(), () =>
			withProfileLock(oldName, () =>
				withProfileLock(newName, async () => {
					const journal = join(getGlobalOcxRoot(), ".ocx/profile-move.json")
					if (await Bun.file(journal).exists()) {
						const pending = await readJsoncObject(journal)
						if (pending.oldName !== oldName || pending.newName !== newName)
							throw new ConfigError(`Finish the interrupted rename recorded in ${journal} first`)
						if (!(await this.exists(oldName)) && (await this.exists(newName))) {
							const config = await readGlobalConfig()
							if (config.defaultProfile === oldName)
								await atomicWrite(getGlobalConfig(), { ...config, defaultProfile: newName })
							await rm(journal)
							return
						}
						if (!(await this.exists(oldName)) || (await this.exists(newName)))
							throw new ConfigError(
								`Cannot recover profile rename automatically; inspect ${journal}`,
							)
						await rm(journal)
					}
					await this.get(oldName)
					try {
						await lstat(getProfileDir(newName))
						throw new ProfileExistsError(newName)
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
					}
					await assertNoInterruptedTransaction(getProfileDir(oldName))
					const config = await readGlobalConfig()
					await atomicWrite(journal, { oldName, newName })
					await rename(getProfileDir(oldName), getProfileDir(newName))
					try {
						if (config.defaultProfile === oldName)
							await atomicWrite(getGlobalConfig(), { ...config, defaultProfile: newName })
					} catch (error) {
						await rename(getProfileDir(newName), getProfileDir(oldName))
						await rm(journal)
						throw error
					}
					await rm(journal)
				}),
			),
		)
		return { warnActiveProfile: process.env.OCX_PROFILE === oldName }
	}
	async resolveProfile(override?: string): Promise<string> {
		const name = override ?? process.env.OCX_PROFILE ?? (await readGlobalConfig()).defaultProfile
		if (name === undefined)
			throw new ConfigError(
				"Select a profile with --profile, OCX_PROFILE, or 'ocx profile use <name>'. Create one with 'ocx profile add <name>'.",
			)
		profileNameSchema.parse(name)
		if (!(await this.exists(name))) throw new ProfileNotFoundError(name)
		return name
	}
	async initialize(): Promise<void> {
		await withInstallLock(getGlobalOcxRoot(), async () => {
			if (!(await this.exists("default"))) await this.add("default")
			if (!(await Bun.file(getGlobalConfig()).exists())) {
				await atomicWrite(getGlobalConfig(), { registries: {}, defaultProfile: "default" })
			}
		})
	}
	async setDefault(name?: string): Promise<void> {
		await withInstallLock(getGlobalOcxRoot(), async () => {
			const write = async () => {
				if (name !== undefined) await this.get(name)
				const config = await readGlobalConfig()
				await atomicWrite(getGlobalConfig(), { ...config, defaultProfile: name })
			}
			if (name === undefined) await write()
			else await withProfileLock(name, write)
		})
	}
}

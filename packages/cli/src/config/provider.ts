import { lstat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { ProfileManager } from "../profile/manager"
import { getGlobalOcxRoot, getProfileDir } from "../profile/paths"
import { ocxConfigSchema, type RegistryConfig } from "../schemas/config"
import { ConfigError, ConflictError } from "../utils/errors"
import { readGlobalConfig, readJsoncObject } from "./files"

export interface ConfigProvider {
	/** Configuration root; both files and receipts are relative to this directory. */
	readonly cwd: string
	getRegistries(): Record<string, RegistryConfig>
	getComponentPath(): string
	assertCurrent?(): Promise<void>
}

class FileConfigProvider implements ConfigProvider {
	constructor(
		readonly cwd: string,
		private readonly registries: Record<string, RegistryConfig>,
		readonly assertCurrent?: () => Promise<void>,
	) {}
	getRegistries(): Record<string, RegistryConfig> {
		return this.registries
	}
	getComponentPath(): string {
		return ""
	}
}

export const LocalConfigProvider = {
	async requireInitialized(cwd: string): Promise<ConfigProvider> {
		const root = join(resolve(cwd), ".opencode")
		const configPath = join(root, "ocx.jsonc")
		if (!(await Bun.file(configPath).exists()))
			throw new ConfigError("Run 'ocx init --project' in this project first.")
		const config = ocxConfigSchema.parse(await readJsoncObject(configPath))
		return new FileConfigProvider(root, config.registries)
	},
}

/** Global sources are used for browsing and creating profiles, never as an install target. */
export const GlobalConfigProvider = {
	async requireInitialized(): Promise<ConfigProvider> {
		return new FileConfigProvider(getGlobalOcxRoot(), (await readGlobalConfig()).registries)
	},
}

export interface DestinationOptions {
	profile?: string
	project?: boolean
	cwd?: string
}

export async function resolveDestination(options: DestinationOptions): Promise<ConfigProvider> {
	if ((options.profile !== undefined) === Boolean(options.project)) {
		throw new ConfigError("Choose exactly one destination: --profile <name> or --project.")
	}
	if (options.profile !== undefined) {
		const profile = await ProfileManager.create().get(options.profile)
		const root = getProfileDir(profile.name)
		const original = await lstat(root)
		return new FileConfigProvider(root, profile.ocx.registries, async () => {
			const current = await lstat(root)
			if (current.dev !== original.dev || current.ino !== original.ino)
				throw new ConflictError(
					`Profile "${profile.name}" changed while preparing the operation; retry it`,
				)
		})
	}
	return LocalConfigProvider.requireInitialized(options.cwd ?? process.cwd())
}

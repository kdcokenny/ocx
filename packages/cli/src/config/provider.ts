import { join, resolve } from "node:path"
import { ProfileManager } from "../profile/manager"
import { getGlobalOcxRoot, getProfileDir } from "../profile/paths"
import { ocxConfigSchema, type RegistryConfig } from "../schemas/config"
import { ConfigError } from "../utils/errors"
import { readGlobalConfig, readJsoncObject } from "./files"

export interface ConfigProvider {
	/** Configuration root; both files and receipts are relative to this directory. */
	readonly cwd: string
	getRegistries(): Record<string, RegistryConfig>
	getComponentPath(): string
}

class FileConfigProvider implements ConfigProvider {
	constructor(
		readonly cwd: string,
		private readonly registries: Record<string, RegistryConfig>,
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
		return new FileConfigProvider(getProfileDir(profile.name), profile.ocx.registries)
	}
	return LocalConfigProvider.requireInitialized(options.cwd ?? process.cwd())
}

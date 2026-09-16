import { dirname, join, resolve } from "node:path"
import { ProfileManager } from "../profile/manager"
import { getGlobalConfig, getProfileOcxConfig } from "../profile/paths"
import { ocxConfigSchema } from "../schemas/config"
import { ConfigError } from "../utils/errors"
import { withInstallLock } from "../utils/file-transaction"
import { readGlobalConfig, readJsoncObject } from "./files"

export interface ScopeOptions {
	global?: boolean
	profile?: string
	project?: boolean
	cwd?: string
}

export async function resolveMetadata(options: ScopeOptions) {
	const scopes =
		Number(Boolean(options.global)) +
		Number(options.profile !== undefined) +
		Number(Boolean(options.project))
	if (scopes !== 1)
		throw new ConfigError("Choose one scope: --global, --profile <name>, or --project.")
	if (options.profile !== undefined) {
		const profile = await ProfileManager.create().get(options.profile)
		return { path: getProfileOcxConfig(profile.name), config: profile.ocx }
	}
	if (options.global) return { path: getGlobalConfig(), config: await readGlobalConfig() }
	const path = join(resolve(options.cwd ?? process.cwd()), ".opencode", "ocx.jsonc")
	if (!(await Bun.file(path).exists())) throw new ConfigError("Run 'ocx init --project' first.")
	return { path, config: ocxConfigSchema.parse(await readJsoncObject(path)) }
}

export async function withMetadataLock<T>(
	options: ScopeOptions,
	operation: () => Promise<T>,
): Promise<T> {
	const target = await resolveMetadata(options)
	return withInstallLock(dirname(target.path), operation)
}

import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { string, type infer as ZodInfer } from "zod"

/**
 * Profile name validation schema.
 * - Must start with a letter
 * - Can contain alphanumeric, dots, underscores, hyphens
 * - 1-32 characters
 * Based on CCS variant-service.ts pattern.
 */
export const profileNameSchema = string()
	.min(1, "Profile name is required")
	.max(32, "Profile name must be 32 characters or less")
	.regex(
		/^[a-zA-Z][a-zA-Z0-9._-]*$/,
		"Profile name must start with a letter and contain only alphanumeric characters, dots, underscores, or hyphens",
	)
	.refine(
		(name) => !name.endsWith(".") && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name),
		"Profile name must be portable across supported platforms",
	)

export type ProfileName = ZodInfer<typeof profileNameSchema>

export interface GlobalPathResolutionOptions {
	xdgConfigHome?: string
	homeDir?: string
}

function configBase(options: GlobalPathResolutionOptions = {}): string {
	const xdg = options.xdgConfigHome ?? process.env.XDG_CONFIG_HOME
	return xdg && isAbsolute(xdg) ? xdg : join(options.homeDir ?? homedir(), ".config")
}

export function getGlobalOpencodeRoot(options?: GlobalPathResolutionOptions): string {
	return join(configBase(options), "opencode")
}
export function getGlobalOcxRoot(options?: GlobalPathResolutionOptions): string {
	return join(configBase(options), "ocx")
}
export function getProfilesDir(options?: GlobalPathResolutionOptions): string {
	return join(getGlobalOcxRoot(options), "profiles")
}
export function getProfileDir(name: string): string {
	return join(getProfilesDir(), profileNameSchema.parse(name))
}
export function getProfileOcxConfig(name: string): string {
	return join(getProfileDir(name), "ocx.jsonc")
}
export function getGlobalConfig(): string {
	return join(getGlobalOcxRoot(), "ocx.jsonc")
}

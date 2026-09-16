import { stat } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { getGlobalOcxRoot } from "../profile/paths"
import { validateFileTarget } from "../schemas/registry"
import { validatePath } from "./path-security"

export function getGlobalConfigPath(): string {
	return getGlobalOcxRoot()
}
export async function globalDirectoryExists(): Promise<boolean> {
	try {
		return (await stat(getGlobalConfigPath())).isDirectory()
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
		throw error
	}
}

/** Schema 3 targets are always relative to the selected configuration root. */
export function resolveTargetPath(
	target: string,
	isFlattened: boolean,
	installRoot = process.cwd(),
): string {
	validateFileTarget(target, "profile")
	const base = resolve(installRoot)
	const configRoot = isFlattened ? base : join(base, ".opencode")
	return relative(base, validatePath(configRoot, target)).replace(/\\/g, "/")
}

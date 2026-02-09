/**
 * Resolves `{env:VAR}` and `{file:path}` patterns in config strings.
 * Matches OpenCode's resolution behavior in its `load()` function.
 */

import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { ConfigError } from "./errors"

const ENV_VAR_PATTERN = /\{env:([^}]+)\}/g
const FILE_PATTERN = /\{file:[^}]+\}/g

/**
 * Replace all `{env:VAR}` patterns with their environment variable values.
 * Unset variables are replaced with empty string.
 */
export function resolveEnvVars(
	text: string,
	env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
	return text.replace(ENV_VAR_PATTERN, (_, varName: string) => env[varName] ?? "")
}

/** Resolve all `{env:VAR}` and `{file:path}` patterns in a serialized config string. */
export async function resolveConfigPatterns(text: string, configDir: string): Promise<string> {
	text = resolveEnvVars(text)
	return resolveFilePatterns(text, configDir)
}

/** Replace all `{file:path}` patterns with the referenced file contents. */
export async function resolveFilePatterns(text: string, configDir: string): Promise<string> {
	const fileMatches = text.match(FILE_PATTERN)
	if (!fileMatches) return text

	for (const match of fileMatches) {
		let filePath = match.replace(/^\{file:/, "").replace(/\}$/, "")
		if (filePath.startsWith("~/")) {
			filePath = join(homedir(), filePath.slice(2))
		}
		const resolvedPath = isAbsolute(filePath) ? filePath : resolve(configDir, filePath)

		let fileContent: string
		try {
			fileContent = (await Bun.file(resolvedPath).text()).trim()
		} catch (error) {
			const errMsg = `Bad file reference: "${match}"`
			if (error instanceof Error && "code" in error && error.code === "ENOENT") {
				throw new ConfigError(`${errMsg} — ${resolvedPath} does not exist`)
			}
			throw new ConfigError(errMsg)
		}

		text = text.replace(match, () => JSON.stringify(fileContent).slice(1, -1))
	}

	return text
}

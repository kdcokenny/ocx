/**
 * Resolves `{env:VAR}` patterns in a string, matching OpenCode's resolution behavior.
 */

const ENV_VAR_PATTERN = /\{env:([^}]+)\}/g

/**
 * Replace all `{env:VAR}` patterns in a string with their environment variable values.
 * Unset variables are replaced with empty string.
 */
export function resolveEnvVars(
	text: string,
	env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
	return text.replace(ENV_VAR_PATTERN, (_, varName: string) => env[varName] ?? "")
}

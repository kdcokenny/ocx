/**
 * Environment variable expansion for configuration values.
 *
 * Replaces ${VAR_NAME} patterns with process.env.VAR_NAME values.
 * Throws clear error if a referenced env var is missing (critical for auth headers).
 * Supports escaped syntax: \${VAR} → literal ${VAR} (not expanded).
 *
 * Examples:
 *   expandEnvVars("Bearer ${GITHUB_TOKEN}") → "Bearer abc" (if GITHUB_TOKEN=abc)
 *   expandEnvVars("${MISSING}") → throws error naming MISSING
 *   expandEnvVars("\\${VAR}") → "${VAR}" (literal, not expanded)
 */

/**
 * Expands ${VAR_NAME} patterns in a string with environment variable values.
 *
 * @param value - String potentially containing ${VAR_NAME} patterns
 * @returns String with all ${VAR_NAME} patterns replaced by env var values
 * @throws Error if a referenced env var is missing (names the specific variable)
 *
 * @example
 * process.env.GITHUB_TOKEN = "abc123"
 * expandEnvVars("Bearer ${GITHUB_TOKEN}") // → "Bearer abc123"
 *
 * @example
 * expandEnvVars("${MISSING_VAR}") // → throws: "Environment variable MISSING_VAR is not set"
 *
 * @example
 * expandEnvVars("\\${VAR}") // → "${VAR}" (escaped, not expanded)
 */
export function expandEnvVars(value: string): string {
	// First pass: handle escaped sequences \${VAR} → placeholder
	// Use a unique marker that won't appear in normal text
	const ESCAPED_MARKER = "\x00ESCAPED_BRACE_"
	const escapedMap = new Map<string, string>()
	let escapedIndex = 0

	// Replace \${ with placeholder to protect from expansion
	const protected_value = value.replace(/\\\$\{/g, () => {
		const marker = `${ESCAPED_MARKER}${escapedIndex}\x00`
		escapedMap.set(marker, "${")
		escapedIndex++
		return marker
	})

	// Second pass: expand ${VAR_NAME} patterns
	const varPattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
	let expanded = protected_value.replace(varPattern, (match, varName) => {
		const value = process.env[varName]
		if (value === undefined) {
			throw new Error(`Environment variable ${varName} is not set`)
		}
		return value
	})

	// Third pass: restore escaped sequences
	for (const [marker, original] of escapedMap) {
		expanded = expanded.replace(marker, original)
	}

	return expanded
}

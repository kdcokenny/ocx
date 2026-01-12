/**
 * Shell escaping utilities for cross-platform terminal commands.
 *
 * Provides safe escaping functions for Bash, Windows Batch, and AppleScript.
 * All functions validate input for forbidden characters before escaping.
 *
 * @module kdco-primitives/shell
 */

/**
 * Characters that cannot be safely escaped in any shell.
 * Null bytes (\x00) cannot be represented in C strings and must be rejected.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: Null byte detection is intentional for security
const SHELL_FORBIDDEN_CHARS = /[\x00]/

/**
 * Assert that a string is safe for shell escaping.
 *
 * Null bytes cannot be escaped in any shell and must be rejected outright.
 * This is the first line of defense before any escaping is attempted.
 *
 * @param value - String to validate
 * @param context - Description for error message (e.g., "Bash argument")
 * @throws {Error} if string contains forbidden characters
 *
 * @example
 * ```ts
 * assertShellSafe(userInput, "Bash argument")
 * // Throws: "Bash argument contains null bytes..."
 *
 * assertShellSafe(filePath, "Script path")
 * // Throws: "Script path contains null bytes..."
 * ```
 */
export function assertShellSafe(value: string, context: string): void {
	// Law 4: Fail Fast - reject invalid input immediately with clear message
	if (SHELL_FORBIDDEN_CHARS.test(value)) {
		throw new Error(
			`${context} contains null bytes which cannot be safely escaped for shell execution`,
		)
	}
}

/**
 * Escape a string for safe use in bash double-quoted strings.
 *
 * Handles all shell metacharacters including:
 * - Backslash (\), double quote ("), dollar ($), backtick (`)
 * - Exclamation mark (!) for history expansion
 * - Newlines and carriage returns (replaced with spaces)
 *
 * @param str - String to escape
 * @returns Escaped string safe for bash double-quoted context
 * @throws {Error} if string contains null bytes
 *
 * @example
 * ```ts
 * const path = '/home/user/my "project"'
 * const cmd = `cd "${escapeBash(path)}"`
 * // Result: cd "/home/user/my \"project\""
 *
 * const var = '$HOME/file'
 * const cmd = `echo "${escapeBash(var)}"`
 * // Result: echo "\$HOME/file"
 * ```
 */
export function escapeBash(str: string): string {
	assertShellSafe(str, "Bash argument")
	return str
		.replace(/\\/g, "\\\\") // Backslash first (order matters!)
		.replace(/"/g, '\\"') // Double quotes
		.replace(/\$/g, "\\$") // Dollar sign (variable expansion)
		.replace(/`/g, "\\`") // Backticks (command substitution)
		.replace(/!/g, "\\!") // History expansion
		.replace(/\n/g, " ") // Newlines -> spaces
		.replace(/\r/g, " ") // Carriage returns -> spaces
}

/**
 * Escape a string for safe use in AppleScript double-quoted strings.
 *
 * AppleScript uses different escaping rules than POSIX shells.
 * Only backslash and double quote need escaping.
 * Newlines are replaced with spaces (AppleScript doesn't support \n escapes).
 *
 * @param str - String to escape
 * @returns Escaped string safe for AppleScript double-quoted context
 * @throws {Error} if string contains null bytes
 *
 * @example
 * ```ts
 * const path = '/Users/name/my "project"'
 * const script = `tell application "Terminal" to write text "${escapeAppleScript(path)}"`
 * // Result: ... write text "/Users/name/my \"project\""
 * ```
 */
export function escapeAppleScript(str: string): string {
	assertShellSafe(str, "AppleScript argument")
	return str
		.replace(/\\/g, "\\\\") // Backslash
		.replace(/"/g, '\\"') // Double quotes
		.replace(/\n/g, " ") // Newlines -> spaces
		.replace(/\r/g, " ") // Carriage returns -> spaces
}

/**
 * Escape a string for safe use in Windows batch files.
 *
 * Handles batch metacharacters:
 * - Percent (%), caret (^), ampersand (&)
 * - Less than (<), greater than (>), pipe (|)
 *
 * @param str - String to escape
 * @returns Escaped string safe for batch file context
 * @throws {Error} if string contains null bytes
 *
 * @example
 * ```ts
 * const path = 'C:\\Users\\name\\project & files'
 * const cmd = `cd /d "${escapeBatch(path)}"`
 * // Result: cd /d "C:\Users\name\project ^& files"
 *
 * const var = '100%'
 * const cmd = `echo ${escapeBatch(var)}`
 * // Result: echo 100%%
 * ```
 */
export function escapeBatch(str: string): string {
	assertShellSafe(str, "Batch argument")
	return str
		.replace(/%/g, "%%") // Percent (double to escape)
		.replace(/\^/g, "^^") // Caret (escape character itself)
		.replace(/&/g, "^&") // Ampersand
		.replace(/</g, "^<") // Less than
		.replace(/>/g, "^>") // Greater than
		.replace(/\|/g, "^|") // Pipe
}

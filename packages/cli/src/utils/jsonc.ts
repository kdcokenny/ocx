/**
 * JSONC parsing utilities.
 */

import { type ParseError, printParseErrorCode } from "jsonc-parser"

/**
 * Format JSONC parse errors into a readable error message.
 * Returns a human-readable description of the first error.
 *
 * @param parseErrors - Array of ParseError from jsonc-parser
 * @returns Formatted error string
 */
export function formatJsoncParseError(parseErrors: ParseError[]): string {
	if (parseErrors.length === 0) {
		return "Unknown parse error"
	}

	const firstError = parseErrors[0]
	if (!firstError) {
		return "Unknown parse error"
	}

	return `${printParseErrorCode(firstError.error)} at offset ${firstError.offset}`
}

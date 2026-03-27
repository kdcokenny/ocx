/**
 * Validation Error Utilities
 *
 * Shared utilities for categorizing and displaying validation errors.
 */

export interface CategorizedErrors {
	file: string[]
	circular: string[]
	duplicate: string[]
}

export interface ValidationErrorSummary {
	valid: boolean
	totalErrors: number
	schemaErrors: number
	sourceFileErrors: number
	circularDependencyErrors: number
	duplicateTargetErrors: number
	otherErrors: number
}

/**
 * Categorize validation errors by type.
 *
 * @param errors - Array of validation error messages
 * @returns Object with categorized errors
 */
export function categorizeValidationErrors(errors: string[]): CategorizedErrors {
	return {
		file: errors.filter((e) => e.includes("Source file not found")),
		circular: errors.filter((e) => e.includes("Circular dependency")),
		duplicate: errors.filter((e) => e.includes("Duplicate target")),
	}
}

/**
 * Display categorized validation errors with headings.
 *
 * @param categorized - Categorized errors object
 * @param logFn - Function to output messages (defaults to console.log)
 */
export function displayCategorizedErrors(
	categorized: CategorizedErrors,
	logFn: (msg: string) => void = console.log,
): void {
	if (categorized.file.length > 0) {
		logFn("✗ Source files")
		for (const error of categorized.file) {
			logFn(`  ${error}`)
		}
	}

	if (categorized.circular.length > 0) {
		logFn("✗ Circular dependencies")
		for (const error of categorized.circular) {
			logFn(`  ${error}`)
		}
	}

	if (categorized.duplicate.length > 0) {
		logFn("✗ Duplicate targets")
		for (const error of categorized.duplicate) {
			logFn(`  ${error}`)
		}
	}
}

/**
 * Build a stable summary object for validation results.
 *
 * @param errors - Validation error messages
 * @param options - Optional overrides for explicit schema errors
 */
export function summarizeValidationErrors(
	errors: string[],
	options: { schemaErrors?: number } = {},
): ValidationErrorSummary {
	const categorized = categorizeValidationErrors(errors)
	const schemaErrors = options.schemaErrors ?? 0
	const totalErrors = errors.length
	const otherErrors = Math.max(
		0,
		totalErrors -
			schemaErrors -
			categorized.file.length -
			categorized.circular.length -
			categorized.duplicate.length,
	)

	return {
		valid: totalErrors === 0,
		totalErrors,
		schemaErrors,
		sourceFileErrors: categorized.file.length,
		circularDependencyErrors: categorized.circular.length,
		duplicateTargetErrors: categorized.duplicate.length,
		otherErrors,
	}
}

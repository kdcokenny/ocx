/**
 * Validation error factory functions for registry validation results.
 */

import {
	EXIT_CODES,
	NotFoundError,
	OCXError,
	ValidationFailedError,
	type ValidationFailureDetails,
} from "../utils/errors"
import { summarizeValidationErrors } from "../utils/validation-errors"
import type { LoadRegistryErrorKind } from "./validators"

/**
 * Create an appropriate error for a registry load failure.
 *
 * @param message - Error message describing the load failure
 * @param errorKind - Optional kind of load error (not_found or parse_error)
 * @returns An Error instance (NotFoundError or OCXError)
 */
export function createLoadValidationError(
	message: string,
	errorKind?: LoadRegistryErrorKind,
): Error {
	if (errorKind === "not_found") {
		return new NotFoundError(message)
	}

	if (errorKind === "parse_error") {
		return new OCXError(message, "CONFIG_ERROR", EXIT_CODES.CONFIG)
	}

	return new OCXError(message, "CONFIG_ERROR", EXIT_CODES.CONFIG)
}

/**
 * Create a ValidationFailedError with structured details.
 *
 * @param errors - Array of validation error messages
 * @param failureType - Whether errors are schema-level or rule-level
 * @returns A ValidationFailedError with summary details
 */
export function createValidationFailureError(
	errors: string[],
	failureType: "schema" | "rules",
): ValidationFailedError {
	const summary = summarizeValidationErrors(errors, {
		schemaErrors: failureType === "schema" ? errors.length : 0,
	})

	const details: ValidationFailureDetails = {
		valid: false,
		errors,
		summary: {
			valid: false,
			totalErrors: summary.totalErrors,
			schemaErrors: summary.schemaErrors,
			sourceFileErrors: summary.sourceFileErrors,
			circularDependencyErrors: summary.circularDependencyErrors,
			duplicateTargetErrors: summary.duplicateTargetErrors,
			otherErrors: summary.otherErrors,
		},
	}

	return new ValidationFailedError(details)
}

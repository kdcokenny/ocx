/**
 * Validate Command (for Registry Authors)
 *
 * Validates a registry source without building it.
 */

import { resolve } from "node:path"
import type { Command } from "commander"
import kleur from "kleur"
import {
	createLoadValidationError,
	createValidationFailureError,
} from "../lib/validation-errors-factory"
import { runCompleteValidation } from "../lib/validation-runner"
import { EXIT_CODES, OCXError } from "../utils/errors"
import { handleError } from "../utils/handle-error"
import { outputJson } from "../utils/json-output"
import { logger } from "../utils/logger"
import { summarizeValidationErrors } from "../utils/validation-errors"

interface ValidateOptions {
	cwd: string
	json: boolean
	quiet: boolean
	duplicateTargets: boolean
}

function outputValidationErrors(errors: string[]): void {
	for (const error of errors) {
		console.log(kleur.red(`  ${error}`))
	}
}

export function registerValidateCommand(program: Command): void {
	program
		.command("validate")
		.description("Validate a registry source (for registry authors)")
		.argument("[path]", "Registry source directory", ".")
		.option("--cwd <path>", "Working directory", process.cwd())
		.option("--json", "Output as JSON", false)
		.option("-q, --quiet", "Suppress output", false)
		.option("--no-duplicate-targets", "Skip duplicate target validation")
		.action(async (path: string, options: ValidateOptions) => {
			try {
				const sourcePath = resolve(options.cwd, path)

				const validationResult = await runCompleteValidation(sourcePath, {
					skipDuplicateTargets: options.duplicateTargets === false,
				})

				if (!validationResult.success) {
					const [firstError = "Registry validation failed"] = validationResult.errors

					if (validationResult.failureType === "load") {
						const loadError = createLoadValidationError(firstError, validationResult.loadErrorKind)
						if (!options.json && options.quiet) {
							const exitCode =
								loadError instanceof OCXError ? loadError.exitCode : EXIT_CODES.GENERAL
							process.exit(exitCode)
						}
						throw loadError
					}

					const validationError = createValidationFailureError(
						validationResult.errors,
						validationResult.failureType === "schema" ? "schema" : "rules",
					)

					if (options.json) {
						throw validationError
					}

					if (!options.quiet) {
						logger.error(validationError.message)
						outputValidationErrors(validationResult.errors)
					}

					process.exit(validationError.exitCode)
				}

				// All validations passed
				if (!options.quiet && !options.json) {
					logger.success("✓ Registry source is valid")
				}

				if (options.json) {
					outputJson({
						success: true,
						data: {
							valid: true,
							errors: [],
							summary: summarizeValidationErrors([]),
						},
					})
				}
			} catch (error) {
				if (!options.json && options.quiet) {
					const exitCode = error instanceof OCXError ? error.exitCode : EXIT_CODES.GENERAL
					process.exit(exitCode)
				}

				handleError(error, { json: options.json })
			}
		})
}

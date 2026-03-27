/**
 * Build Command (for Registry Authors)
 *
 * CLI wrapper around the buildRegistry library function.
 */

import { relative, resolve } from "node:path"
import type { Command } from "commander"
import kleur from "kleur"
import { BuildRegistryError, type BuildRegistryResult, buildRegistry } from "../lib/build-registry"
import { runCompleteValidation } from "../lib/validation-runner"
import type { LoadRegistryErrorKind } from "../lib/validators"
import { outputDryRun } from "../utils/dry-run"
import {
	EXIT_CODES,
	NotFoundError,
	OCXError,
	ValidationFailedError,
	type ValidationFailureDetails,
} from "../utils/errors"
import { handleError } from "../utils/handle-error"
import { outputJson } from "../utils/json-output"
import { logger } from "../utils/logger"
import { createSpinner } from "../utils/spinner"
import { categorizeValidationErrors, summarizeValidationErrors } from "../utils/validation-errors"

interface BuildOptions {
	cwd: string
	out: string
	json: boolean
	quiet: boolean
	dryRun?: boolean
	showValidation: boolean
}

function createLoadValidationError(message: string, errorKind?: LoadRegistryErrorKind): Error {
	if (errorKind === "not_found") {
		return new NotFoundError(message)
	}

	if (errorKind === "parse_error") {
		return new OCXError(message, "CONFIG_ERROR", EXIT_CODES.CONFIG)
	}

	return new OCXError(message, "CONFIG_ERROR", EXIT_CODES.CONFIG)
}

function createValidationFailureError(
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

function outputValidationFailures(errors: string[], failureType: "schema" | "rules"): void {
	if (failureType === "schema") {
		logger.error("✗ Registry schema")
		for (const error of errors) {
			console.log(kleur.red(`  ${error}`))
		}
		return
	}

	const categorized = categorizeValidationErrors(errors)

	if (categorized.file.length > 0) {
		logger.error("✗ Source files")
		for (const error of categorized.file) {
			console.log(kleur.red(`  ${error}`))
		}
	}

	if (categorized.circular.length > 0) {
		logger.error("✗ Circular dependencies")
		for (const error of categorized.circular) {
			console.log(kleur.red(`  ${error}`))
		}
	}

	if (categorized.duplicate.length > 0) {
		logger.error("✗ Duplicate targets")
		for (const error of categorized.duplicate) {
			console.log(kleur.red(`  ${error}`))
		}
	}
}

export function registerBuildCommand(program: Command): void {
	program
		.command("build")
		.description("Build a registry from source (for registry authors)")
		.argument("[path]", "Registry source directory", ".")
		.option("--out <dir>", "Output directory", "./dist")
		.option("--cwd <path>", "Working directory", process.cwd())
		.option("--json", "Output as JSON", false)
		.option("-q, --quiet", "Suppress output", false)
		.option("--dry-run", "Validate and show what would be built")
		.option("--show-validation", "Display validation results before building", false)
		.action(async (path: string, options: BuildOptions) => {
			try {
				const sourcePath = resolve(options.cwd, path)
				const outPath = resolve(options.cwd, options.out)

				if (options.showValidation) {
					const shouldDisplayValidation = !options.json && !options.quiet
					if (shouldDisplayValidation) {
						logger.info("Running validation checks...")
					}

					const validationResult = await runCompleteValidation(sourcePath, {
						skipDuplicateTargets: false,
					})

					if (!validationResult.success) {
						const [firstError = "Registry validation failed"] = validationResult.errors

						if (validationResult.failureType === "load") {
							throw createLoadValidationError(firstError, validationResult.loadErrorKind)
						}

						const failureType = validationResult.failureType === "schema" ? "schema" : "rules"
						const validationError = createValidationFailureError(
							validationResult.errors,
							failureType,
						)

						if (options.json) {
							throw validationError
						}

						if (!options.quiet) {
							outputValidationFailures(validationResult.errors, failureType)
						}

						process.exit(validationError.exitCode)
					}

					if (shouldDisplayValidation) {
						logger.success("✓ Schema compatibility and structure")
						logger.success("✓ Source files")
						logger.success("✓ No circular dependencies")
						logger.success("✓ No duplicate targets")
						console.log("")
					}
				}

				const spinner = createSpinner({
					text: "Building registry...",
					quiet: options.quiet || options.json,
				})
				if (!options.json) spinner.start()

				const result = await buildRegistry({
					source: sourcePath,
					out: outPath,
					dryRun: options.dryRun,
				})

				// Handle dry-run result
				if ("dryRun" in result && result.dryRun) {
					if (!options.json) spinner.stop()
					outputDryRun(result, { json: options.json, quiet: options.quiet })
					return
				}

				// Type narrowing: result is now BuildRegistryResult
				const buildResult = result as BuildRegistryResult

				if (!options.json) {
					const msg = `Built ${buildResult.componentsCount} components to ${relative(options.cwd, outPath)}`
					spinner.succeed(msg)
					if (process.env.NODE_ENV === "test" || !process.stdout.isTTY) {
						logger.success(`Built ${buildResult.componentsCount} components`)
					}
				}

				if (options.json) {
					outputJson({
						success: true,
						data: {
							components: buildResult.componentsCount,
							output: buildResult.outputPath,
						},
					})
				}
			} catch (error) {
				if (error instanceof BuildRegistryError) {
					if (options.json) {
						handleError(error, { json: true })
					}

					if (!options.quiet) {
						logger.error(error.message)
						for (const err of error.errors) {
							console.log(kleur.red(`  ${err}`))
						}
					}
					process.exit(1)
				}
				handleError(error, { json: options.json })
			}
		})
}

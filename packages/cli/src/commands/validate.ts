/**
 * Validate Command
 *
 * Validates a registry (local source or remote deployment)
 */

import { join } from "node:path"
import type { Command } from "commander"
import { validateRegistryLocal } from "../lib/validate-registry-local"
import { EXIT_CODES } from "../utils/errors"
import { handleError } from "../utils/handle-error"

interface ValidateOptions {
	cwd: string
	json: boolean
	quiet: boolean
	strict: boolean
	duplicateTargets: boolean
}

export function registerValidateCommand(program: Command): void {
	program
		.command("validate")
		.description("Validate a registry (local source or remote deployment)")
		.argument("<path-or-url>", "Registry path or URL")
		.option("--cwd <path>", "Working directory", process.cwd())
		.option("--strict", "Treat warnings as errors", false)
		.option("--no-duplicate-targets", "Treat duplicate targets as errors")
		.option("--json", "Output as JSON", false)
		.option("-q, --quiet", "Suppress output", false)
		.action(async (pathOrUrl: string, options: ValidateOptions) => {
			try {
				// Auto-detect local vs remote
				let isRemote = false
				try {
					new URL(pathOrUrl)
					isRemote = true
				} catch {
					// Not a URL, treat as local path
				}

				if (isRemote) {
					throw new Error("Remote validation not yet implemented")
				}

				const sourcePath = join(options.cwd, pathOrUrl)
				const result = await validateRegistryLocal(sourcePath)

				if (options.json) {
					console.log(JSON.stringify(result, null, 2))
				} else {
					// Human-readable output
					if (result.valid && result.warnings.length === 0) {
						console.log("✓ Valid registry")
					} else if (result.valid) {
						console.log(`✓ Valid registry (${result.warnings.length} warnings)`)
					} else {
						console.log(`✗ Invalid registry (${result.errors.length} errors)`)
						// Show error details
						for (const error of result.errors) {
							console.log(`  - ${error.type}: ${error.message}`)
						}
					}
				}

				// Determine exit code
				if (result.errors.length > 0) {
					process.exit(EXIT_CODES.GENERAL)
				}

				if (!options.duplicateTargets) {
					const hasDuplicates = result.warnings.some((w) => w.type === "duplicate_target")
					if (hasDuplicates) {
						process.exit(EXIT_CODES.GENERAL)
					}
				}

				if (options.strict && result.warnings.length > 0) {
					process.exit(EXIT_CODES.GENERAL)
				}

				// Success - don't call process.exit(), let the command complete normally
			} catch (error) {
				handleError(error)
			}
		})
}

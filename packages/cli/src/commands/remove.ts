/**
 * OCX CLI - remove command
 * Remove installed components
 */

import { realpathSync } from "node:fs"
import { rm } from "node:fs/promises"
import { sep } from "node:path"

import type { Command } from "commander"
import { LocalConfigProvider } from "../config/provider"
import { readReceipt, writeReceipt } from "../schemas/config"
import { resolveInstalledComponentRefs } from "../utils/component-ref-resolver"
import { type DryRunResult, outputDryRun } from "../utils/dry-run"
import { NotFoundError, ValidationError } from "../utils/errors"
import { handleError } from "../utils/handle-error"
import { logger } from "../utils/logger"
import { PathValidationError, validatePath } from "../utils/path-security"
import { checkFileIntegrity, parseCanonicalId } from "../utils/receipt"
import { addCommonOptions, addVerboseOption } from "../utils/shared-options"
import { createSpinner } from "../utils/spinner"

interface PreflightRemovalFile {
	path: string
	targetReal: string | null
}

export function resolvePreflightRemovalTarget(
	projectCwd: string,
	baseReal: string,
	relativePath: string,
): PreflightRemovalFile {
	const safePath = validatePath(projectCwd, relativePath)

	let targetReal: string
	try {
		targetReal = realpathSync(safePath)
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code
		if (code === "ENOENT" || code === "ENOTDIR") {
			return {
				path: relativePath,
				targetReal: null,
			}
		}
		if (code === "ELOOP") {
			throw new ValidationError(`Security violation: symlink loop detected at ${relativePath}`)
		}
		if (code === "EACCES" || code === "EPERM") {
			throw new ValidationError(`Security violation: cannot verify path ${relativePath}`)
		}
		throw error
	}

	if (targetReal === baseReal) {
		throw new ValidationError(
			`Security violation: cannot delete project root directory (${relativePath})`,
		)
	}

	if (!targetReal.startsWith(baseReal + sep)) {
		throw new ValidationError("Security violation: path escapes project directory")
	}

	return {
		path: relativePath,
		targetReal,
	}
}

export function resolveDeleteTimeRemovalTarget(
	projectCwd: string,
	baseReal: string,
	preflightFile: PreflightRemovalFile,
): string | null {
	const currentResolution = resolvePreflightRemovalTarget(projectCwd, baseReal, preflightFile.path)

	if (!preflightFile.targetReal) {
		if (currentResolution.targetReal) {
			throw new ValidationError(
				`Security violation: missing target reappeared during removal (${preflightFile.path})`,
			)
		}

		return null
	}

	if (!currentResolution.targetReal) {
		return null
	}

	if (currentResolution.targetReal !== preflightFile.targetReal) {
		throw new ValidationError(
			`Security violation: target changed during removal (${preflightFile.path})`,
		)
	}

	return currentResolution.targetReal
}

function deduplicateCanonicalIds(canonicalIds: string[]): string[] {
	const seen = new Set<string>()
	const uniqueCanonicalIds: string[] = []

	for (const canonicalId of canonicalIds) {
		if (seen.has(canonicalId)) {
			continue
		}

		seen.add(canonicalId)
		uniqueCanonicalIds.push(canonicalId)
	}

	return uniqueCanonicalIds
}

export interface RemoveOptions {
	cwd?: string
	quiet?: boolean
	verbose?: boolean
	json?: boolean
	force?: boolean
	dryRun?: boolean
}

export function registerRemoveCommand(program: Command): void {
	const cmd = program
		.command("remove")
		.description("Remove installed components")
		.argument("<components...>", "Component refs to remove (canonical ID or alias/component)")

	addCommonOptions(cmd)
	cmd.option("-f, --force", "Force removal even if files have been modified")
	addVerboseOption(cmd)

	cmd
		.option("--dry-run", "Show what would be removed without making changes")
		.action(async (components: string[], options: RemoveOptions) => {
			try {
				await runRemove(components, options)
			} catch (error) {
				handleError(error, { json: options.json })
			}
		})
}

async function runRemove(componentRefs: string[], options: RemoveOptions): Promise<void> {
	const cwd = options.cwd ?? process.cwd()
	const provider = await LocalConfigProvider.requireInitialized(cwd)

	// Guard: No components specified
	if (componentRefs.length === 0) {
		throw new ValidationError("No components specified. Specify at least one component ID.")
	}

	// V1: Read receipt
	const receipt = await readReceipt(provider.cwd)
	if (!receipt || Object.keys(receipt.installed).length === 0) {
		throw new NotFoundError("No components installed.")
	}

	const canonicalIds = deduplicateCanonicalIds(
		resolveInstalledComponentRefs(componentRefs, receipt),
	)

	const spin = options.quiet ? null : createSpinner({ text: "Removing components..." })
	spin?.start()

	const removed: string[] = []
	const notFound: string[] = []
	const toRemove: Array<{ canonicalId: string; files: PreflightRemovalFile[] }> = []
	const warnings: string[] = []
	let hasIntegrityIssues = false

	let baseReal: string
	try {
		baseReal = realpathSync(provider.cwd)
	} catch (_error: unknown) {
		throw new ValidationError("Cannot resolve project directory")
	}

	try {
		// First pass: validate all components and check integrity
		for (const canonicalId of canonicalIds) {
			// Guard: Component must exist in receipt
			const entry = receipt.installed[canonicalId]
			if (!entry) {
				throw new Error(`Resolved component '${canonicalId}' was not found in receipt.`)
			}

			// Preflight validation: validate all file paths before any deletion
			const preflightFiles: PreflightRemovalFile[] = []
			for (const fileEntry of entry.files) {
				// Guard: Empty or "." paths are rejected (Law 1: Early Exit)
				if (!fileEntry.path || fileEntry.path === ".") {
					throw new ValidationError(
						`Invalid file path in receipt for '${canonicalId}': path cannot be empty or "."`,
					)
				}

				// Validate path structure and containment checks (same checks as deletion phase)
				try {
					preflightFiles.push(resolvePreflightRemovalTarget(provider.cwd, baseReal, fileEntry.path))
				} catch (error) {
					if (error instanceof PathValidationError) {
						throw new ValidationError(
							`Security violation in receipt for '${canonicalId}': ${error.message}`,
						)
					}
					throw error
				}
			}

			// Check file integrity before removal
			const integrity = await checkFileIntegrity(provider.cwd, entry)
			if (!integrity.intact) {
				hasIntegrityIssues = true
				const modifiedFiles = integrity.modified.map((f) => `  - ${f}`).join("\n")

				if (options.force) {
					warnings.push(
						`Component '${canonicalId}' has been modified but will be force-removed:\n${modifiedFiles}`,
					)
				} else {
					warnings.push(
						`Component '${canonicalId}' has been modified. Use --force to remove anyway:\n${modifiedFiles}`,
					)
				}
			}

			// Collect files to remove
			toRemove.push({ canonicalId, files: preflightFiles })
		}

		// Handle dry-run mode
		if (options.dryRun) {
			spin?.stop()

			const dryRunResult: DryRunResult = {
				dryRun: true,
				command: "remove",
				wouldPerform: toRemove.flatMap(({ canonicalId, files }) =>
					files.map((fileEntry) => ({
						action: "delete" as const,
						target: fileEntry.path,
						details: { component: canonicalId },
					})),
				),
				validation: {
					passed: !hasIntegrityIssues || Boolean(options.force),
					warnings: warnings.length > 0 ? warnings : undefined,
				},
				summary: `${toRemove.length} component(s), ${toRemove.reduce((sum, item) => sum + item.files.length, 0)} file(s) would be removed`,
			}

			outputDryRun(dryRunResult, {
				json: options.json,
				quiet: options.quiet,
				hints:
					hasIntegrityIssues && !options.force
						? ["Add --force to remove modified files"]
						: undefined,
			})

			return
		}

		// Actual removal: fail fast if integrity issues and not forced
		if (hasIntegrityIssues && !options.force) {
			spin?.fail("File integrity check failed")

			// Law 1 (Early Exit): for...of with early break on first failure
			// Law 4 (Fail Loud): try/catch wraps checkFileIntegrity, throws ValidationError on failure
			let firstIssue:
				| { canonicalId: string; integrity: Awaited<ReturnType<typeof checkFileIntegrity>> }
				| undefined

			for (const item of toRemove) {
				const entry = receipt.installed[item.canonicalId]
				if (!entry) continue

				try {
					const integrity = await checkFileIntegrity(provider.cwd, entry)
					if (!integrity.intact) {
						firstIssue = { canonicalId: item.canonicalId, integrity }
						break // Early exit on first issue
					}
				} catch (error) {
					// EDGE CASE: checkFileIntegrity throws → abort removal with clear error
					throw new ValidationError(
						`Failed to check integrity for '${item.canonicalId}': ${error instanceof Error ? error.message : String(error)}`,
					)
				}
			}

			if (firstIssue) {
				// Include both modified AND missing files in error message
				const modifiedList =
					firstIssue.integrity.modified.length > 0
						? `Modified files:\n${firstIssue.integrity.modified.map((f) => `  - ${f}`).join("\n")}`
						: ""
				const missingList =
					firstIssue.integrity.missing.length > 0
						? `Missing files:\n${firstIssue.integrity.missing.map((f) => `  - ${f}`).join("\n")}`
						: ""
				const details = [modifiedList, missingList].filter(Boolean).join("\n")

				throw new ValidationError(
					`Component '${firstIssue.canonicalId}' has been modified. Use --force to remove anyway.\n${details}`,
				)
			}
		}

		// Second pass: actually remove files (preflight already validated all targets)
		for (const { canonicalId, files } of toRemove) {
			// Remove files
			for (const fileEntry of files) {
				const deleteTarget = resolveDeleteTimeRemovalTarget(provider.cwd, baseReal, fileEntry)

				if (!deleteTarget) {
					if (options.verbose) {
						logger.info(`  ⊘ Skipped ${fileEntry.path} (not found)`)
					}
					continue
				}

				await rm(deleteTarget, { force: true })
				if (options.verbose) {
					logger.info(`  ✓ Removed ${fileEntry.path}`)
				}
			}

			// Remove from receipt
			delete receipt.installed[canonicalId]
			removed.push(canonicalId)
		}

		// Save receipt first
		await writeReceipt(provider.cwd, receipt)

		// Only show success after write completes
		spin?.succeed(`Removed ${removed.length} component(s)`)

		// Output results
		if (options.json) {
			console.log(JSON.stringify({ success: true, removed, notFound }, null, 2))
		} else if (!options.quiet) {
			logger.info("")
			for (const id of removed) {
				const parsed = parseCanonicalId(id)
				logger.success(`✓ Removed ${parsed.registryName}/${parsed.name}@${parsed.revision}`)
			}

			logger.info("")
			logger.success(`Done! Removed ${removed.length} component(s).`)
		}
	} catch (error) {
		spin?.fail("Failed to remove components")
		throw error
	}
}

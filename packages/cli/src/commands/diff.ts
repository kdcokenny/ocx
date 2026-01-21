/**
 * Diff Command
 *
 * Compare installed components with upstream registry versions.
 */

import type { Command } from "commander"
import * as Diff from "diff"
import kleur from "kleur"
import { fetchComponent, fetchFileContent } from "../registry/fetcher"
import { readOcxConfig, readOcxLock } from "../schemas/config"
import { normalizeFile, parseQualifiedComponent } from "../schemas/registry"
import { handleError, logger, outputJson } from "../utils/index"

interface DiffOptions {
	cwd: string
	json: boolean
	quiet: boolean
}

export function registerDiffCommand(program: Command): void {
	program
		.command("diff")
		.description("Compare installed components with upstream")
		.argument("[component]", "Component to diff (optional, diffs all if omitted)")
		.option("--cwd <path>", "Working directory", process.cwd())
		.option("--json", "Output as JSON", false)
		.option("-q, --quiet", "Suppress output", false)
		.action(async (component: string | undefined, options: DiffOptions) => {
			try {
				const lock = await readOcxLock(options.cwd)
				if (!lock) {
					if (options.json) {
						outputJson({
							success: false,
							error: { code: "NOT_FOUND", message: "No ocx.lock found" },
						})
					} else {
						logger.warn("No ocx.lock found. Run 'ocx add' first.")
					}
					return
				}

				const config = await readOcxConfig(options.cwd)
				if (!config) {
					if (options.json) {
						outputJson({
							success: false,
							error: { code: "NOT_FOUND", message: "No ocx.jsonc found" },
						})
					} else {
						logger.warn("No ocx.jsonc found. Run 'ocx init' first.")
					}
					return
				}

				const componentNames = component ? [component] : Object.keys(lock.installed)

				if (componentNames.length === 0) {
					if (options.json) {
						outputJson({ success: true, data: { diffs: [] } })
					} else {
						logger.info("No components installed.")
					}
					return
				}

				const results: Array<{ name: string; hasChanges: boolean; diff?: string }> = []

				for (const name of componentNames) {
					const installed = lock.installed[name]
					if (!installed) {
						if (component) {
							logger.warn(`Component '${name}' not found in lockfile.`)
						}
						continue
					}

					// Guard: check if files array exists and has items
					if (!installed.files || installed.files.length === 0) {
						logger.warn(`No files recorded for component '${name}'`)
						continue
					}

					// Read local file (use first file from the files array)
					const localPath = `${options.cwd}/${installed.files[0]}`
					const localFile = Bun.file(localPath)
					if (!(await localFile.exists())) {
						results.push({ name, hasChanges: true, diff: "Local file missing" })
						continue
					}
					const localContent = await localFile.text()

					// Fetch upstream
					const registryConfig = config.registries[installed.registry]
					if (!registryConfig) {
						logger.warn(`Registry '${installed.registry}' not configured for component '${name}'.`)
						continue
					}

					try {
						// Parse qualified name to get just the component name for fetching
						const parsed = parseQualifiedComponent(name)
						const componentName = parsed.component
						const upstream = await fetchComponent(registryConfig.url, componentName)

						// Assume first file for simplicity in this MVP
						// In a full implementation we'd diff all files in the component
						const rawUpstreamFile = upstream.files[0]
						if (!rawUpstreamFile) {
							results.push({ name, hasChanges: false })
							continue
						}
						const upstreamFile = normalizeFile(rawUpstreamFile)

						// Fetch actual content from registry
						const upstreamContent = await fetchFileContent(
							registryConfig.url,
							componentName,
							upstreamFile.path,
						)

						if (localContent === upstreamContent) {
							results.push({ name, hasChanges: false })
						} else {
							const patch = Diff.createPatch(name, upstreamContent, localContent)
							results.push({ name, hasChanges: true, diff: patch })
						}
					} catch (err) {
						logger.warn(`Could not fetch upstream for ${name}: ${String(err)}`)
					}
				}

				if (options.json) {
					outputJson({ success: true, data: { diffs: results } })
				} else {
					for (const res of results) {
						if (res.hasChanges) {
							console.log(kleur.yellow(`\nDiff for ${res.name}:`))
							console.log(res.diff || "Changes detected (no diff available)")
						} else if (!options.quiet) {
							logger.success(`${res.name}: No changes`)
						}
					}
				}
			} catch (error) {
				handleError(error, { json: options.json })
			}
		})
}

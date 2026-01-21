/**
 * Build Command (for Registry Authors)
 *
 * CLI wrapper around the buildRegistry library function.
 */

import { join, relative } from "node:path"
import type { Command } from "commander"
import kleur from "kleur"
import { BuildRegistryError, buildRegistry } from "../lib/build-registry"
import { createSpinner, handleError, logger, outputJson } from "../utils/index"

interface BuildOptions {
	cwd: string
	out: string
	json: boolean
	quiet: boolean
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
		.action(async (path: string, options: BuildOptions) => {
			try {
				const sourcePath = join(options.cwd, path)
				const outPath = join(options.cwd, options.out)

				const spinner = createSpinner({
					text: "Building registry...",
					quiet: options.quiet || options.json,
				})
				if (!options.json) spinner.start()

				const result = await buildRegistry({
					source: sourcePath,
					out: outPath,
				})

				if (!options.json) {
					const msg = `Built ${result.componentsCount} components to ${relative(options.cwd, outPath)}`
					spinner.succeed(msg)
					if (process.env.NODE_ENV === "test" || !process.stdout.isTTY) {
						logger.success(`Built ${result.componentsCount} components`)
					}
				}

				if (options.json) {
					outputJson({
						success: true,
						data: {
							name: result.name,
							version: result.version,
							components: result.componentsCount,
							output: result.outputPath,
						},
					})
				}
			} catch (error) {
				if (error instanceof BuildRegistryError) {
					if (!options.json) {
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

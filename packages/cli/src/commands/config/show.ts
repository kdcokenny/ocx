/**
 * Config Show Command
 *
 * Display the resolved configuration for the current directory.
 * Uses ConfigResolver with registry isolation (profile OR local, not merged).
 * OpenCode config and instructions are additively merged when not excluded.
 */

import type { Command } from "commander"
import kleur from "kleur"
import { ConfigResolver } from "../../config/resolver"
import { handleError } from "../../utils/handle-error"
import { sharedOptions } from "../../utils/shared-options"

interface ConfigShowOptions {
	json?: boolean
	origin?: boolean
	profile?: string
}

export function registerConfigShowCommand(parent: Command): void {
	parent
		.command("show")
		.description("Display resolved configuration for current directory")
		.addOption(sharedOptions.json())
		.option("--origin", "Show where each setting came from")
		.option("-p, --profile <name>", "Use specific profile")
		.action(async (options: ConfigShowOptions) => {
			try {
				await runConfigShow(options)
			} catch (error) {
				handleError(error, { json: options.json })
			}
		})
}

async function runConfigShow(options: ConfigShowOptions): Promise<void> {
	const resolver = await ConfigResolver.create(process.cwd(), { profile: options.profile })

	if (options.origin) {
		const configWithOrigin = resolver.resolveWithOrigin()

		if (options.json) {
			// Convert Map to object for JSON serialization
			const originsObj: Record<string, { path: string; source: string }> = {}
			for (const [key, value] of configWithOrigin.origins) {
				originsObj[key] = value
			}
			console.log(
				JSON.stringify(
					{
						...configWithOrigin,
						origins: originsObj,
					},
					null,
					2,
				),
			)
			return
		}

		// Human-readable output with origin annotations
		console.log(kleur.bold("Resolved Configuration"))
		console.log()

		if (configWithOrigin.profileName) {
			const origin = configWithOrigin.origins.get("profileName")
			console.log(`${kleur.cyan("Profile:")} ${configWithOrigin.profileName}`)
			if (origin) {
				console.log(`  ${kleur.dim(`← ${origin.source}`)}`)
			}
		}

		console.log()
		console.log(kleur.cyan("Component Path:"), configWithOrigin.componentPath)
		const componentPathOrigin = configWithOrigin.origins.get("componentPath")
		if (componentPathOrigin) {
			console.log(`  ${kleur.dim(`← ${componentPathOrigin.source} (${componentPathOrigin.path})`)}`)
		}

		console.log()
		console.log(kleur.cyan("Registries:"))
		for (const [name, config] of Object.entries(configWithOrigin.registries)) {
			console.log(`  ${kleur.green(name)}: ${config.url}`)
			const regOrigin = configWithOrigin.origins.get(`registries.${name}`)
			if (regOrigin) {
				console.log(`    ${kleur.dim(`← ${regOrigin.source} (${regOrigin.path})`)}`)
			}
		}

		if (configWithOrigin.instructions.length > 0) {
			console.log()
			console.log(kleur.cyan("Instructions:"))
			for (const instruction of configWithOrigin.instructions) {
				console.log(`  ${instruction}`)
			}
		}

		if (Object.keys(configWithOrigin.opencode).length > 0) {
			console.log()
			console.log(kleur.cyan("OpenCode Config:"))
			for (const key of Object.keys(configWithOrigin.opencode)) {
				const keyOrigin = configWithOrigin.origins.get(`opencode.${key}`)
				console.log(`  ${key}:`, JSON.stringify(configWithOrigin.opencode[key]))
				if (keyOrigin) {
					console.log(`    ${kleur.dim(`← ${keyOrigin.source} (${keyOrigin.path})`)}`)
				}
			}
		}
		return
	}

	// Standard output (no origin tracking)
	const config = resolver.resolve()

	if (options.json) {
		console.log(JSON.stringify(config, null, 2))
		return
	}

	// Human-readable output
	console.log(kleur.bold("Resolved Configuration"))
	console.log()

	if (config.profileName) {
		console.log(`${kleur.cyan("Profile:")} ${config.profileName}`)
	}

	console.log(`${kleur.cyan("Component Path:")} ${config.componentPath}`)

	console.log()
	console.log(kleur.cyan("Registries:"))
	if (Object.keys(config.registries).length === 0) {
		console.log("  (none)")
	} else {
		for (const [name, regConfig] of Object.entries(config.registries)) {
			console.log(`  ${kleur.green(name)}: ${regConfig.url}`)
		}
	}

	if (config.instructions.length > 0) {
		console.log()
		console.log(kleur.cyan("Instructions:"))
		for (const instruction of config.instructions) {
			console.log(`  ${instruction}`)
		}
	}
}

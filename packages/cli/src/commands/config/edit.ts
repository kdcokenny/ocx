/**
 * Config Edit Command
 *
 * Open configuration file in the user's preferred editor.
 * --global: edit global ocx.jsonc
 * default: edit local .opencode/ocx.jsonc
 */

import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { Command } from "commander"
import {
	findLocalConfigDir,
	getGlobalConfig,
	LOCAL_CONFIG_DIR,
	OCX_CONFIG_FILE,
} from "../../profile/paths"
import { ConfigError } from "../../utils/errors"
import { handleError, logger } from "../../utils/index"

interface ConfigEditOptions {
	global?: boolean
}

export function registerConfigEditCommand(parent: Command): void {
	parent
		.command("edit")
		.description("Open configuration file in editor")
		.option("-g, --global", "Edit global ocx.jsonc")
		.action(async (options: ConfigEditOptions) => {
			try {
				await runConfigEdit(options)
			} catch (error) {
				handleError(error)
			}
		})
}

async function runConfigEdit(options: ConfigEditOptions): Promise<void> {
	let configPath: string

	if (options.global) {
		// Edit global config
		configPath = getGlobalConfig()
		if (!existsSync(configPath)) {
			throw new ConfigError(
				`Global config not found at ${configPath}.\n` +
					"Run 'opencode' once to initialize, then retry.",
			)
		}
	} else {
		// Edit local config
		const localConfigDir = findLocalConfigDir(process.cwd())
		if (localConfigDir) {
			configPath = join(localConfigDir, OCX_CONFIG_FILE)
		} else {
			// Create .opencode directory if it doesn't exist
			const newConfigDir = join(process.cwd(), LOCAL_CONFIG_DIR)
			await mkdir(newConfigDir, { recursive: true })
			configPath = join(newConfigDir, OCX_CONFIG_FILE)

			// Create empty config file if it doesn't exist
			if (!existsSync(configPath)) {
				const defaultConfig = {
					$schema: "https://ocx.kdco.dev/schemas/ocx.json",
					registries: {},
				}
				await Bun.write(configPath, JSON.stringify(defaultConfig, null, 2))
				logger.info(`Created ${configPath}`)
			}
		}
	}

	const editor = process.env.EDITOR || process.env.VISUAL || "vi"

	const proc = Bun.spawn([editor, configPath], {
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	})

	const exitCode = await proc.exited
	if (exitCode !== 0) {
		throw new Error(`Editor exited with code ${exitCode}`)
	}
}

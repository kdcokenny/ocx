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
import { ProfileManager } from "../../profile/manager"
import {
	findLocalConfigDir,
	getGlobalConfig,
	getProfileOcxConfig,
	LOCAL_CONFIG_DIR,
	OCX_CONFIG_FILE,
} from "../../profile/paths"
import { profileNameSchema } from "../../profile/schema"
import { ConfigError, ProfileNotFoundError, ValidationError } from "../../utils/errors"
import { handleError } from "../../utils/handle-error"
import { logger } from "../../utils/logger"

interface ConfigEditOptions {
	global?: boolean
	profile?: string
}

export function registerConfigEditCommand(parent: Command): void {
	parent
		.command("edit")
		.description("Open configuration file in editor")
		.option("-g, --global", "Edit global ocx.jsonc")
		.option("-p, --profile <name>", "Edit specific profile's config")
		.action(async (options: ConfigEditOptions) => {
			try {
				await runConfigEdit(options)
			} catch (error) {
				handleError(error)
			}
		})
}

async function runConfigEdit(options: ConfigEditOptions): Promise<void> {
	// Guard: mutual exclusivity
	if (options.global && options.profile) {
		throw new ValidationError("Cannot use both --global and --profile flags")
	}

	let configPath: string

	if (options.profile) {
		// Validate profile name first (prevents path traversal)
		const parseResult = profileNameSchema.safeParse(options.profile)
		if (!parseResult.success) {
			throw new ValidationError(
				`Invalid profile name "${options.profile}": ${parseResult.error.errors[0]?.message ?? "Invalid name"}`,
			)
		}

		// Check profiles are initialized
		await ProfileManager.requireInitialized()

		// Edit profile config
		const manager = ProfileManager.create()
		if (!(await manager.exists(options.profile))) {
			throw new ProfileNotFoundError(options.profile)
		}
		configPath = getProfileOcxConfig(options.profile)
	} else if (options.global) {
		// Edit global config
		configPath = getGlobalConfig()
		if (!existsSync(configPath)) {
			throw new ConfigError(
				`Global config not found at ${configPath}.\nRun 'ocx init --global' first.`,
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

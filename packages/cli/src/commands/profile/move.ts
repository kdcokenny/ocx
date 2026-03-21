/**
 * Profile Move Command
 *
 * Move (rename) a profile atomically.
 * Profiles are global-only; local scope is unsupported and produces a hard error.
 * Uses Cargo-style CLI pattern: no interactive confirmation.
 */

import type { Command } from "commander"
import { ProfileManager } from "../../profile/manager"
import { ConfigError } from "../../utils/errors"
import { handleError } from "../../utils/handle-error"
import { outputJson } from "../../utils/json-output"
import { logger } from "../../utils/logger"

interface MoveOptions {
	global?: boolean
	json?: boolean
}

export function registerProfileMoveCommand(parent: Command): void {
	parent
		.command("move <old-name> <new-name>")
		.alias("mv")
		.description("Move (rename) a profile (use --global; local profiles are unsupported)")
		.option("-g, --global", "Move global profile (required — local profiles are unsupported)")
		.option("--json", "Output as JSON")
		.action(async (oldName: string, newName: string, options: MoveOptions) => {
			try {
				const result = await runProfileMove(oldName, newName, options)
				if (options.json) {
					outputJson({ success: true, data: result })
				}
			} catch (error) {
				handleError(error, { json: options.json })
			}
		})
}

async function runProfileMove(
	oldName: string,
	newName: string,
	options: MoveOptions,
): Promise<{ from: string; to: string; scope: "global"; warnActiveProfile: boolean }> {
	// Guard: local scope is unsupported (Law 1: Early Exit, Law 4: Fail Fast)
	if (!options.global) {
		throw new ConfigError(
			"Local profiles are unsupported. Use --global to move a global profile.\n\n" +
				`  ocx profile move ${oldName} ${newName} --global`,
		)
	}

	const manager = await ProfileManager.requireInitialized()

	const { warnActiveProfile } = await manager.move(oldName, newName)

	if (warnActiveProfile && !options.json) {
		logger.warn(`Moving active profile. Update OCX_PROFILE env var to "${newName}".`)
	}

	if (!options.json) {
		logger.success(`Moved global profile "${oldName}" → "${newName}"`)
	}

	return { from: oldName, to: newName, scope: "global", warnActiveProfile }
}

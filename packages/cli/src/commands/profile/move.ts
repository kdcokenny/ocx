/**
 * Profile Move Command
 *
 * Move (rename) a global profile atomically.
 * Uses Cargo-style CLI pattern: no interactive confirmation.
 */

import type { Command } from "commander"
import { ProfileManager } from "../../profile/manager"
import { handleError, logger } from "../../utils/index"

export function registerProfileMoveCommand(parent: Command): void {
	parent
		.command("move <old-name> <new-name>")
		.alias("mv")
		.description("Move (rename) a profile")
		.action(async (oldName: string, newName: string) => {
			try {
				await runProfileMove(oldName, newName)
			} catch (error) {
				handleError(error)
			}
		})
}

async function runProfileMove(oldName: string, newName: string): Promise<void> {
	const manager = await ProfileManager.requireInitialized()

	const { warnActiveProfile } = await manager.move(oldName, newName)

	if (warnActiveProfile) {
		logger.warn(`Moving active profile. Update OCX_PROFILE env var to "${newName}".`)
	}

	logger.success(`Moved profile "${oldName}" → "${newName}"`)
}

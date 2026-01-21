/**
 * Profile List Command
 *
 * List all available global profiles.
 */

import type { Command } from "commander"
import { ProfileManager } from "../../profile/manager"
import { handleError } from "../../utils/handle-error"
import { sharedOptions } from "../../utils/shared-options"

interface ProfileListOptions {
	json?: boolean
}

export function registerProfileListCommand(parent: Command): void {
	parent
		.command("list")
		.alias("ls")
		.description("List all global profiles")
		.addOption(sharedOptions.json())
		.action(async (options: ProfileListOptions) => {
			try {
				await runProfileList(options)
			} catch (error) {
				handleError(error, { json: options.json })
			}
		})
}

async function runProfileList(options: ProfileListOptions): Promise<void> {
	const manager = await ProfileManager.requireInitialized()

	const profiles = await manager.list()

	if (options.json) {
		console.log(JSON.stringify({ profiles, initialized: true }, null, 2))
		return
	}

	// Guard: Handle empty profiles list
	if (profiles.length === 0) {
		console.log("No profiles found. Run 'ocx profile add <name>' to create one.")
		return
	}

	// Display profiles
	console.log("Global profiles:")
	for (const name of profiles) {
		console.log(`  ${name}`)
	}
}

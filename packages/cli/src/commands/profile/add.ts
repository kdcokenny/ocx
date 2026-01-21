/**
 * Profile Add Command
 *
 * Create a new global profile.
 * Optionally clone settings from an existing profile.
 */

import type { Command } from "commander"
import { atomicWrite } from "../../profile/atomic"
import { ProfileManager } from "../../profile/manager"
import { getProfileOcxConfig } from "../../profile/paths"
import { handleError, logger } from "../../utils/index"

interface ProfileAddOptions {
	from?: string
}

export function registerProfileAddCommand(parent: Command): void {
	parent
		.command("add <name>")
		.description("Create a new global profile")
		.option("--from <profile>", "Clone settings from existing profile")
		.action(async (name: string, options: ProfileAddOptions) => {
			try {
				await runProfileAdd(name, options)
			} catch (error) {
				handleError(error)
			}
		})
}

async function runProfileAdd(name: string, options: ProfileAddOptions): Promise<void> {
	const manager = await ProfileManager.requireInitialized()

	if (options.from) {
		// Clone from existing profile
		const source = await manager.get(options.from)
		await manager.add(name)

		// Copy OCX config from source
		await atomicWrite(getProfileOcxConfig(name), source.ocx)

		logger.success(`Created profile "${name}" (cloned from "${options.from}")`)
	} else {
		await manager.add(name)
		logger.success(`Created profile "${name}"`)
	}
}

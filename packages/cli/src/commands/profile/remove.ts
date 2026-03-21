/**
 * Profile Remove Command
 *
 * Delete a profile.
 * Profiles are global-only; local scope is unsupported and produces a hard error.
 * Uses Cargo-style CLI pattern: no interactive confirmation.
 */

import type { Command } from "commander"
import { ProfileManager } from "../../profile/manager"
import { ConfigError, ProfileNotFoundError } from "../../utils/errors"
import { handleError } from "../../utils/handle-error"
import { outputJson } from "../../utils/json-output"
import { logger } from "../../utils/logger"

interface RemoveOptions {
	global?: boolean
	json?: boolean
}

export function registerProfileRemoveCommand(parent: Command): void {
	parent
		.command("remove <name>")
		.alias("rm")
		.description("Delete a profile (use --global; local profiles are unsupported)")
		.option("-g, --global", "Remove global profile (required — local profiles are unsupported)")
		.option("--json", "Output as JSON")
		.action(async (name: string, options: RemoveOptions) => {
			try {
				const result = await runProfileRemove(name, options)
				if (options.json) {
					outputJson({ success: true, data: result })
				}
			} catch (error) {
				handleError(error, { json: options.json })
			}
		})
}

async function runProfileRemove(
	name: string,
	options: RemoveOptions,
): Promise<{ name: string; scope: "global" }> {
	// Guard: local scope is unsupported (Law 1: Early Exit, Law 4: Fail Fast)
	if (!options.global) {
		throw new ConfigError(
			"Local profiles are unsupported. Use --global to remove a global profile.\n\n" +
				"  ocx profile remove <name> --global",
		)
	}

	const manager = await ProfileManager.requireInitialized()

	// Verify profile exists first (fail fast)
	if (!(await manager.exists(name))) {
		throw new ProfileNotFoundError(name)
	}

	await manager.remove(name)
	if (!options.json) {
		logger.success(`Deleted global profile "${name}"`)
	}

	return { name, scope: "global" }
}

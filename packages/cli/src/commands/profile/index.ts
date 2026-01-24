/**
 * Profile Command Group
 *
 * Parent command for managing global profiles.
 * Profiles allow multiple named configurations for different contexts.
 *
 * Alias: `ocx p` (shorthand for `ocx profile`)
 */

import type { Command } from "commander"
import { registerProfileAddCommand } from "./add"
import { registerProfileListCommand } from "./list"
import { registerProfileMoveCommand } from "./move"
import { registerProfileRemoveCommand } from "./remove"
import { registerProfileShowCommand } from "./show"

/**
 * Register the profile command and all subcommands.
 */
export function registerProfileCommand(program: Command): void {
	const profile = program.command("profile").alias("p").description("Manage global profiles")

	registerProfileListCommand(profile)
	registerProfileAddCommand(profile)
	registerProfileRemoveCommand(profile)
	registerProfileMoveCommand(profile)
	registerProfileShowCommand(profile)
}

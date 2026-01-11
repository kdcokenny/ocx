/**
 * Ghost Command Group
 *
 * Parent command for all ghost mode operations.
 * Ghost mode allows OCX to work without project-local configuration,
 * using a global config at ~/.config/ocx/ghost.jsonc instead.
 *
 * Alias: `ocx g` (shorthand for `ocx ghost`)
 */

import type { Command } from "commander"
import { registerGhostAddCommand } from "./add.js"
import { registerGhostConfigCommand } from "./config.js"
import { registerGhostInitCommand } from "./init.js"
import { registerGhostOpenCodeCommand } from "./opencode.js"
import { registerGhostProfileCommand } from "./profile/index.js"
import { registerGhostRegistryCommand } from "./registry.js"
import { registerGhostSearchCommand } from "./search.js"

export function registerGhostCommand(program: Command): void {
	const ghost = program
		.command("ghost")
		.alias("g")
		.description("Ghost mode - work without local config files")

	// Register subcommands
	registerGhostInitCommand(ghost)
	registerGhostConfigCommand(ghost)
	registerGhostRegistryCommand(ghost)
	registerGhostAddCommand(ghost)
	registerGhostSearchCommand(ghost)
	registerGhostOpenCodeCommand(ghost)
	registerGhostProfileCommand(ghost)
}

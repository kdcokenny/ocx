/**
 * Ghost Command Group (TEMPORARY)
 *
 * Migration utilities for transitioning from ghost mode to unified profiles.
 * This entire directory will be removed in the next minor version.
 */

import type { Command } from "commander"
import { registerGhostMigrateCommand } from "./migrate"

/**
 * Register the ghost command and all subcommands.
 */
export function registerGhostCommand(program: Command): void {
	const ghost = program.command("ghost").description("[TEMPORARY] Ghost mode migration utilities")

	registerGhostMigrateCommand(ghost)
}

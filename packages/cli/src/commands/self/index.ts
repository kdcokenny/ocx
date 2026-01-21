/**
 * Self Command Group
 *
 * Parent command for OCX CLI self-management operations.
 * Provides commands for updating and managing the CLI itself.
 */

import type { Command } from "commander"
import { registerSelfUpdateCommand } from "./update"

export function registerSelfCommand(program: Command): void {
	const self = program.command("self").description("Manage the OCX CLI")

	// Register subcommands
	registerSelfUpdateCommand(self)
}

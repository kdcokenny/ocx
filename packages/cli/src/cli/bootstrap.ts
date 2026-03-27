import { Command } from "commander"
import { registerAddCommand } from "../commands/add"
import { registerBuildCommand } from "../commands/build"
import { registerConfigCommand } from "../commands/config/index"
import { registerInitCommand } from "../commands/init"
import { registerMigrateCommand } from "../commands/migrate/index"
import { registerOpencodeCommand } from "../commands/opencode"
import { registerProfileCommand } from "../commands/profile/index"
import { registerRegistryCommand } from "../commands/registry"
import { registerRemoveCommand } from "../commands/remove"
import { registerSearchCommand } from "../commands/search"
import { registerSelfCommand } from "../commands/self/index"
import { registerUpdateCommand } from "../commands/update"
import { registerValidateCommand } from "../commands/validate"
import { registerVerifyCommand } from "../commands/verify"
import { registerUpdateCheckHook } from "../self-update/hook"

declare const __VERSION__: string

const version = typeof __VERSION__ !== "undefined" ? __VERSION__ : "0.0.0-dev"

export async function runCli(argv: string[] = process.argv): Promise<void> {
	const program = new Command()
		.name("ocx")
		.description("OpenCode Extensions - Install agents, skills, plugins, and commands")
		.version(version)

	registerInitCommand(program)
	registerAddCommand(program)
	registerUpdateCommand(program)
	registerSearchCommand(program)
	registerRegistryCommand(program)
	registerBuildCommand(program)
	registerValidateCommand(program)
	registerSelfCommand(program)

	// V2: Receipt-based component management
	registerVerifyCommand(program)
	registerRemoveCommand(program)

	// Migration
	registerMigrateCommand(program)

	// New top-level commands (Phase 5)
	registerProfileCommand(program)
	registerConfigCommand(program)
	registerOpencodeCommand(program)

	// Register update check hook (runs after each command)
	registerUpdateCheckHook(program)

	await program.parseAsync(argv)
}

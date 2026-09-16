import type { Command } from "commander"
import { resolveDestination } from "../config/provider"
import { removeComponents } from "../registry/install"
import { handleError } from "../utils/handle-error"
import { addCommonOptions, addVerboseOption } from "../utils/shared-options"
import { outputInstallation } from "./installation-output"

export interface RemoveOptions {
	profile?: string
	project?: boolean
	cwd?: string
	force?: boolean
	dryRun?: boolean
	quiet?: boolean
	verbose?: boolean
	json?: boolean
}
export function registerRemoveCommand(program: Command): void {
	const command = program
		.command("remove <components...>")
		.alias("rm")
		.description("Remove owned component files")
		.option("-p, --profile <name>", "Remove profile files")
		.option("--project", "Remove project files")
		.option("-f, --force", "Delete edited owned files")
		.option("--dry-run", "Preview without deleting files")
	addCommonOptions(command)
	addVerboseOption(command)
	command.action(async (references: string[], options: RemoveOptions) => {
		try {
			const provider = await resolveDestination(options)
			outputInstallation("remove", await removeComponents(references, provider, options), options)
		} catch (error) {
			handleError(error, { json: options.json })
		}
	})
}

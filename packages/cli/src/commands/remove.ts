import type { Command } from "commander"
import { resolveDestination } from "../config/provider"
import { removeComponents } from "../registry/install"
import { readReceipt } from "../schemas/config"
import { resolveInstalledComponentRefs } from "../utils/component-ref-resolver"
import { NotFoundError } from "../utils/errors"
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
		.option("--force", "Delete edited owned files")
		.option("--dry-run", "Preview without deleting files")
	addCommonOptions(command)
	addVerboseOption(command)
	command.action(async (references: string[], options: RemoveOptions) => {
		try {
			const provider = await resolveDestination(options)
			const receipt = await readReceipt(provider.cwd)
			if (!receipt) throw new NotFoundError("No components installed")
			const components = resolveInstalledComponentRefs(references, receipt).map((id) => {
				const entry = receipt.installed[id]
				if (!entry) throw new NotFoundError(`Component ${id} is not installed`)
				return `${entry.registryName}/${entry.name}`
			})
			outputInstallation("remove", await removeComponents(components, provider, options), options)
		} catch (error) {
			handleError(error, { json: options.json })
		}
	})
}

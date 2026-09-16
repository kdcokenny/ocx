import type { Command } from "commander"
import { type ConfigProvider, resolveDestination } from "../config/provider"
import { installComponents } from "../registry/install"
import { readReceipt } from "../schemas/config"
import { resolveInstalledComponentRefs } from "../utils/component-ref-resolver"
import { NotFoundError, ValidationError } from "../utils/errors"
import { handleError } from "../utils/handle-error"
import { addCommonOptions, addVerboseOption } from "../utils/shared-options"
import { outputInstallation } from "./installation-output"

export interface UpdateOptions {
	all?: boolean
	registry?: string
	profile?: string
	project?: boolean
	cwd?: string
	force?: boolean
	dryRun?: boolean
	quiet?: boolean
	verbose?: boolean
	json?: boolean
}
export function registerUpdateCommand(program: Command): void {
	const command = program
		.command("update [components...]")
		.description("Update complete owned file sets and their dependencies")
		.option("--all", "Update all installed components")
		.option("--registry <alias>", "Update components installed from a registry")
		.option("-p, --profile <name>", "Update profile files")
		.option("--project", "Update project files")
		.option("--force", "Replace edited or missing owned files")
		.option("--dry-run", "Preview the complete change without writing")
	addCommonOptions(command)
	addVerboseOption(command)
	command.action(async (references: string[], options: UpdateOptions) => {
		try {
			await runUpdateCore(references, options, await resolveDestination(options))
		} catch (error) {
			handleError(error, { json: options.json })
		}
	})
}
export async function runUpdateCore(
	references: string[],
	options: UpdateOptions,
	provider: ConfigProvider,
): Promise<void> {
	if (
		Number(references.length > 0) +
			Number(Boolean(options.all)) +
			Number(options.registry !== undefined) !==
		1
	)
		throw new ValidationError("Specify components, --all, or --registry <alias>.")
	const receipt = await readReceipt(provider.cwd)
	if (!receipt) throw new NotFoundError("No components installed")
	const ids =
		references.length > 0
			? resolveInstalledComponentRefs(references, receipt)
			: Object.keys(receipt.installed).filter(
					(id) => options.all || receipt.installed[id]?.registryName === options.registry,
				)
	const components = ids.map((id) => {
		const entry = receipt.installed[id]
		if (!entry) throw new NotFoundError(`Component ${id} is not installed`)
		return `${entry.registryName}/${entry.name}`
	})
	if (components.length === 0) throw new NotFoundError("No matching installed components")
	const result = await installComponents(components, provider, {
		mode: "update",
		force: options.force,
		dryRun: options.dryRun,
	})
	outputInstallation("update", result, options)
}

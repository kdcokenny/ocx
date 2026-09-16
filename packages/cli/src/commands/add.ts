import type { Command } from "commander"
import { type ConfigProvider, resolveDestination } from "../config/provider"
import { installComponents } from "../registry/install"
import { parseQualifiedComponent } from "../schemas/registry"
import { ValidationError } from "../utils/errors"
import { handleError } from "../utils/handle-error"
import { addCommonOptions, addVerboseOption } from "../utils/shared-options"
import { outputInstallation } from "./installation-output"

export type AddInput = { type: "registry"; namespace: string; component: string }
export function parseAddInput(input: string): AddInput {
	if (input.startsWith("npm:"))
		throw new ValidationError(
			"OCX no longer installs npm plugins. Configure V2 plugins directly in OpenCode.",
		)
	return { type: "registry", ...parseQualifiedComponent(input.trim()) }
}
export interface AddOptions {
	profile?: string
	project?: boolean
	cwd?: string
	from?: string
	dryRun?: boolean
	quiet?: boolean
	verbose?: boolean
	json?: boolean
}
export function registerAddCommand(program: Command): void {
	const command = program
		.command("add <components...>")
		.description("Install editable files from registries")
		.option("-p, --profile <name>", "Install into a named profile")
		.option("--project", "Install into this project's .opencode directory")
		.option("--from <url>", "Use an ephemeral registry")
		.option("--dry-run", "Validate and preview without writing files")
	addCommonOptions(command)
	addVerboseOption(command)
	command.action(async (components: string[], options: AddOptions) => {
		try {
			await runAddCore(components, options, await resolveDestination(options))
		} catch (error) {
			handleError(error, { json: options.json })
		}
	})
}
export async function runAddCore(
	references: string[],
	options: AddOptions,
	provider: ConfigProvider,
): Promise<void> {
	const parsed = references
		.map(parseAddInput)
		.map(({ namespace, component }) => `${namespace}/${component}`)
	const result = await installComponents(parsed, provider, {
		mode: "add",
		dryRun: options.dryRun,
		from: options.from,
	})
	outputInstallation("add", result, options)
}

import type { Command } from "commander"
import { InvalidArgumentError, Option } from "commander"
import type { ConfigProvider } from "../config/provider"
import { handleError } from "../utils/handle-error"
import { addCommonOptions, addVerboseOption } from "../utils/shared-options"

export interface SearchOptions {
	cwd: string
	json: boolean
	quiet: boolean
	verbose: boolean
	installed: boolean
	limit: number
	profile?: string
}

function parsePositiveInt(value: string): number {
	const parsed = parseInt(value, 10)
	if (Number.isNaN(parsed) || parsed <= 0) {
		throw new InvalidArgumentError("Must be a positive integer")
	}

	return parsed
}

export function registerSearchCommand(program: Command): void {
	const cmd = program
		.command("search")
		.alias("list")
		.description("Search for components across registries or list installed")
		.argument("[query]", "Search query")
		.option("--installed", "List installed components only", false)
		.option("-p, --profile <name>", "Use specific profile")
		.addOption(new Option("--limit <n>", "Limit results").default(20).argParser(parsePositiveInt))

	addCommonOptions(cmd)
	addVerboseOption(cmd)

	cmd.action(async (query: string | undefined, options: SearchOptions) => {
		try {
			const { runSearchCommandAction } = await import("./search-core")
			await runSearchCommandAction(query, options)
		} catch (error) {
			handleError(error, { json: options.json })
		}
	})
}

export async function runSearchCore(
	query: string | undefined,
	options: { limit: number; json?: boolean; quiet?: boolean; verbose?: boolean },
	provider: ConfigProvider,
): Promise<void> {
	const { runSearchCore } = await import("./search-core")
	await runSearchCore(query, options, provider)
}

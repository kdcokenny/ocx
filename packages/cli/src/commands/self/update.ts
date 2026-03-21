import type { Command } from "commander"
import { handleError } from "../../utils/handle-error"

export interface UpdateOptions {
	force?: boolean
	method?: string
	json?: boolean
}

export function registerSelfUpdateCommand(parent: Command): void {
	parent
		.command("update")
		.description("Update OCX to the latest version")
		.option("-f, --force", "Reinstall even if already up to date")
		.option("--method <method>", "Override install method detection (curl|npm|pnpm|bun)")
		.option("--json", "Output as JSON")
		.action(async (options: UpdateOptions) => {
			try {
				const { runSelfUpdateCommand } = await import("./update-runner")
				await runSelfUpdateCommand(options)
			} catch (error) {
				handleError(error, { json: options.json })
			}
		})
}

import type { Command } from "commander"
import { parseEnvBool } from "../utils/env"

function shouldCheckForUpdate(): boolean {
	if (process.env.OCX_SELF_UPDATE === "off") return false
	if (parseEnvBool(process.env.OCX_NO_UPDATE_CHECK, false)) return false
	if (process.env.CI) return false
	if (!process.stdout.isTTY) return false

	return true
}

export function registerUpdateCheckHook(program: Command): void {
	program.hook("postAction", async (_thisCommand, actionCommand) => {
		if (actionCommand.name() === "update" && actionCommand.parent?.name() === "self") {
			return
		}

		const actionOptions = actionCommand.opts<{ json?: boolean; quiet?: boolean }>()
		if (actionOptions.json || actionOptions.quiet) {
			return
		}

		if (!shouldCheckForUpdate()) {
			return
		}

		try {
			const [{ checkForUpdate }, { notifyUpdate }] = await Promise.all([
				import("./check"),
				import("./notify"),
			])

			const result = await checkForUpdate()
			if (result.ok && result.updateAvailable) {
				notifyUpdate(result.current, result.latest)
			}
		} catch {
			// Silent failure - never interrupt user workflow
		}
	})
}

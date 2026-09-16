import type { InstallationResult } from "../registry/install"
import { outputDryRun } from "../utils/dry-run"
import { outputJson } from "../utils/json-output"

export function outputInstallation(
	command: string,
	result: InstallationResult,
	options: { json?: boolean; quiet?: boolean },
): void {
	if (result.dryRun) {
		outputDryRun(
			{
				dryRun: true,
				command,
				wouldPerform: result.changes.map((change) => ({
					action: change.action,
					target: change.path,
				})),
				validation: { passed: !result.warnings?.length, warnings: result.warnings },
				summary: `${result.components.length} component(s), ${result.changes.length} file change(s)`,
			},
			options,
		)
	} else if (options.json) outputJson({ success: true, ...result })
	else if (!options.quiet)
		console.log(`${result.components.length} component(s), ${result.changes.length} file change(s)`)
}

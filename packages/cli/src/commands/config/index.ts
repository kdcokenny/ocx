import type { Command } from "commander"
import {
	metadataPath,
	resolveMetadata,
	type ScopeOptions,
	withMetadataLock,
} from "../../config/scope"
import { editorCommand } from "../../utils/editor-command"
import { ConfigError } from "../../utils/errors"
import { handleError } from "../../utils/handle-error"
import { outputJson } from "../../utils/json-output"

export function registerConfigCommand(program: Command): void {
	const parent = program.command("config").description("Inspect or edit OCX metadata")
	for (const action of ["show", "edit"] as const) {
		parent
			.command(action)
			.description(
				action === "show"
					? "Show OCX settings (native settings belong to OpenCode)"
					: "Open ocx.jsonc in your editor",
			)
			.option("--global", "Use global OCX settings")
			.option("-p, --profile <name>", "Use profile settings")
			.option("--project", "Use this project's settings")
			.option("--cwd <directory>", "Project directory")
			.option("--json", "Output JSON")
			.action(async (options: ScopeOptions & { json?: boolean }) => {
				try {
					if (action === "show") {
						const target = await resolveMetadata(options)
						if (options.json) outputJson(target)
						else console.log(`${target.path}\n${JSON.stringify(target.config, null, 2)}`)
						return
					}
					const editor = process.env.VISUAL || process.env.EDITOR || "vi"
					await withMetadataLock(options, async () => {
						const path = metadataPath(options)
						if (!(await Bun.file(path).exists()))
							throw new ConfigError(`No OCX metadata at ${path}. Initialize this scope first.`)
						const child = Bun.spawn([...editorCommand(editor), path], {
							stdin: "inherit",
							stdout: options.json ? 2 : "inherit",
							stderr: "inherit",
						})
						const code = await child.exited
						if (code !== 0) throw new Error(`Editor exited with code ${code}`)
						if (options.json) outputJson({ success: true, path })
					})
				} catch (error) {
					handleError(error, { json: options.json })
				}
			})
	}
}

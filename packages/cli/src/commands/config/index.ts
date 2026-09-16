import type { Command } from "commander"
import { resolveMetadata, type ScopeOptions, withMetadataLock } from "../../config/scope"
import { editorCommand } from "../../utils/editor-command"
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
						outputJson(await resolveMetadata(options))
						return
					}
					const editor = process.env.VISUAL || process.env.EDITOR || "vi"
					await withMetadataLock(options, async () => {
						const target = await resolveMetadata(options)
						const child = Bun.spawn([...editorCommand(editor), target.path], {
							stdin: "inherit",
							stdout: "inherit",
							stderr: "inherit",
						})
						const code = await child.exited
						if (code !== 0) throw new Error(`Editor exited with code ${code}`)
					})
				} catch (error) {
					handleError(error, { json: options.json })
				}
			})
	}
}

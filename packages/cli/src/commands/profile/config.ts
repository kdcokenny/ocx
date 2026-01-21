/**
 * Profile Config Command
 *
 * Open a profile's ocx.jsonc file in the user's preferred editor.
 * Uses EDITOR or VISUAL environment variables, falls back to vi.
 */

import type { Command } from "commander"
import { ProfileManager } from "../../profile/manager"
import { getProfileOcxConfig } from "../../profile/paths"
import { handleError } from "../../utils/handle-error"

export function registerProfileConfigCommand(parent: Command): void {
	parent
		.command("config [name]")
		.description("Open profile ocx.jsonc in editor")
		.action(async (name: string | undefined) => {
			try {
				await runProfileConfig(name)
			} catch (error) {
				handleError(error)
			}
		})
}

async function runProfileConfig(name: string | undefined): Promise<void> {
	const manager = await ProfileManager.requireInitialized()

	// Use provided name or resolve profile (flag > env > default)
	const profileName = name ?? (await manager.resolveProfile())

	// Verify profile exists (fail fast)
	await manager.get(profileName)

	const configPath = getProfileOcxConfig(profileName)
	const editor = process.env.EDITOR || process.env.VISUAL || "vi"

	const proc = Bun.spawn([editor, configPath], {
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	})

	const exitCode = await proc.exited
	if (exitCode !== 0) {
		throw new Error(`Editor exited with code ${exitCode}`)
	}
}

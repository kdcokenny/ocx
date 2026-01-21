/**
 * OpenCode Command
 *
 * Launch OpenCode with resolved configuration.
 * Uses ConfigResolver to merge global profile and local configs,
 * then spawns OpenCode with the merged configuration.
 */

import { resolve } from "node:path"
import type { Command } from "commander"
import { ConfigResolver } from "../config/resolver"
import { ProfileManager } from "../profile/manager"
import { getProfileDir, getProfileOpencodeConfig } from "../profile/paths"
import { ProfilesNotInitializedError } from "../utils/errors"
import { getGitInfo } from "../utils/git-context"
import { handleError, logger } from "../utils/index"
import { sharedOptions } from "../utils/shared-options"
import {
	formatTerminalName,
	restoreTerminalTitle,
	saveTerminalTitle,
	setTerminalName,
} from "../utils/terminal-title"

interface OpencodeOptions {
	profile?: string
	rename?: boolean
	quiet?: boolean
	json?: boolean
}

export function registerOpencodeCommand(program: Command): void {
	program
		.command("opencode [path]")
		.alias("oc")
		.description("Launch OpenCode with resolved configuration")
		.option("-p, --profile <name>", "Use specific profile")
		.option("--no-rename", "Disable terminal/tmux window renaming")
		.addOption(sharedOptions.quiet())
		.addOption(sharedOptions.json())
		.allowUnknownOption()
		.allowExcessArguments(true)
		.action(async (path: string | undefined, options: OpencodeOptions, command: Command) => {
			try {
				await runOpencode(path, command.args, options)
			} catch (error) {
				handleError(error, { json: options.json })
			}
		})
}

async function runOpencode(
	pathArg: string | undefined,
	args: string[],
	options: OpencodeOptions,
): Promise<void> {
	// Resolve project directory
	const projectDir = pathArg ? resolve(pathArg) : process.cwd()

	// Create resolver with optional profile override
	const resolver = await ConfigResolver.create(projectDir, { profile: options.profile })
	const config = resolver.resolve()
	const profile = resolver.getProfile()

	// Guard: If profile is specified but profiles aren't initialized
	if (options.profile) {
		const manager = ProfileManager.create()
		if (!(await manager.isInitialized())) {
			throw new ProfilesNotInitializedError()
		}
	}

	// Print feedback about which profile is being used
	if (config.profileName && !options.quiet) {
		logger.info(`Using profile: ${config.profileName}`)
	}

	// Determine if terminal should be renamed
	// Precedence: CLI flag > config > default(true)
	const ocxConfig = profile?.ocx
	const shouldRename = options.rename !== false && ocxConfig?.renameWindow !== false

	// Get profile directory if we have a profile
	const profileDir = config.profileName ? getProfileDir(config.profileName) : undefined

	// Check for profile's opencode.jsonc (optional)
	if (config.profileName && !options.quiet) {
		const profileOpencodePath = getProfileOpencodeConfig(config.profileName)
		const profileOpencodeFile = Bun.file(profileOpencodePath)
		const hasOpencodeConfig = await profileOpencodeFile.exists()
		if (!hasOpencodeConfig) {
			logger.warn(
				`No opencode.jsonc found at ${profileOpencodePath}. Create one to customize OpenCode settings.`,
			)
		}
	}

	// Build the config to pass to OpenCode
	const configToPass =
		config.instructions.length > 0 || Object.keys(config.opencode).length > 0
			? {
					...config.opencode,
					instructions: config.instructions.length > 0 ? config.instructions : undefined,
				}
			: undefined

	// Setup signal handlers BEFORE spawn to avoid race condition
	let proc: ReturnType<typeof Bun.spawn> | null = null

	const sigintHandler = () => proc?.kill("SIGINT")
	const sigtermHandler = () => proc?.kill("SIGTERM")

	process.on("SIGINT", sigintHandler)
	process.on("SIGTERM", sigtermHandler)

	// Exit handler for terminal title restoration
	const exitHandler = () => {
		if (shouldRename) {
			restoreTerminalTitle()
		}
	}
	process.on("exit", exitHandler)

	// Set terminal name only if enabled
	if (shouldRename) {
		saveTerminalTitle()
		const gitInfo = await getGitInfo(projectDir)
		setTerminalName(formatTerminalName(projectDir, config.profileName ?? "default", gitInfo))
	}

	// Determine OpenCode binary
	const bin = ocxConfig?.bin ?? process.env.OPENCODE_BIN ?? "opencode"

	// Spawn OpenCode directly in the project directory with config via environment
	proc = Bun.spawn({
		cmd: [bin, ...args],
		cwd: projectDir,
		env: {
			...process.env,
			OPENCODE_DISABLE_PROJECT_CONFIG: "true",
			...(profileDir && { OPENCODE_CONFIG_DIR: profileDir }),
			...(configToPass && { OPENCODE_CONFIG_CONTENT: JSON.stringify(configToPass) }),
			...(config.profileName && { OCX_PROFILE: config.profileName }),
		},
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	})

	try {
		// Wait for child to exit
		const exitCode = await proc.exited

		// Cleanup signal handlers
		process.off("SIGINT", sigintHandler)
		process.off("SIGTERM", sigtermHandler)
		process.off("exit", exitHandler)

		// Restore terminal title if we renamed it
		if (shouldRename) {
			restoreTerminalTitle()
		}

		process.exit(exitCode)
	} catch (error) {
		// Error during spawn/wait - cleanup handlers
		process.off("SIGINT", sigintHandler)
		process.off("SIGTERM", sigtermHandler)
		process.off("exit", exitHandler)

		if (shouldRename) {
			restoreTerminalTitle()
		}

		throw error
	}
}

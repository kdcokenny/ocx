/**
 * OpenCode Command
 *
 * Launch OpenCode with resolved configuration.
 * Uses ConfigResolver with registry isolation (profile OR local, not merged).
 * OpenCode config and instructions are additively merged when not excluded.
 * Spawns OpenCode with the resolved configuration.
 */

import * as path from "node:path"
import type { Command } from "commander"
import { ConfigResolver } from "../config/resolver"
import { getProfileDir, getProfileOpencodeConfig } from "../profile/paths"
import { getGitInfo } from "../utils/git-context"
import { handleError } from "../utils/handle-error"
import { logger } from "../utils/logger"
import { getGlobalConfigPath } from "../utils/paths"
import {
	formatTerminalName,
	restoreTerminalTitle,
	saveTerminalTitle,
	setTerminalName,
} from "../utils/terminal-title"
import {
	createOpencodeOcError,
	type PreparedMergedConfigDir,
	prepareMergedConfigDirForProfile,
} from "./opencode-overlay"

interface OpencodeOptions {
	profile?: string
	rename?: boolean
}

/**
 * Deduplicates an array while preserving last occurrence.
 * Last-wins behavior: if duplicates exist, keeps the LAST occurrence.
 *
 * Example: ["a", "b", "a", "c"] -> ["b", "a", "c"]
 * (first "a" is removed, last "a" is kept)
 *
 * @internal - Exported for testing
 */
export function dedupeLastWins<T>(items: T[]): T[] {
	const seen = new Set<T>()
	const result: T[] = []

	// Iterate backwards to find last occurrences
	for (let i = items.length - 1; i >= 0; i--) {
		// biome-ignore lint/style/noNonNullAssertion: index i is guaranteed valid within bounds
		const item = items[i]!
		if (!seen.has(item)) {
			seen.add(item)
			result.unshift(item) // Prepend to maintain order
		}
	}

	return result
}

/**
 * Resolves which opencode binary to use.
 * Priority: configBin > envBin > "opencode"
 *
 * Uses nullish coalescing (??) to preserve original behavior:
 * - Empty string "" is passed through (will cause spawn error, but that's intentional)
 * - Only undefined/null falls through to the next option
 */
export function resolveOpenCodeBinary(opts: { configBin?: string; envBin?: string }): string {
	return opts.configBin ?? opts.envBin ?? "opencode"
}

function isPathLikeLauncherToken(token: string): boolean {
	return token.includes("/") || token.includes("\\")
}

/**
 * Resolve launcher token to a cwd-stable executable path.
 *
 * - Path-like tokens (absolute/relative) are normalized to absolute paths.
 * - Bare command names are resolved through PATH via Bun.which.
 * - Throws when PATH lookup fails, because OCX context requires a stable launcher path.
 */
export function resolveStableOpenCodeLauncherPath(opts: {
	configuredBin: string
	cwd: string
	resolveExecutable?: (command: string) => string | null | undefined
}): string {
	const { configuredBin, cwd } = opts
	const resolveExecutable = opts.resolveExecutable ?? ((command: string) => Bun.which(command))

	if (!configuredBin.trim()) {
		throw new Error("OpenCode launcher is empty and cannot be resolved to a stable path")
	}

	if (isPathLikeLauncherToken(configuredBin)) {
		return path.isAbsolute(configuredBin) ? configuredBin : path.resolve(cwd, configuredBin)
	}

	const resolvedFromPath = resolveExecutable(configuredBin)
	if (!resolvedFromPath) {
		throw new Error(
			`OpenCode launcher "${configuredBin}" is not available in PATH and cannot be used as OPENCODE_BIN`,
		)
	}

	return path.isAbsolute(resolvedFromPath) ? resolvedFromPath : path.resolve(cwd, resolvedFromPath)
}

export function resolveStableOcxExecutablePath(opts: {
	cwd: string
	inheritedOcxBin?: string
	argv?: string[]
	execPath?: string
	resolveExecutable?: (command: string) => string | null | undefined
	isCompiledBinary?: boolean
}): string {
	const resolveExecutable = opts.resolveExecutable ?? ((command: string) => Bun.which(command))
	const argv = opts.argv ?? process.argv
	const execPath = opts.execPath ?? process.execPath
	const isCompiledBinary =
		opts.isCompiledBinary ??
		(typeof Bun !== "undefined" && typeof Bun.main === "string" && Bun.main.startsWith("/$bunfs/"))
	const inheritedOcxBin = opts.inheritedOcxBin?.trim()
	const runtimeExecutable = isCompiledBinary ? execPath : argv[1]

	const candidate =
		inheritedOcxBin && inheritedOcxBin.length > 0 ? inheritedOcxBin : runtimeExecutable

	if (!candidate?.trim()) {
		throw new Error("OCX executable path is empty and cannot be resolved from the current process")
	}

	if (isPathLikeLauncherToken(candidate)) {
		return path.isAbsolute(candidate) ? candidate : path.resolve(opts.cwd, candidate)
	}

	const resolvedFromPath = resolveExecutable(candidate)
	if (!resolvedFromPath) {
		throw new Error(
			`OCX executable "${candidate}" is not available in PATH and cannot be persisted as OCX_BIN`,
		)
	}

	return path.isAbsolute(resolvedFromPath)
		? resolvedFromPath
		: path.resolve(opts.cwd, resolvedFromPath)
}

/**
 * Builds environment variables to pass to the opencode process.
 * Returns a NEW object - does not mutate baseEnv.
 *
 * Behavior:
 * - Preserves all keys from baseEnv
 * - Overwrites OCX_PROFILE, OPENCODE_* keys with new values
 * - Exports OCX_CONTEXT/OCX_BIN only when a profile launch context is active
 * - OPENCODE_DISABLE_PROJECT_CONFIG: set to "true" ONLY when a profile is active
 *   (profileName is provided). When no profile, project config is NOT disabled.
 * - OPENCODE_CONFIG_DIR: when configDir is provided → use it;
 *   otherwise profile active → profile-specific dir; no profile → global config dir
 * - configContent is a pre-serialized JSON string; upstream OpenCode handles
 *   {env:...} / {file:...} token resolution in OPENCODE_CONFIG_CONTENT
 */
export function buildOpenCodeEnv(opts: {
	baseEnv: Record<string, string | undefined>
	profileName?: string
	ocxBin?: string
	opencodeBin?: string
	configDir?: string
	configContent?: string
}): Record<string, string | undefined> {
	// Profile presence gates both OPENCODE_DISABLE_PROJECT_CONFIG and OPENCODE_CONFIG_DIR
	const hasProfile = Boolean(opts.profileName)
	// Never leak stale inherited disable flag into no-profile launches.
	const {
		OPENCODE_DISABLE_PROJECT_CONFIG: _inheritedDisableProjectConfig,
		OPENCODE_BIN: _inheritedOpencodeBin,
		OCX_CONTEXT: _inheritedOcxContext,
		OCX_BIN: _inheritedOcxBin,
		OCX_PROFILE: _inheritedOcxProfile,
		...baseEnvWithoutDisableProjectConfig
	} = opts.baseEnv

	return {
		...baseEnvWithoutDisableProjectConfig,
		...(opts.opencodeBin !== undefined && { OPENCODE_BIN: opts.opencodeBin }),
		...(hasProfile && { OPENCODE_DISABLE_PROJECT_CONFIG: "true" }),
		OPENCODE_CONFIG_DIR:
			opts.configDir ??
			(hasProfile ? getProfileDir(opts.profileName as string) : getGlobalConfigPath()),
		...(opts.configContent && { OPENCODE_CONFIG_CONTENT: opts.configContent }),
		...(hasProfile && { OCX_CONTEXT: "1" }),
		...(hasProfile && opts.ocxBin && { OCX_BIN: opts.ocxBin }),
		...(opts.profileName && { OCX_PROFILE: opts.profileName }),
	}
}

export function registerOpencodeCommand(program: Command): void {
	program
		.command("oc")
		.alias("opencode")
		.description("Launch OpenCode with resolved configuration")
		.option("-p, --profile <name>", "Use specific profile")
		.option("--no-rename", "Disable terminal/tmux window renaming")
		.allowUnknownOption()
		.allowExcessArguments(true)
		.action(async (options: OpencodeOptions, command: Command) => {
			try {
				await runOpencode(command.args, options)
			} catch (error) {
				handleError(error)
			}
		})
}

async function runOpencode(args: string[], options: OpencodeOptions): Promise<void> {
	// Resolve project directory
	const projectDir = process.cwd()

	// Create resolver with optional profile override
	const resolver = await ConfigResolver.create(projectDir, { profile: options.profile })
	const config = resolver.resolve()
	const profile = resolver.getProfile()

	// Print feedback about which profile is being used
	if (config.profileName) {
		logger.info(`Using profile: ${config.profileName}`)
	}

	// Determine if terminal should be renamed
	// Precedence: CLI flag > config > default(true)
	const ocxConfig = profile?.ocx
	const shouldRename = options.rename !== false && ocxConfig?.renameWindow !== false

	// Check for profile's opencode.jsonc (optional)
	if (config.profileName) {
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
	// Merge discovered instructions with user-configured instructions
	// Order: discovered/global/profile/registry/project first, then user config instructions last (highest priority)
	const userInstructions = Array.isArray(config.opencode.instructions)
		? config.opencode.instructions
		: []
	const allInstructions = [...config.instructions, ...userInstructions]
	// Deduplicate while preserving last occurrence (last-wins)
	const dedupedInstructions = dedupeLastWins(allInstructions)

	const configToPass =
		dedupedInstructions.length > 0 || Object.keys(config.opencode).length > 0
			? {
					...config.opencode,
					instructions: dedupedInstructions.length > 0 ? dedupedInstructions : undefined,
				}
			: undefined

	// Setup signal handlers BEFORE spawn to avoid race condition
	let proc: ReturnType<typeof Bun.spawn> | null = null
	let mergedConfig: PreparedMergedConfigDir | null = null
	let primaryFailure: Error | null = null
	let childExitCode: number | null = null
	let preSpawnSignalExitCode: number | null = null

	const sigintHandler = () => {
		if (proc) {
			proc.kill("SIGINT")
		} else {
			preSpawnSignalExitCode = 130
		}
	}

	const sigtermHandler = () => {
		if (proc) {
			proc.kill("SIGTERM")
		} else {
			preSpawnSignalExitCode = 143
		}
	}

	const exitHandler = () => {
		if (shouldRename) {
			restoreTerminalTitle()
		}
	}

	try {
		process.on("SIGINT", sigintHandler)
		process.on("SIGTERM", sigtermHandler)
		process.on("exit", exitHandler)

		if (preSpawnSignalExitCode !== null) {
			childExitCode = preSpawnSignalExitCode
			return
		}

		if (config.profileName) {
			mergedConfig = await prepareMergedConfigDirForProfile({
				projectDir,
				profileDir: getProfileDir(config.profileName),
			})
		}

		if (preSpawnSignalExitCode !== null) {
			childExitCode = preSpawnSignalExitCode
			return
		}

		// Set terminal name only if enabled
		if (shouldRename) {
			saveTerminalTitle()
			const gitInfo = await getGitInfo(projectDir)
			if (preSpawnSignalExitCode !== null) {
				childExitCode = preSpawnSignalExitCode
				return
			}

			setTerminalName(formatTerminalName(projectDir, config.profileName ?? "default", gitInfo))
		}

		if (preSpawnSignalExitCode !== null) {
			childExitCode = preSpawnSignalExitCode
			return
		}

		// Determine OpenCode binary
		const configuredBin = resolveOpenCodeBinary({
			configBin: ocxConfig?.bin,
			envBin: process.env.OPENCODE_BIN,
		})

		const hasProfileLaunchContext = Boolean(config.profileName)
		const resolvedOpenCodeLaunchBin = hasProfileLaunchContext
			? resolveStableOpenCodeLauncherPath({
					configuredBin,
					cwd: projectDir,
				})
			: configuredBin
		const resolvedOcxBin = hasProfileLaunchContext
			? resolveStableOcxExecutablePath({
					cwd: projectDir,
					inheritedOcxBin: process.env.OCX_BIN,
				})
			: undefined

		// Spawn OpenCode directly in the project directory with config via environment
		const configContent = configToPass ? JSON.stringify(configToPass) : undefined

		try {
			proc = Bun.spawn({
				cmd: [resolvedOpenCodeLaunchBin, ...args],
				cwd: projectDir,
				env: buildOpenCodeEnv({
					baseEnv: process.env as Record<string, string | undefined>,
					profileName: config.profileName ?? undefined,
					ocxBin: resolvedOcxBin,
					opencodeBin: resolvedOpenCodeLaunchBin,
					configDir: mergedConfig?.path,
					configContent,
				}),
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
			})
		} catch (error: unknown) {
			throw createOpencodeOcError(
				"spawn",
				`Failed to launch OpenCode binary "${configuredBin}": ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		// Wait for child to exit
		childExitCode = await proc.exited
	} catch (error: unknown) {
		primaryFailure =
			error instanceof Error
				? error
				: createOpencodeOcError("spawn", `OpenCode process failed: ${String(error)}`)
	} finally {
		// Cleanup signal handlers
		process.off("SIGINT", sigintHandler)
		process.off("SIGTERM", sigtermHandler)
		process.off("exit", exitHandler)

		if (shouldRename) {
			restoreTerminalTitle()
		}

		if (mergedConfig) {
			try {
				await mergedConfig.cleanup()
			} catch (cleanupError: unknown) {
				const hasPrimaryFailure =
					primaryFailure !== null ||
					preSpawnSignalExitCode !== null ||
					(childExitCode !== null && childExitCode !== 0)

				if (hasPrimaryFailure) {
					logger.warn(
						`Cleanup warning: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
					)
				} else {
					const cleanupFailure: Error =
						cleanupError instanceof Error
							? cleanupError
							: createOpencodeOcError(
									"cleanup",
									`Failed to remove temporary merged config directory: ${String(cleanupError)}`,
								)
					primaryFailure = cleanupFailure
				}
			}
		}
	}

	if (primaryFailure) {
		throw primaryFailure
	}

	if (childExitCode !== null) {
		process.exit(childExitCode)
	}
}

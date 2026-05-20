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
import { type ParseError, parse as parseJsonc } from "jsonc-parser"
import { ConfigResolver } from "../config/resolver"
import {
	findLocalConfigDir,
	getProfileDir,
	getProfileOpencodeConfig,
	OPENCODE_CONFIG_FILE,
} from "../profile/paths"
import { dedupePluginsByCanonicalName, extractCanonicalPluginName } from "../registry/merge"
import { ConfigError } from "../utils/errors"
import { getGitInfo } from "../utils/git-context"
import { handleError } from "../utils/handle-error"
import { formatJsoncParseError } from "../utils/jsonc"
import { logger } from "../utils/logger"
import { getGlobalConfigPath } from "../utils/paths"
import { addVerboseOption } from "../utils/shared-options"
import {
	canWriteOscTerminalTitle,
	formatTerminalName,
	restoreTerminalTitle,
	saveTerminalTitle,
	setTerminalName,
} from "../utils/terminal-title"
import { isPlainObject } from "../utils/type-guards"
import {
	createOpencodeOcError,
	type PreparedMergedConfigDir,
	prepareMergedConfigDirForProfile,
} from "./opencode-overlay"

interface OpencodeOptions {
	profile?: string
	rename?: boolean
	verbose?: boolean
}

type OpenCodeShutdownSignal = "SIGINT" | "SIGTERM"

// Give OpenCode 2.5s to handle SIGINT/SIGTERM itself before escalating to SIGKILL.
// Keeps shutdown deterministic and avoids hanging if the child ignores the signal.
const OPENCODE_SIGNAL_GRACE_MS = 2500
const OPENCODE_SIGNAL_EXIT_CODES: Record<OpenCodeShutdownSignal, number> = {
	SIGINT: 130,
	SIGTERM: 143,
}

type OpencodeLeafOrigin = "profile" | "local"
type OpencodePathSegment = string | number

function pathSegmentsToKey(segments: OpencodePathSegment[]): string {
	if (segments.length === 0) {
		return "$"
	}

	let key = ""
	for (const segment of segments) {
		if (typeof segment === "number") {
			key += `[${segment}]`
			continue
		}

		key = key.length === 0 ? segment : `${key}.${segment}`
	}

	return key
}

function collectLeafOriginsForValue(
	value: unknown,
	origin: OpencodeLeafOrigin,
	pathSegments: OpencodePathSegment[],
	origins: Map<string, OpencodeLeafOrigin>,
): void {
	if (value === undefined) {
		return
	}

	if (isPlainObject(value)) {
		for (const [key, nestedValue] of Object.entries(value)) {
			collectLeafOriginsForValue(nestedValue, origin, [...pathSegments, key], origins)
		}
		return
	}

	if (Array.isArray(value)) {
		for (const [index, nestedValue] of value.entries()) {
			collectLeafOriginsForValue(nestedValue, origin, [...pathSegments, index], origins)
		}
		return
	}

	origins.set(pathSegmentsToKey(pathSegments), origin)
}

function mergeInstructionArrayOrigins(
	profileValues: string[],
	localValues: string[],
	pathSegments: OpencodePathSegment[],
	origins: Map<string, OpencodeLeafOrigin>,
): void {
	const mergedValues = Array.from(new Set([...profileValues, ...localValues]))
	const firstOwnerByValue = new Map<string, OpencodeLeafOrigin>()

	for (const value of profileValues) {
		if (!firstOwnerByValue.has(value)) {
			firstOwnerByValue.set(value, "profile")
		}
	}

	for (const value of localValues) {
		if (!firstOwnerByValue.has(value)) {
			firstOwnerByValue.set(value, "local")
		}
	}

	for (const [index, value] of mergedValues.entries()) {
		origins.set(
			pathSegmentsToKey([...pathSegments, index]),
			firstOwnerByValue.get(value) ?? "local",
		)
	}
}

function mergePluginArrayOrigins(
	profileValues: string[],
	localValues: string[],
	pathSegments: OpencodePathSegment[],
	origins: Map<string, OpencodeLeafOrigin>,
): void {
	const combined = [...profileValues, ...localValues]
	const mergedValues = dedupePluginsByCanonicalName(combined)
	const lastOwnerByCanonical = new Map<string, OpencodeLeafOrigin>()

	for (let index = combined.length - 1; index >= 0; index--) {
		const pluginSpecifier = combined[index]
		if (!pluginSpecifier) {
			continue
		}

		const canonicalName = extractCanonicalPluginName(pluginSpecifier)
		if (!lastOwnerByCanonical.has(canonicalName)) {
			lastOwnerByCanonical.set(canonicalName, index < profileValues.length ? "profile" : "local")
		}
	}

	for (const [index, pluginSpecifier] of mergedValues.entries()) {
		const canonicalName = extractCanonicalPluginName(pluginSpecifier)
		origins.set(
			pathSegmentsToKey([...pathSegments, index]),
			lastOwnerByCanonical.get(canonicalName) ?? "local",
		)
	}
}

function isTopLevelOpencodeArrayPath(
	pathSegments: OpencodePathSegment[],
	expectedKey: "instructions" | "plugin",
): boolean {
	return pathSegments.length === 1 && pathSegments[0] === expectedKey
}

function mergeLeafOriginsAtPath(args: {
	profileValue: unknown
	localValue: unknown
	pathSegments: OpencodePathSegment[]
	origins: Map<string, OpencodeLeafOrigin>
}): void {
	const { profileValue, localValue, pathSegments, origins } = args

	if (localValue === undefined) {
		collectLeafOriginsForValue(profileValue, "profile", pathSegments, origins)
		return
	}

	if (profileValue === undefined) {
		collectLeafOriginsForValue(localValue, "local", pathSegments, origins)
		return
	}

	if (isPlainObject(profileValue) && isPlainObject(localValue)) {
		const keys = new Set([...Object.keys(profileValue), ...Object.keys(localValue)])
		for (const key of keys) {
			mergeLeafOriginsAtPath({
				profileValue: profileValue[key],
				localValue: localValue[key],
				pathSegments: [...pathSegments, key],
				origins,
			})
		}
		return
	}

	if (Array.isArray(profileValue) && Array.isArray(localValue)) {
		if (isTopLevelOpencodeArrayPath(pathSegments, "instructions")) {
			if (
				profileValue.every((value) => typeof value === "string") &&
				localValue.every((value) => typeof value === "string")
			) {
				mergeInstructionArrayOrigins(profileValue, localValue, pathSegments, origins)
				return
			}
		}

		if (isTopLevelOpencodeArrayPath(pathSegments, "plugin")) {
			if (
				profileValue.every((value) => typeof value === "string") &&
				localValue.every((value) => typeof value === "string")
			) {
				mergePluginArrayOrigins(profileValue, localValue, pathSegments, origins)
				return
			}
		}
	}

	collectLeafOriginsForValue(localValue, "local", pathSegments, origins)
}

function buildMergedLeafOriginsForOpencodeConfig(args: {
	profileConfig: Record<string, unknown>
	localConfig: Record<string, unknown>
}): Map<string, OpencodeLeafOrigin> {
	const origins = new Map<string, OpencodeLeafOrigin>()

	mergeLeafOriginsAtPath({
		profileValue: args.profileConfig,
		localValue: args.localConfig,
		pathSegments: [],
		origins,
	})

	return origins
}

function parseFileTokenReference(value: string): string | null {
	if (!value.startsWith("{file:")) {
		return null
	}

	if (!value.endsWith("}")) {
		return null
	}

	const tokenPath = value.slice("{file:".length, -1)
	return tokenPath.length > 0 ? tokenPath : null
}

function isWindowsAbsolutePath(value: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(value)
}

function isRelativeFileTokenPath(value: string): boolean {
	if (value.startsWith("~")) {
		return false
	}

	if (path.isAbsolute(value)) {
		return false
	}

	if (isWindowsAbsolutePath(value)) {
		return false
	}

	return true
}

function rewriteProfileRelativeFileTokenAtLeaf(args: {
	value: string
	pathSegments: OpencodePathSegment[]
	origins: Map<string, OpencodeLeafOrigin>
	profileDir: string
}): string {
	const tokenPath = parseFileTokenReference(args.value)
	if (!tokenPath) {
		return args.value
	}

	const leafPath = pathSegmentsToKey(args.pathSegments)
	if (args.origins.get(leafPath) !== "profile") {
		return args.value
	}

	if (!isRelativeFileTokenPath(tokenPath)) {
		return args.value
	}

	return `{file:${path.resolve(args.profileDir, tokenPath)}}`
}

function rewriteProfileRelativeFileTokensInValue(args: {
	value: unknown
	pathSegments: OpencodePathSegment[]
	origins: Map<string, OpencodeLeafOrigin>
	profileDir: string
}): unknown {
	const { value, pathSegments, origins, profileDir } = args

	if (typeof value === "string") {
		return rewriteProfileRelativeFileTokenAtLeaf({
			value,
			pathSegments,
			origins,
			profileDir,
		})
	}

	if (Array.isArray(value)) {
		return value.map((item, index) =>
			rewriteProfileRelativeFileTokensInValue({
				value: item,
				pathSegments: [...pathSegments, index],
				origins,
				profileDir,
			}),
		)
	}

	if (isPlainObject(value)) {
		const rewritten: Record<string, unknown> = {}
		for (const [key, nestedValue] of Object.entries(value)) {
			rewritten[key] = rewriteProfileRelativeFileTokensInValue({
				value: nestedValue,
				pathSegments: [...pathSegments, key],
				origins,
				profileDir,
			})
		}
		return rewritten
	}

	return value
}

async function loadLocalOpencodeConfigForProfileRewrite(
	projectDir: string,
): Promise<Record<string, unknown>> {
	const localConfigDir = findLocalConfigDir(projectDir)
	if (!localConfigDir) {
		return {}
	}

	const localOpencodePath = path.join(localConfigDir, OPENCODE_CONFIG_FILE)
	const localOpencodeFile = Bun.file(localOpencodePath)
	if (!(await localOpencodeFile.exists())) {
		return {}
	}

	let text: string
	try {
		text = await localOpencodeFile.text()
	} catch (error) {
		const reason = error instanceof Error ? error.message : "Unknown read error"
		throw new ConfigError(`Failed to read local OpenCode config at ${localOpencodePath}: ${reason}`)
	}

	const parseErrors: ParseError[] = []
	const parsed = parseJsonc(text, parseErrors, { allowTrailingComma: true })
	if (parseErrors.length > 0) {
		const errorDetail = formatJsoncParseError(parseErrors)
		throw new ConfigError(
			`Invalid JSONC in local OpenCode config at ${localOpencodePath}: ${errorDetail}`,
		)
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ConfigError(
			`Invalid local OpenCode config at ${localOpencodePath}: root must be an object`,
		)
	}

	return parsed as Record<string, unknown>
}

async function rewriteProfileRelativeFileTokensInMergedConfig(args: {
	mergedConfig: Record<string, unknown>
	profileConfig: Record<string, unknown>
	projectDir: string
	profileDir: string
}): Promise<Record<string, unknown>> {
	const localConfig = await loadLocalOpencodeConfigForProfileRewrite(args.projectDir)
	const leafOrigins = buildMergedLeafOriginsForOpencodeConfig({
		profileConfig: args.profileConfig,
		localConfig,
	})

	return rewriteProfileRelativeFileTokensInValue({
		value: args.mergedConfig,
		pathSegments: [],
		origins: leafOrigins,
		profileDir: args.profileDir,
	}) as Record<string, unknown>
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

export interface OpenCodeTitleContext {
	mayWriteOscTitle: boolean
	baseTitle: string
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
	titleContext?: OpenCodeTitleContext
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
		OCX_TITLE_CONTEXT: _inheritedOcxTitleContext,
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
		...(opts.titleContext && { OCX_TITLE_CONTEXT: JSON.stringify(opts.titleContext) }),
	}
}

export function registerOpencodeCommand(program: Command): void {
	const command = program
		.command("oc")
		.alias("opencode")
		.description("Launch OpenCode with resolved configuration")
		.option("-p, --profile <name>", "Use specific profile")
		.option("--no-rename", "Disable terminal/tmux window renaming")
		.allowUnknownOption()
		.allowExcessArguments(true)

	addVerboseOption(command)
	command.action(async (options: OpencodeOptions, command: Command) => {
		try {
			await runOpencode(command.args, options)
		} catch (error) {
			handleError(error)
		}
	})
}

function createOpenCodeShutdownSupervisor() {
	let childProcess: ReturnType<typeof Bun.spawn> | null = null
	let graceTimer: ReturnType<typeof setTimeout> | null = null
	let rememberedSignalExitCode: number | null = null
	let hasEscalatedToKill = false

	const clearGraceTimer = () => {
		if (!graceTimer) {
			return
		}

		clearTimeout(graceTimer)
		graceTimer = null
	}

	const killChildImmediately = () => {
		if (!childProcess) {
			return
		}

		if (hasEscalatedToKill) {
			return
		}

		hasEscalatedToKill = true
		childProcess.kill("SIGKILL")
	}

	const startSignalGraceTimer = () => {
		if (graceTimer) {
			return
		}

		graceTimer = setTimeout(() => {
			killChildImmediately()
		}, OPENCODE_SIGNAL_GRACE_MS)
	}

	const requestShutdown = (signal: OpenCodeShutdownSignal) => {
		rememberedSignalExitCode ??= OPENCODE_SIGNAL_EXIT_CODES[signal]

		if (!childProcess) {
			return
		}

		if (graceTimer || hasEscalatedToKill) {
			killChildImmediately()
			return
		}

		childProcess.kill(signal)
		startSignalGraceTimer()
	}

	return {
		attachChild(processToSupervise: ReturnType<typeof Bun.spawn>) {
			childProcess = processToSupervise
		},
		clearGraceTimer,
		getRememberedSignalExitCode() {
			return rememberedSignalExitCode
		},
		handleSigint() {
			requestShutdown("SIGINT")
		},
		handleSigterm() {
			requestShutdown("SIGTERM")
		},
	}
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
	let opencodeConfigForLaunch = config.opencode
	if (config.profileName) {
		opencodeConfigForLaunch = await rewriteProfileRelativeFileTokensInMergedConfig({
			mergedConfig: config.opencode,
			profileConfig: profile?.opencode ?? {},
			projectDir,
			profileDir: getProfileDir(config.profileName),
		})
	}

	// Merge discovered instructions with user-configured instructions
	// Order: discovered/global/profile/registry/project first, then user config instructions last (highest priority)
	const userInstructions = Array.isArray(opencodeConfigForLaunch.instructions)
		? opencodeConfigForLaunch.instructions
		: []
	const allInstructions = [...config.instructions, ...userInstructions]
	// Deduplicate while preserving last occurrence (last-wins)
	const dedupedInstructions = dedupeLastWins(allInstructions)

	const configToPass =
		dedupedInstructions.length > 0 || Object.keys(opencodeConfigForLaunch).length > 0
			? {
					...opencodeConfigForLaunch,
					instructions: dedupedInstructions.length > 0 ? dedupedInstructions : undefined,
				}
			: undefined

	// Setup signal handlers BEFORE spawn to avoid race condition
	let proc: ReturnType<typeof Bun.spawn> | null = null
	let mergedConfig: PreparedMergedConfigDir | null = null
	let primaryFailure: Error | null = null
	let childExitCode: number | null = null
	const shutdownSupervisor = createOpenCodeShutdownSupervisor()

	const sigintHandler = () => shutdownSupervisor.handleSigint()
	const sigtermHandler = () => shutdownSupervisor.handleSigterm()

	const exitHandler = () => {
		if (shouldRename) {
			restoreTerminalTitle()
		}
	}

	try {
		process.on("SIGINT", sigintHandler)
		process.on("SIGTERM", sigtermHandler)
		process.on("exit", exitHandler)

		if (shutdownSupervisor.getRememberedSignalExitCode() !== null) {
			childExitCode = shutdownSupervisor.getRememberedSignalExitCode()
			return
		}

		if (config.profileName) {
			if (!profile) {
				throw createOpencodeOcError(
					"validate",
					`Resolved profile ${config.profileName} is missing during profile launch`,
				)
			}

			mergedConfig = await prepareMergedConfigDirForProfile({
				projectDir,
				profileDir: getProfileDir(config.profileName),
				profileVisibilityPolicy: {
					include: profile.ocx.include,
					exclude: profile.ocx.exclude,
				},
			})
		}

		if (shutdownSupervisor.getRememberedSignalExitCode() !== null) {
			childExitCode = shutdownSupervisor.getRememberedSignalExitCode()
			return
		}

		const gitInfo = shouldRename ? await getGitInfo(projectDir) : { repoName: null, branch: null }
		if (shutdownSupervisor.getRememberedSignalExitCode() !== null) {
			childExitCode = shutdownSupervisor.getRememberedSignalExitCode()
			return
		}

		const baseTitle = formatTerminalName(projectDir, config.profileName ?? "default", gitInfo)
		const titleContext: OpenCodeTitleContext = {
			mayWriteOscTitle: shouldRename && canWriteOscTerminalTitle(),
			baseTitle,
		}

		// Set terminal name only if enabled
		if (shouldRename) {
			saveTerminalTitle()
			setTerminalName(baseTitle)
		}

		if (shutdownSupervisor.getRememberedSignalExitCode() !== null) {
			childExitCode = shutdownSupervisor.getRememberedSignalExitCode()
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
					titleContext,
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
		shutdownSupervisor.attachChild(proc)

		// Wait for child to exit
		childExitCode = await proc.exited
	} catch (error: unknown) {
		primaryFailure =
			error instanceof Error
				? error
				: createOpencodeOcError("spawn", `OpenCode process failed: ${String(error)}`)
	} finally {
		shutdownSupervisor.clearGraceTimer()

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
					shutdownSupervisor.getRememberedSignalExitCode() !== null ||
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

	const rememberedSignalExitCode = shutdownSupervisor.getRememberedSignalExitCode()
	if (rememberedSignalExitCode !== null) {
		process.exit(rememberedSignalExitCode)
	}

	if (childExitCode !== null) {
		process.exit(childExitCode)
	}
}

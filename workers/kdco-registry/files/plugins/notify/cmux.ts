import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { canUseCmuxWorkflow } from "../kdco-primitives/cmux"
import { TimeoutError, withTimeout } from "../kdco-primitives/with-timeout"

interface CmuxNotificationPayload {
	title: string
	body: string
	subtitle?: string
}

interface CmuxStatusPayload {
	key: string
	text: string
}

interface CmuxClearStatusPayload {
	key: string
}

type ResolveExecutable = (command: string) => string | null | undefined
type EnvironmentVariables = Record<string, string | undefined>
type CmuxProcess = {
	exited: Promise<number>
	kill?: () => void
}
type SpawnCmuxProcess = (command: string[]) => CmuxProcess

const resolveWithBunWhich: ResolveExecutable = (command) => Bun.which(command)
const spawnCmuxWithBun: SpawnCmuxProcess = (command) =>
	Bun.spawn(command, {
		stdout: "ignore",
		stderr: "ignore",
	})

export const CMUX_NOTIFY_TIMEOUT_MS = 1500
export const CMUX_STATUS_TIMEOUT_MS = CMUX_NOTIFY_TIMEOUT_MS

type CmuxExecutionOptions = {
	timeoutMs?: number
	spawnProcess?: SpawnCmuxProcess
	cmuxCommand?: string
}

type CmuxCommandTrustOptions = {
	currentWorkingDirectory?: string
	tempDirectory?: string
}

export function canUseCmuxNotification(
	env: EnvironmentVariables = process.env,
	resolveExecutable: ResolveExecutable = resolveWithBunWhich,
	cmuxCommand: string = "cmux",
): boolean {
	return Boolean(resolveCmuxNotificationCommand(env, resolveExecutable, cmuxCommand))
}

function realpathBestEffort(filePath: string): string {
	try {
		return fs.realpathSync(filePath)
	} catch {
		return path.resolve(filePath)
	}
}

function isPathAtOrInside(parentPath: string, candidatePath: string): boolean {
	const relative = path.relative(parentPath, candidatePath)
	return (
		relative === "" ||
		(Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative))
	)
}

function isTrustedCmuxCommandPath(
	candidatePath: string,
	options: CmuxCommandTrustOptions = {},
): boolean {
	if (!path.isAbsolute(candidatePath)) return false

	const cwd = path.resolve(options.currentWorkingDirectory ?? process.cwd())
	const realCwd = realpathBestEffort(cwd)
	const tempDirectory = path.resolve(options.tempDirectory ?? os.tmpdir())
	const realTempDirectory = realpathBestEffort(tempDirectory)
	const apparentCandidate = path.resolve(candidatePath)
	const realCandidate = realpathBestEffort(candidatePath)
	const commonTempDirectories = ["/tmp", "/private/tmp", "/var/tmp"]
	const untrustedRoots = [
		cwd,
		realCwd,
		tempDirectory,
		realTempDirectory,
		...commonTempDirectories.flatMap((directory) => [
			path.resolve(directory),
			realpathBestEffort(directory),
		]),
	]
	const filteredUntrustedRoots = untrustedRoots.filter((root) => {
		const resolvedRoot = path.resolve(root)
		return resolvedRoot !== path.parse(resolvedRoot).root
	})

	return !filteredUntrustedRoots.some((root) =>
		[apparentCandidate, realCandidate].some((candidate) => isPathAtOrInside(root, candidate)),
	)
}

export function resolveCmuxNotificationCommand(
	env: EnvironmentVariables = process.env,
	resolveExecutable: ResolveExecutable = resolveWithBunWhich,
	cmuxCommand: string = "cmux",
	options: CmuxCommandTrustOptions = {},
): string | undefined {
	const resolvedCommand = resolveExecutable(cmuxCommand)?.trim()
	if (!resolvedCommand) return undefined
	if (!isTrustedCmuxCommandPath(resolvedCommand, options)) return undefined

	if (!canUseCmuxWorkflow(env, () => resolvedCommand, resolvedCommand)) {
		return undefined
	}

	return realpathBestEffort(resolvedCommand)
}

export function buildCmuxNotifyArgs(payload: CmuxNotificationPayload): string[] {
	const args = ["notify", "--title", payload.title]

	const subtitle = payload.subtitle?.trim()
	if (subtitle) {
		args.push("--subtitle", subtitle)
	}

	args.push("--body", payload.body)

	return args
}

export function buildCmuxStatusArgs(payload: CmuxStatusPayload): string[] {
	return ["set-status", payload.key, payload.text]
}

export function buildCmuxClearStatusArgs(payload: CmuxClearStatusPayload): string[] {
	return ["clear-status", payload.key]
}

async function executeCmuxCommand(
	commandArgs: string[],
	options?: CmuxExecutionOptions,
): Promise<boolean> {
	const timeoutMs = options?.timeoutMs ?? CMUX_NOTIFY_TIMEOUT_MS
	const spawnProcess = options?.spawnProcess ?? spawnCmuxWithBun
	const cmuxCommand = options?.cmuxCommand
	if (!cmuxCommand) return false

	try {
		const proc = spawnProcess([cmuxCommand, ...commandArgs])

		try {
			const exitCode = await withTimeout(
				proc.exited,
				timeoutMs,
				`cmux ${commandArgs[0] ?? "command"} timed out`,
			)
			return exitCode === 0
		} catch (error) {
			if (error instanceof TimeoutError) {
				try {
					proc.kill?.()
				} catch {
					// best effort cleanup
				}
			}

			return false
		}
	} catch {
		return false
	}
}

export async function sendCmuxNotification(
	payload: CmuxNotificationPayload,
	options?: CmuxExecutionOptions,
): Promise<boolean> {
	return executeCmuxCommand(buildCmuxNotifyArgs(payload), options)
}

export async function sendCmuxStatus(
	payload: CmuxStatusPayload,
	options?: CmuxExecutionOptions,
): Promise<boolean> {
	return executeCmuxCommand(buildCmuxStatusArgs(payload), {
		...options,
		timeoutMs: options?.timeoutMs ?? CMUX_STATUS_TIMEOUT_MS,
	})
}

export async function clearCmuxStatus(
	payload: CmuxClearStatusPayload,
	options?: CmuxExecutionOptions,
): Promise<boolean> {
	return executeCmuxCommand(buildCmuxClearStatusArgs(payload), {
		...options,
		timeoutMs: options?.timeoutMs ?? CMUX_STATUS_TIMEOUT_MS,
	})
}

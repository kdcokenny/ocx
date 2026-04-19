import { TimeoutError, withTimeout } from "../kdco-primitives/with-timeout"
import { canUseCmuxWorkflow } from "../worktree/terminal"

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

export function canUseCmuxNotification(
	env: EnvironmentVariables = process.env,
	resolveExecutable: ResolveExecutable = resolveWithBunWhich,
	cmuxCommand: string = "cmux",
): boolean {
	return canUseCmuxWorkflow(env, resolveExecutable, cmuxCommand)
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

async function executeCmuxCommand(commandArgs: string[], options?: CmuxExecutionOptions): Promise<boolean> {
	const timeoutMs = options?.timeoutMs ?? CMUX_NOTIFY_TIMEOUT_MS
	const spawnProcess = options?.spawnProcess ?? spawnCmuxWithBun
	const cmuxCommand = options?.cmuxCommand ?? "cmux"

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

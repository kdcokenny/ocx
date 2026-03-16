import { TimeoutError, withTimeout } from "../kdco-primitives/with-timeout"

interface CmuxNotificationPayload {
	title: string
	body: string
	subtitle?: string
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

export function canUseCmuxNotification(
	env: EnvironmentVariables = process.env,
	resolveExecutable: ResolveExecutable = resolveWithBunWhich,
): boolean {
	const workspaceID = env.CMUX_WORKSPACE_ID?.trim()
	if (!workspaceID) return false

	return Boolean(resolveExecutable("cmux"))
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

export async function sendCmuxNotification(
	payload: CmuxNotificationPayload,
	options?: {
		timeoutMs?: number
		spawnProcess?: SpawnCmuxProcess
	},
): Promise<boolean> {
	const timeoutMs = options?.timeoutMs ?? CMUX_NOTIFY_TIMEOUT_MS
	const spawnProcess = options?.spawnProcess ?? spawnCmuxWithBun

	try {
		const proc = spawnProcess(["cmux", ...buildCmuxNotifyArgs(payload)])

		try {
			const exitCode = await withTimeout(proc.exited, timeoutMs, "cmux notify timed out")
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

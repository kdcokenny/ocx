export type ResolveExecutable = (command: string) => string | null | undefined
export type CmuxEnvironment = Record<string, string | undefined>

export interface CmuxContext {
	workspaceID?: string
	surfaceID?: string
	socketPath?: string
	socketMode?: string
}

function normalizeCmuxValue(value?: string): string | undefined {
	const trimmed = value?.trim()
	return trimmed ? trimmed : undefined
}

export function detectCmuxContext(env: CmuxEnvironment = process.env): CmuxContext {
	return {
		workspaceID: normalizeCmuxValue(env.CMUX_WORKSPACE_ID),
		surfaceID: normalizeCmuxValue(env.CMUX_SURFACE_ID),
		socketPath: normalizeCmuxValue(env.CMUX_SOCKET_PATH),
		socketMode: normalizeCmuxValue(env.CMUX_SOCKET_MODE),
	}
}

export function canUseCmuxWorkflow(
	env: CmuxEnvironment = process.env,
	resolveExecutable: ResolveExecutable = (command) => Bun.which(command),
	cmuxExecutable: string = "cmux",
): boolean {
	if (!resolveExecutable(cmuxExecutable)) {
		return false
	}

	const context = detectCmuxContext(env)
	if (context.workspaceID) {
		return true
	}

	const socketModeAllowsExternalControl = context.socketMode?.toLowerCase() === "allowall"
	return Boolean(context.socketPath && socketModeAllowsExternalControl)
}

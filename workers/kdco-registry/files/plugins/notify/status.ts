type CmuxSessionLogicalState = "animated-busy" | "needs-input" | "error" | "idle"

export type CmuxSessionStatusTransition = {
	readonly sessionID: string
	readonly logicalState: CmuxSessionLogicalState
}

function toNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") return null

	const normalized = value.trim()
	if (!normalized) return null

	return normalized
}

function toStatusType(properties: Record<string, unknown>): string | null {
	const status = properties.status
	if (!status || typeof status !== "object") return null

	const statusType = toNonEmptyString((status as Record<string, unknown>).type)
	if (!statusType) return null

	return statusType.toLowerCase()
}

export function buildCmuxSessionStatusTransitionForEvent(
	eventType: string,
	properties: Record<string, unknown>,
): CmuxSessionStatusTransition | null {
	const sessionID = toNonEmptyString(properties.sessionID)
	if (!sessionID) return null

	if (
		eventType === "question.asked" ||
		eventType === "permission.asked" ||
		eventType === "permission.updated"
	) {
		return { sessionID, logicalState: "needs-input" }
	}

	if (eventType === "session.idle") {
		return { sessionID, logicalState: "idle" }
	}

	if (eventType === "session.error") {
		return { sessionID, logicalState: "error" }
	}

	if (eventType !== "session.status") {
		return null
	}

	const statusType = toStatusType(properties)
	if (statusType === "idle") {
		return { sessionID, logicalState: "idle" }
	}

	if (statusType === "busy" || statusType === "retry" || statusType === "running") {
		return { sessionID, logicalState: "animated-busy" }
	}

	return null
}

export function buildCmuxSessionStatusTransitionForQuestionTool(
	sessionID: unknown,
): CmuxSessionStatusTransition | null {
	const normalizedSessionID = toNonEmptyString(sessionID)
	if (!normalizedSessionID) return null

	return {
		sessionID: normalizedSessionID,
		logicalState: "needs-input",
	}
}

export function getCmuxSessionStatusText(
	logicalState: Exclude<CmuxSessionLogicalState, "idle" | "animated-busy">,
): string {
	if (logicalState === "needs-input") return "Needs input"
	return "Error"
}

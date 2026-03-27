import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Event } from "@opencode-ai/sdk"

type SessionInfo = {
	parentID?: string
	title?: string
}

let mockedConfig: unknown | undefined
let mockedTerminalName: string | null = null

const notificationPayloads: Array<Record<string, unknown>> = []
const notifyMock = mock((payload: Record<string, unknown>) => {
	notificationPayloads.push(payload)
})

mock.module("node:fs/promises", () => ({
	readFile: async () => {
		if (mockedConfig === undefined) {
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
		}

		return JSON.stringify(mockedConfig)
	},
}))

mock.module("detect-terminal", () => ({
	default: () => mockedTerminalName,
}))

mock.module("node-notifier", () => ({
	default: {
		notify: notifyMock,
	},
}))

let NotifyPlugin: typeof import("../files/plugins/notify").NotifyPlugin

beforeAll(async () => {
	;({ NotifyPlugin } = await import("../files/plugins/notify"))
})

beforeEach(() => {
	mockedConfig = undefined
	mockedTerminalName = null
	notificationPayloads.length = 0
	notifyMock.mockClear()
	delete process.env.CMUX_WORKSPACE_ID
})

afterEach(() => {
	mock.restore()
})

function minutesToClock(totalMinutes: number): string {
	const wrappedMinutes = ((totalMinutes % 1440) + 1440) % 1440
	const hour = Math.floor(wrappedMinutes / 60)
	const minute = wrappedMinutes % 60
	return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`
}

function buildCurrentMinuteQuietHours(): { enabled: boolean; start: string; end: string } {
	const now = new Date()
	const currentMinute = now.getHours() * 60 + now.getMinutes()

	return {
		enabled: true,
		start: minutesToClock(currentMinute - 1),
		end: minutesToClock(currentMinute + 1),
	}
}

function mockFocusedTerminal(): void {
	mockedTerminalName = "ghostty"

	spyOn(Bun, "spawn").mockImplementation((...args: unknown[]) => {
		const command = args[0]
		const script = Array.isArray(command) && typeof command[2] === "string" ? command[2] : ""
		const output = script.includes("frontmost") ? "Ghostty\n" : "com.mitchellh.ghostty\n"

		return {
			stdout: new Blob([output]).stream(),
			stderr: new Blob([""]).stream(),
			exited: Promise.resolve(0),
		} as ReturnType<typeof Bun.spawn>
	})
}

async function createPlugin(sessionInfoByID: Record<string, SessionInfo> = {}): Promise<{
	hooks: Awaited<ReturnType<typeof NotifyPlugin>>
	sessionGet: ReturnType<typeof mock>
}> {
	const sessionGet = mock(async ({ path: { id } }: { path: { id: string } }) => ({
		data: {
			title: sessionInfoByID[id]?.title ?? `Session ${id}`,
			parentID: sessionInfoByID[id]?.parentID,
		},
	}))

	const hooks = await NotifyPlugin({
		client: {
			session: {
				get: sessionGet,
			},
		},
	} as unknown as Parameters<typeof NotifyPlugin>[0])

	return { hooks, sessionGet }
}

async function emitEvent(
	hooks: Awaited<ReturnType<typeof NotifyPlugin>>,
	event: Record<string, unknown>,
): Promise<void> {
	if (!hooks.event) throw new Error("Notify plugin did not register event handler")
	await hooks.event({ event: event as Event })
}

async function emitQuestionToolBefore(
	hooks: Awaited<ReturnType<typeof NotifyPlugin>>,
	sessionID: string,
	callID: string,
): Promise<void> {
	const hook = hooks["tool.execute.before"]
	if (!hook) throw new Error("Notify plugin did not register tool.execute.before")

	await (hook as (...args: unknown[]) => Promise<void>)(
		{
			tool: "question",
			sessionID,
			callID,
		},
		{},
	)
}

describe("notify plugin event compatibility and dedupe", () => {
	it("dedupes permission notification when permission.asked and permission.updated describe same request", async () => {
		const { hooks } = await createPlugin()

		await emitEvent(hooks, {
			type: "permission.asked",
			properties: {
				id: "perm-shared",
				sessionID: "session-a",
				permission: "bash",
				patterns: [],
				metadata: {},
				always: [],
			},
		})

		await emitEvent(hooks, {
			type: "permission.updated",
			properties: {
				id: "perm-shared",
			},
		})

		expect(notificationPayloads).toHaveLength(1)
		expect(notificationPayloads[0]?.title).toBe("Waiting for you")
	})

	it("notifies for question.asked and legacy question tool.execute.before", async () => {
		const { hooks } = await createPlugin()

		await emitQuestionToolBefore(hooks, "session-a", "call-tool")

		await emitEvent(hooks, {
			type: "question.asked",
			properties: {
				id: "question-1",
				sessionID: "session-a",
				questions: [],
				tool: {
					messageID: "message-1",
					callID: "call-event",
				},
			},
		})

		expect(notificationPayloads).toHaveLength(2)
		expect(notificationPayloads.map((payload) => payload.title)).toEqual([
			"Question for you",
			"Question for you",
		])
	})

	it("dedupes question notification when question.asked and tool hook describe same request", async () => {
		const { hooks } = await createPlugin()

		await emitQuestionToolBefore(hooks, "session-a", "call-shared")

		await emitEvent(hooks, {
			type: "question.asked",
			properties: {
				id: "question-1",
				sessionID: "session-a",
				questions: [],
				tool: {
					messageID: "message-1",
					callID: "call-shared",
				},
			},
		})

		expect(notificationPayloads).toHaveLength(1)
		expect(notificationPayloads[0]?.title).toBe("Question for you")
	})

	it("notifies for session.status idle and legacy session.idle", async () => {
		const { hooks } = await createPlugin({
			"session-status": { title: "Status Session" },
			"session-idle": { title: "Idle Session" },
		})

		await emitEvent(hooks, {
			type: "session.status",
			properties: {
				sessionID: "session-status",
				status: {
					type: "idle",
				},
			},
		})

		await emitEvent(hooks, {
			type: "session.idle",
			properties: {
				sessionID: "session-idle",
			},
		})

		expect(notificationPayloads).toHaveLength(2)
		expect(notificationPayloads.map((payload) => payload.title)).toEqual([
			"Ready for review",
			"Ready for review",
		])
	})

	it("dedupes ready notification when session.status idle and session.idle describe same transition", async () => {
		const { hooks } = await createPlugin({
			"session-a": { title: "Session A" },
		})

		await emitEvent(hooks, {
			type: "session.status",
			properties: {
				sessionID: "session-a",
				status: {
					type: "idle",
				},
			},
		})

		await emitEvent(hooks, {
			type: "session.idle",
			properties: {
				sessionID: "session-a",
			},
		})

		expect(notificationPayloads).toHaveLength(1)
		expect(notificationPayloads[0]?.title).toBe("Ready for review")
	})

	it("keeps parent-session gating only for ready notifications", async () => {
		const { hooks } = await createPlugin({
			"child-session": {
				parentID: "root-session",
				title: "Child Session",
			},
		})

		await emitEvent(hooks, {
			type: "session.status",
			properties: {
				sessionID: "child-session",
				status: {
					type: "idle",
				},
			},
		})

		await emitEvent(hooks, {
			type: "session.idle",
			properties: {
				sessionID: "child-session",
			},
		})

		await emitEvent(hooks, {
			type: "permission.asked",
			properties: {
				id: "perm-1",
				sessionID: "child-session",
				permission: "bash",
				patterns: [],
				metadata: {},
				always: [],
			},
		})

		await emitEvent(hooks, {
			type: "question.asked",
			properties: {
				id: "question-1",
				sessionID: "child-session",
				questions: [],
			},
		})

		expect(notificationPayloads).toHaveLength(2)
		expect(notificationPayloads.map((payload) => payload.title)).toEqual([
			"Waiting for you",
			"Question for you",
		])
	})

	it("suppresses focus-gated notifications but keeps question prompt notifications", async () => {
		mockFocusedTerminal()

		const { hooks } = await createPlugin({
			"session-a": { title: "Session A" },
		})

		await emitEvent(hooks, {
			type: "permission.asked",
			properties: {
				id: "perm-1",
				sessionID: "session-a",
				permission: "bash",
				patterns: [],
				metadata: {},
				always: [],
			},
		})

		await emitEvent(hooks, {
			type: "session.status",
			properties: {
				sessionID: "session-a",
				status: {
					type: "idle",
				},
			},
		})

		await emitEvent(hooks, {
			type: "question.asked",
			properties: {
				id: "question-1",
				sessionID: "session-a",
				questions: [],
			},
		})

		expect(notificationPayloads).toHaveLength(1)
		expect(notificationPayloads[0]?.title).toBe("Question for you")
	})

	it("suppresses notifications during quiet hours for legacy and new event aliases", async () => {
		mockedConfig = {
			quietHours: buildCurrentMinuteQuietHours(),
		}

		const { hooks } = await createPlugin({
			"session-a": { title: "Session A" },
		})

		await emitEvent(hooks, {
			type: "permission.updated",
			properties: {},
		})

		await emitEvent(hooks, {
			type: "permission.asked",
			properties: {
				id: "perm-1",
				sessionID: "session-a",
				permission: "bash",
				patterns: [],
				metadata: {},
				always: [],
			},
		})

		await emitQuestionToolBefore(hooks, "session-a", "call-legacy")

		await emitEvent(hooks, {
			type: "question.asked",
			properties: {
				id: "question-1",
				sessionID: "session-a",
				questions: [],
			},
		})

		await emitEvent(hooks, {
			type: "session.idle",
			properties: {
				sessionID: "session-a",
			},
		})

		await emitEvent(hooks, {
			type: "session.status",
			properties: {
				sessionID: "session-a",
				status: {
					type: "idle",
				},
			},
		})

		expect(notificationPayloads).toHaveLength(0)
	})
})

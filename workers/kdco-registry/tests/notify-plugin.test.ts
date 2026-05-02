import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import * as fsPromises from "node:fs/promises"
import type { Event } from "@opencode-ai/sdk"

type SessionInfo = {
	parentID?: string
	title?: string
}

let mockedConfig: unknown | undefined
let mockedTerminalName: string | null = null

const CMUX_BUSY_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const
const CMUX_BUSY_SPINNER_INTERVAL_MS = 80

const notificationPayloads: Array<Record<string, unknown>> = []
const notifyMock = mock((payload: Record<string, unknown>) => {
	notificationPayloads.push(payload)
})
const readActualFile = fsPromises.readFile

mock.module("node:fs/promises", () => ({
	...fsPromises,
	readFile: async (filePath: Parameters<typeof fsPromises.readFile>[0], options?: Parameters<typeof fsPromises.readFile>[1]) => {
		if (filePath !== `${process.env.HOME}/.config/opencode/kdco-notify.json`) {
			return readActualFile(filePath, options)
		}

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

let NotifyPlugin: typeof import("../files/plugins/notify").default

beforeAll(async () => {
	;({ default: NotifyPlugin } = await import("../files/plugins/notify"))
})

beforeEach(() => {
	mockedConfig = undefined
	mockedTerminalName = null
	notificationPayloads.length = 0
	notifyMock.mockClear()
	delete process.env.CMUX_WORKSPACE_ID
	delete process.env.CMUX_SOCKET_PATH
	delete process.env.CMUX_SOCKET_MODE
	delete process.env.OCX_TITLE_CONTEXT
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

function decodeOscTitleWrite(chunk: unknown): string | null {
	if (typeof chunk !== "string") return null

	const match = /^\u001b\]0;(.*)\u0007$/.exec(chunk)
	if (!match) return null

	return match[1] ?? null
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

	it("does not write OSC title when launcher contract disables writes", async () => {
		process.env.OCX_TITLE_CONTEXT = JSON.stringify({
			mayWriteOscTitle: false,
			baseTitle: "ocx[default]:repo/main",
		})

		const writtenTitles: string[] = []
		spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			const decodedTitle = decodeOscTitleWrite(chunk)
			if (decodedTitle) {
				writtenTitles.push(decodedTitle)
			}
			return true
		})

		const { hooks } = await createPlugin({
			"session-a": { title: "Session A" },
		})

		await emitEvent(hooks, {
			type: "session.status",
			properties: {
				sessionID: "session-a",
				status: {
					type: "busy",
				},
			},
		})
		await Bun.sleep(0)

		expect(writtenTitles).toHaveLength(0)
	})

	it("suppresses cmux status writes when OSC title ownership is active", async () => {
		process.env.CMUX_WORKSPACE_ID = "workspace-123"
		process.env.OCX_TITLE_CONTEXT = JSON.stringify({
			mayWriteOscTitle: true,
			baseTitle: "ocx[default]:repo/main",
		})

		spyOn(Bun, "which").mockImplementation((command: string) =>
			command === "cmux" ? "/usr/local/bin/cmux" : null,
		)

		spyOn(globalThis, "setInterval").mockImplementation(
			((() => {
				return {
					unref: () => {
						// no-op
					},
				} as ReturnType<typeof setInterval>
			}) as unknown) as typeof setInterval,
		)
		spyOn(globalThis, "clearInterval").mockImplementation((() => {
			// no-op
		}) as typeof clearInterval)

		const cmuxCommands: string[][] = []
		spyOn(Bun, "spawn").mockImplementation((...args: unknown[]) => {
			const command = args[0]
			if (Array.isArray(command) && command[0] === "cmux") {
				cmuxCommands.push(command.map(String))
				return {
					exited: Promise.resolve(0),
					kill: () => {
						// no-op
					},
				} as ReturnType<typeof Bun.spawn>
			}

			return {
				stdout: new Blob([""]).stream(),
				stderr: new Blob([""]).stream(),
				exited: Promise.resolve(0),
			} as ReturnType<typeof Bun.spawn>
		})

		const writtenTitles: string[] = []
		spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			const decodedTitle = decodeOscTitleWrite(chunk)
			if (decodedTitle) {
				writtenTitles.push(decodedTitle)
			}
			return true
		})

		const { hooks } = await createPlugin({
			"session-a": { title: "Session A" },
		})

		await emitEvent(hooks, {
			type: "session.status",
			properties: {
				sessionID: "session-a",
				status: {
					type: "busy",
				},
			},
		})
		await Bun.sleep(0)

		await emitEvent(hooks, {
			type: "question.asked",
			properties: {
				id: "question-1",
				sessionID: "session-a",
				questions: [],
			},
		})
		await Bun.sleep(0)

		await emitEvent(hooks, {
			type: "session.idle",
			properties: {
				sessionID: "session-a",
			},
		})
		await Bun.sleep(0)

		const statusCommands = cmuxCommands.filter(
			(command) => command[1] === "set-status" || command[1] === "clear-status",
		)

		expect(statusCommands).toHaveLength(0)
		expect(cmuxCommands.some((command) => command[1] === "notify")).toBe(true)
		expect(writtenTitles).toEqual(["⠋ ocx[default]:repo/main", "ocx[default]:repo/main"])
	})

	it("keeps cmux status fallback when launcher contract disallows OSC title writes", async () => {
		process.env.CMUX_WORKSPACE_ID = "workspace-123"
		process.env.OCX_TITLE_CONTEXT = JSON.stringify({
			mayWriteOscTitle: false,
			baseTitle: "ocx[default]:repo/main",
		})

		spyOn(Bun, "which").mockImplementation((command: string) =>
			command === "cmux" ? "/usr/local/bin/cmux" : null,
		)

		spyOn(globalThis, "setInterval").mockImplementation(
			((() => {
				return {
					unref: () => {
						// no-op
					},
				} as ReturnType<typeof setInterval>
			}) as unknown) as typeof setInterval,
		)
		spyOn(globalThis, "clearInterval").mockImplementation((() => {
			// no-op
		}) as typeof clearInterval)

		const cmuxCommands: string[][] = []
		spyOn(Bun, "spawn").mockImplementation((...args: unknown[]) => {
			const command = args[0]
			if (Array.isArray(command) && command[0] === "cmux") {
				cmuxCommands.push(command.map(String))
				return {
					exited: Promise.resolve(0),
					kill: () => {
						// no-op
					},
				} as ReturnType<typeof Bun.spawn>
			}

			return {
				stdout: new Blob([""]).stream(),
				stderr: new Blob([""]).stream(),
				exited: Promise.resolve(0),
			} as ReturnType<typeof Bun.spawn>
		})

		const writtenTitles: string[] = []
		spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			const decodedTitle = decodeOscTitleWrite(chunk)
			if (decodedTitle) {
				writtenTitles.push(decodedTitle)
			}
			return true
		})

		const { hooks } = await createPlugin({
			"session-a": { title: "Session A" },
		})

		await emitEvent(hooks, {
			type: "session.status",
			properties: {
				sessionID: "session-a",
				status: {
					type: "busy",
				},
			},
		})
		await Bun.sleep(0)

		await emitEvent(hooks, {
			type: "session.idle",
			properties: {
				sessionID: "session-a",
			},
		})
		await Bun.sleep(0)

		const statusCommands = cmuxCommands.filter(
			(command) => command[1] === "set-status" || command[1] === "clear-status",
		)

		expect(statusCommands).toEqual([
			["cmux", "set-status", "opencode.session.session-a", "⠋"],
			["cmux", "clear-status", "opencode.session.session-a"],
		])
		expect(writtenTitles).toHaveLength(0)
	})

	it("keeps OSC spinner active while any tracked session remains busy", async () => {
		process.env.OCX_TITLE_CONTEXT = JSON.stringify({
			mayWriteOscTitle: true,
			baseTitle: "ocx[default]:repo/main",
		})

		let tickerCallback: (() => void) | null = null
		let tickerIntervalMs: number | null = null
		spyOn(globalThis, "setInterval").mockImplementation(
			((callback: unknown, ms?: number) => {
				if (typeof callback !== "function") {
					throw new Error("Expected title ticker callback to be a function")
				}

				tickerCallback = callback as () => void
				tickerIntervalMs = ms ?? null

				return {
					unref: () => {
						// no-op
					},
				} as ReturnType<typeof setInterval>
			}) as typeof setInterval,
		)
		spyOn(globalThis, "clearInterval").mockImplementation((() => {
			// no-op
		}) as typeof clearInterval)

		const writtenTitles: string[] = []
		spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			const decodedTitle = decodeOscTitleWrite(chunk)
			if (decodedTitle) {
				writtenTitles.push(decodedTitle)
			}
			return true
		})

		const { hooks } = await createPlugin({
			"session-a": { title: "Session A" },
			"session-b": { title: "Session B" },
		})

		await emitEvent(hooks, {
			type: "session.status",
			properties: {
				sessionID: "session-a",
				status: { type: "busy" },
			},
		})
		await Bun.sleep(0)

		await emitEvent(hooks, {
			type: "session.status",
			properties: {
				sessionID: "session-b",
				status: { type: "busy" },
			},
		})
		await Bun.sleep(0)

		await emitEvent(hooks, {
			type: "question.asked",
			properties: {
				id: "question-a",
				sessionID: "session-a",
				questions: [],
			},
		})
		await Bun.sleep(0)

		if (!tickerCallback) {
			throw new Error("Expected title busy ticker callback to be captured")
		}

		expect(tickerIntervalMs).toBe(CMUX_BUSY_SPINNER_INTERVAL_MS)

		tickerCallback()
		await Bun.sleep(0)

		await emitEvent(hooks, {
			type: "session.error",
			properties: {
				sessionID: "session-b",
				error: "boom",
			},
		})
		await Bun.sleep(0)

		expect(writtenTitles).toEqual([
			"⠋ ocx[default]:repo/main",
			"⠙ ocx[default]:repo/main",
			"ocx[default]:repo/main",
		])
	})

	it("restores base title for non-busy needs-input/error/idle transitions", async () => {
		process.env.OCX_TITLE_CONTEXT = JSON.stringify({
			mayWriteOscTitle: true,
			baseTitle: "ocx[default]:repo/main",
		})

		spyOn(globalThis, "setInterval").mockImplementation(
			((() => {
				return {
					unref: () => {
						// no-op
					},
				} as ReturnType<typeof setInterval>
			}) as unknown) as typeof setInterval,
		)
		spyOn(globalThis, "clearInterval").mockImplementation((() => {
			// no-op
		}) as typeof clearInterval)

		const writtenTitles: string[] = []
		spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			const decodedTitle = decodeOscTitleWrite(chunk)
			if (decodedTitle) {
				writtenTitles.push(decodedTitle)
			}
			return true
		})

		const { hooks } = await createPlugin({
			"session-a": { title: "Session A" },
		})

		await emitEvent(hooks, {
			type: "session.status",
			properties: {
				sessionID: "session-a",
				status: { type: "busy" },
			},
		})
		await Bun.sleep(0)

		await emitEvent(hooks, {
			type: "question.asked",
			properties: {
				id: "question-a",
				sessionID: "session-a",
				questions: [],
			},
		})
		await Bun.sleep(0)

		await emitEvent(hooks, {
			type: "session.status",
			properties: {
				sessionID: "session-a",
				status: { type: "busy" },
			},
		})
		await Bun.sleep(0)

		await emitEvent(hooks, {
			type: "session.error",
			properties: {
				sessionID: "session-a",
				error: "boom",
			},
		})
		await Bun.sleep(0)

		await emitEvent(hooks, {
			type: "session.status",
			properties: {
				sessionID: "session-a",
				status: { type: "busy" },
			},
		})
		await Bun.sleep(0)

		await emitEvent(hooks, {
			type: "session.idle",
			properties: {
				sessionID: "session-a",
			},
		})
		await Bun.sleep(0)

		expect(writtenTitles).toEqual([
			"⠋ ocx[default]:repo/main",
			"ocx[default]:repo/main",
			"⠋ ocx[default]:repo/main",
			"ocx[default]:repo/main",
			"⠋ ocx[default]:repo/main",
			"ocx[default]:repo/main",
		])
	})

	it("keeps title writes best-effort and non-blocking when stdout write fails", async () => {
		process.env.OCX_TITLE_CONTEXT = JSON.stringify({
			mayWriteOscTitle: true,
			baseTitle: "ocx[default]:repo/main",
		})

		spyOn(globalThis, "setInterval").mockImplementation(
			((() => {
				return {
					unref: () => {
						// no-op
					},
				} as ReturnType<typeof setInterval>
			}) as unknown) as typeof setInterval,
		)
		spyOn(globalThis, "clearInterval").mockImplementation((() => {
			// no-op
		}) as typeof clearInterval)

		spyOn(process.stdout, "write").mockImplementation(() => {
			throw new Error("write failed")
		})

		const { hooks } = await createPlugin({
			"session-a": { title: "Session A" },
		})

		const startedAt = Date.now()
		await emitEvent(hooks, {
			type: "session.status",
			properties: {
				sessionID: "session-a",
				status: { type: "busy" },
			},
		})
		const elapsedMs = Date.now() - startedAt

		expect(elapsedMs).toBeLessThan(120)

		await emitEvent(hooks, {
			type: "session.idle",
			properties: {
				sessionID: "session-a",
			},
		})
		await Bun.sleep(0)
	})

	it("emits cmux spinner/Needs input/Error/Idle status transitions when cmux is enabled", async () => {
		process.env.CMUX_WORKSPACE_ID = "workspace-123"

		spyOn(Bun, "which").mockImplementation((command: string) =>
			command === "cmux" ? "/usr/local/bin/cmux" : null,
		)

		const cmuxCommands: string[][] = []
		spyOn(Bun, "spawn").mockImplementation((...args: unknown[]) => {
			const command = args[0]
			if (Array.isArray(command) && command[0] === "cmux") {
				cmuxCommands.push(command.map(String))
				return {
					exited: Promise.resolve(0),
					kill: () => {
						// no-op
					},
				} as ReturnType<typeof Bun.spawn>
			}

			return {
				stdout: new Blob([""]).stream(),
				stderr: new Blob([""]).stream(),
				exited: Promise.resolve(0),
			} as ReturnType<typeof Bun.spawn>
		})

		const { hooks } = await createPlugin({
			"session-a": { title: "Session A" },
		})

		await emitEvent(hooks, {
			type: "session.status",
			properties: {
				sessionID: "session-a",
				status: {
					type: "busy",
				},
			},
		})
		await Bun.sleep(0)

		await emitEvent(hooks, {
			type: "question.asked",
			properties: {
				id: "question-1",
				sessionID: "session-a",
				questions: [],
			},
		})
		await Bun.sleep(0)

		await emitEvent(hooks, {
			type: "session.error",
			properties: {
				sessionID: "session-a",
				error: "boom",
			},
		})
		await Bun.sleep(0)

		await emitEvent(hooks, {
			type: "session.idle",
			properties: {
				sessionID: "session-a",
			},
		})
		await Bun.sleep(0)

		const statusCommands = cmuxCommands.filter(
			(command) => command[1] === "set-status" || command[1] === "clear-status",
		)

		expect(statusCommands).toEqual([
			["cmux", "set-status", "opencode.session.session-a", "⠋"],
			["cmux", "set-status", "opencode.session.session-a", "Needs input"],
			["cmux", "set-status", "opencode.session.session-a", "Error"],
			["cmux", "clear-status", "opencode.session.session-a"],
		])
	})

	it("animates busy cmux status glyphs on deterministic ticker cadence", async () => {
		process.env.CMUX_WORKSPACE_ID = "workspace-123"

		spyOn(Bun, "which").mockImplementation((command: string) =>
			command === "cmux" ? "/usr/local/bin/cmux" : null,
		)

		let tickerCallback: (() => void) | null = null
		let tickerIntervalMs: number | null = null
		spyOn(globalThis, "setInterval").mockImplementation(
			((callback: unknown, ms?: number) => {
				if (typeof callback !== "function") {
					throw new Error("Expected notify busy ticker callback to be a function")
				}

				tickerCallback = callback as () => void
				tickerIntervalMs = ms ?? null

				return {
					unref: () => {
						// no-op
					},
				} as ReturnType<typeof setInterval>
			}) as typeof setInterval,
		)
		spyOn(globalThis, "clearInterval").mockImplementation((() => {
			// no-op
		}) as typeof clearInterval)

		const cmuxCommands: string[][] = []
		spyOn(Bun, "spawn").mockImplementation((...args: unknown[]) => {
			const command = args[0]
			if (Array.isArray(command) && command[0] === "cmux") {
				cmuxCommands.push(command.map(String))
				return {
					exited: Promise.resolve(0),
					kill: () => {
						// no-op
					},
				} as ReturnType<typeof Bun.spawn>
			}

			return {
				stdout: new Blob([""]).stream(),
				stderr: new Blob([""]).stream(),
				exited: Promise.resolve(0),
			} as ReturnType<typeof Bun.spawn>
		})

		const { hooks } = await createPlugin({
			"session-a": { title: "Session A" },
		})

		await emitEvent(hooks, {
			type: "session.status",
			properties: {
				sessionID: "session-a",
				status: {
					type: "busy",
				},
			},
		})
		await Bun.sleep(0)

		if (!tickerCallback) {
			throw new Error("Expected busy ticker callback to be captured")
		}

		expect(tickerIntervalMs).toBe(CMUX_BUSY_SPINNER_INTERVAL_MS)

		tickerCallback()
		await Bun.sleep(0)
		tickerCallback()
		await Bun.sleep(0)
		tickerCallback()
		await Bun.sleep(0)

		await emitEvent(hooks, {
			type: "session.idle",
			properties: {
				sessionID: "session-a",
			},
		})
		await Bun.sleep(0)

		const statusCommands = cmuxCommands.filter(
			(command) => command[1] === "set-status" || command[1] === "clear-status",
		)
		const setStatusTexts = statusCommands
			.filter((command) => command[1] === "set-status")
			.map((command) => command[3])

		expect(setStatusTexts.slice(0, 4)).toEqual(CMUX_BUSY_SPINNER_FRAMES.slice(0, 4))
		expect(statusCommands[statusCommands.length - 1]).toEqual([
			"cmux",
			"clear-status",
			"opencode.session.session-a",
		])
	})

	it("lets non-busy override win after in-flight busy write completes", async () => {
		process.env.CMUX_WORKSPACE_ID = "workspace-123"

		spyOn(Bun, "which").mockImplementation((command: string) =>
			command === "cmux" ? "/usr/local/bin/cmux" : null,
		)

		const cmuxCommands: string[][] = []
		let shouldDelayFirstStatus = true
		let resolveFirstStatusExit: ((exitCode: number) => void) | null = null

		spyOn(Bun, "spawn").mockImplementation((...args: unknown[]) => {
			const command = args[0]
			if (Array.isArray(command) && command[0] === "cmux") {
				cmuxCommands.push(command.map(String))

				if (command[1] === "set-status" && shouldDelayFirstStatus) {
					shouldDelayFirstStatus = false
					return {
						exited: new Promise<number>((resolve) => {
							resolveFirstStatusExit = resolve
						}),
						kill: () => {
							// no-op
						},
					} as ReturnType<typeof Bun.spawn>
				}

				return {
					exited: Promise.resolve(0),
					kill: () => {
						// no-op
					},
				} as ReturnType<typeof Bun.spawn>
			}

			return {
				stdout: new Blob([""]).stream(),
				stderr: new Blob([""]).stream(),
				exited: Promise.resolve(0),
			} as ReturnType<typeof Bun.spawn>
		})

		const { hooks } = await createPlugin({
			"session-a": { title: "Session A" },
		})

		await emitEvent(hooks, {
			type: "session.status",
			properties: {
				sessionID: "session-a",
				status: {
					type: "busy",
				},
			},
		})

		await Bun.sleep(450)

		await emitEvent(hooks, {
			type: "session.error",
			properties: {
				sessionID: "session-a",
				error: "boom",
			},
		})

		const statusCommandsWhileFirstWriteIsPending = cmuxCommands.filter(
			(command) => command[1] === "set-status" || command[1] === "clear-status",
		)
		expect(statusCommandsWhileFirstWriteIsPending).toEqual([
			["cmux", "set-status", "opencode.session.session-a", "⠋"],
		])

		if (!resolveFirstStatusExit) {
			throw new Error("Expected delayed cmux status command to be captured")
		}

		resolveFirstStatusExit(0)
		await Bun.sleep(0)
		await Bun.sleep(0)

		const finalStatusCommands = cmuxCommands.filter(
			(command) => command[1] === "set-status" || command[1] === "clear-status",
		)
		expect(finalStatusCommands).toEqual([
			["cmux", "set-status", "opencode.session.session-a", "⠋"],
			["cmux", "set-status", "opencode.session.session-a", "Error"],
		])
	})

	it("coalesces overlapping cmux status transitions so latest state wins", async () => {
		process.env.CMUX_WORKSPACE_ID = "workspace-123"

		spyOn(Bun, "which").mockImplementation((command: string) =>
			command === "cmux" ? "/usr/local/bin/cmux" : null,
		)

		const cmuxCommands: string[][] = []
		let shouldDelayFirstStatus = true
		let resolveFirstStatusExit: ((exitCode: number) => void) | null = null

		spyOn(Bun, "spawn").mockImplementation((...args: unknown[]) => {
			const command = args[0]
			if (Array.isArray(command) && command[0] === "cmux") {
				cmuxCommands.push(command.map(String))

				if (command[1] === "set-status" && shouldDelayFirstStatus) {
					shouldDelayFirstStatus = false
					return {
						exited: new Promise<number>((resolve) => {
							resolveFirstStatusExit = resolve
						}),
						kill: () => {
							// no-op
						},
					} as ReturnType<typeof Bun.spawn>
				}

				return {
					exited: Promise.resolve(0),
					kill: () => {
						// no-op
					},
				} as ReturnType<typeof Bun.spawn>
			}

			return {
				stdout: new Blob([""]).stream(),
				stderr: new Blob([""]).stream(),
				exited: Promise.resolve(0),
			} as ReturnType<typeof Bun.spawn>
		})

		const { hooks } = await createPlugin({
			"session-a": { title: "Session A" },
		})

		await emitEvent(hooks, {
			type: "session.status",
			properties: {
				sessionID: "session-a",
				status: {
					type: "busy",
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

		await emitEvent(hooks, {
			type: "session.error",
			properties: {
				sessionID: "session-a",
				error: "boom",
			},
		})

		await emitEvent(hooks, {
			type: "session.idle",
			properties: {
				sessionID: "session-a",
			},
		})

		await Bun.sleep(0)

		const statusCommandsWhileFirstIsPending = cmuxCommands.filter(
			(command) => command[1] === "set-status" || command[1] === "clear-status",
		)

		expect(statusCommandsWhileFirstIsPending).toEqual([
			["cmux", "set-status", "opencode.session.session-a", "⠋"],
		])

		if (!resolveFirstStatusExit) {
			throw new Error("Expected delayed cmux status command to be captured")
		}

		resolveFirstStatusExit(0)
		await Bun.sleep(0)
		await Bun.sleep(0)

		const finalStatusCommands = cmuxCommands.filter(
			(command) => command[1] === "set-status" || command[1] === "clear-status",
		)

		expect(finalStatusCommands).toEqual([
			["cmux", "set-status", "opencode.session.session-a", "⠋"],
			["cmux", "clear-status", "opencode.session.session-a"],
		])
	})

	it("constrains status process fan-out before failure resolves and disables future attempts", async () => {
		process.env.CMUX_WORKSPACE_ID = "workspace-123"

		spyOn(Bun, "which").mockImplementation((command: string) =>
			command === "cmux" ? "/usr/local/bin/cmux" : null,
		)

		const cmuxCommands: string[][] = []
		let shouldDelayFirstStatus = true
		let resolveFirstStatusExit: ((exitCode: number) => void) | null = null

		spyOn(Bun, "spawn").mockImplementation((...args: unknown[]) => {
			const command = args[0]
			if (Array.isArray(command) && command[0] === "cmux") {
				cmuxCommands.push(command.map(String))

				if (command[1] === "set-status" && shouldDelayFirstStatus) {
					shouldDelayFirstStatus = false
					return {
						exited: new Promise<number>((resolve) => {
							resolveFirstStatusExit = resolve
						}),
						kill: () => {
							// no-op
						},
					} as ReturnType<typeof Bun.spawn>
				}

				return {
					exited: Promise.resolve(0),
					kill: () => {
						// no-op
					},
				} as ReturnType<typeof Bun.spawn>
			}

			return {
				stdout: new Blob([""]).stream(),
				stderr: new Blob([""]).stream(),
				exited: Promise.resolve(0),
			} as ReturnType<typeof Bun.spawn>
		})

		const { hooks } = await createPlugin({
			"session-a": { title: "Session A" },
		})

		await emitEvent(hooks, {
			type: "session.status",
			properties: {
				sessionID: "session-a",
				status: {
					type: "busy",
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

		await emitEvent(hooks, {
			type: "session.error",
			properties: {
				sessionID: "session-a",
				error: "boom",
			},
		})

		await emitEvent(hooks, {
			type: "session.idle",
			properties: {
				sessionID: "session-a",
			},
		})

		await Bun.sleep(0)

		const statusCommandsBeforeFailureResolves = cmuxCommands.filter(
			(command) => command[1] === "set-status" || command[1] === "clear-status",
		)
		expect(statusCommandsBeforeFailureResolves).toHaveLength(1)

		if (!resolveFirstStatusExit) {
			throw new Error("Expected delayed cmux status command to be captured")
		}

		resolveFirstStatusExit(1)
		await Bun.sleep(0)

		await emitEvent(hooks, {
			type: "session.status",
			properties: {
				sessionID: "session-a",
				status: {
					type: "busy",
				},
			},
		})
		await Bun.sleep(0)

		const statusCommandsAfterFailure = cmuxCommands.filter(
			(command) => command[1] === "set-status" || command[1] === "clear-status",
		)
		expect(statusCommandsAfterFailure).toHaveLength(1)
	})

	it("does not block question notifications when cmux status update is slow and disables status after failure", async () => {
		process.env.CMUX_WORKSPACE_ID = "workspace-123"

		spyOn(Bun, "which").mockImplementation((command: string) =>
			command === "cmux" ? "/usr/local/bin/cmux" : null,
		)

		const cmuxCommands: string[][] = []
		let firstStatusAttempt = true

		spyOn(Bun, "spawn").mockImplementation((...args: unknown[]) => {
			const command = args[0]
			if (Array.isArray(command) && command[0] === "cmux") {
				cmuxCommands.push(command.map(String))

				if (command[1] === "set-status") {
					if (firstStatusAttempt) {
						firstStatusAttempt = false
						return {
							exited: new Promise<number>((resolve) => {
								setTimeout(() => resolve(1), 150)
							}),
							kill: () => {
								// no-op
							},
						} as ReturnType<typeof Bun.spawn>
					}

					return {
						exited: Promise.resolve(0),
						kill: () => {
							// no-op
						},
					} as ReturnType<typeof Bun.spawn>
				}

				if (command[1] === "notify") {
					return {
						exited: Promise.resolve(0),
						kill: () => {
							// no-op
						},
					} as ReturnType<typeof Bun.spawn>
				}
			}

			return {
				stdout: new Blob([""]).stream(),
				stderr: new Blob([""]).stream(),
				exited: Promise.resolve(0),
			} as ReturnType<typeof Bun.spawn>
		})

		const { hooks } = await createPlugin({
			"session-a": { title: "Session A" },
		})

		const start = Date.now()
		await emitEvent(hooks, {
			type: "question.asked",
			properties: {
				id: "question-1",
				sessionID: "session-a",
				questions: [],
			},
		})
		const elapsedMs = Date.now() - start

		expect(elapsedMs).toBeLessThan(120)
		expect(cmuxCommands.some((command) => command[1] === "notify")).toBe(true)

		await Bun.sleep(200)

		await emitEvent(hooks, {
			type: "session.error",
			properties: {
				sessionID: "session-a",
				error: "boom",
			},
		})
		await Bun.sleep(0)

		const statusCommands = cmuxCommands.filter((command) => command[1] === "set-status")
		expect(statusCommands).toHaveLength(1)
	})
})

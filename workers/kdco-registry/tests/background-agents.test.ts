import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import BackgroundAgentsPlugin from "../files/plugins/background-agents"

const { DelegationManager } = BackgroundAgentsPlugin.testInternals

type PromptCall = {
	sessionID: string
	body: {
		noReply?: boolean
		agent?: string
		parts?: Array<{ type: string; text?: string }>
		tools?: Record<string, boolean>
	}
}

type MockClientState = {
	promptCalls: PromptCall[]
	notificationTexts: string[]
	messagesBySession: Map<string, string>
	createdChildSessions: string[]
	artifactExistsOnNotify: boolean
	deletedSessions: string[]
}

type MockClientOptions = {
	rootSessionID: string
	childPromptMode?: "pending" | "resolve"
	agentPermissions?: Record<string, "readonly" | "write">
	onParentPrompt?: (text: string) => Promise<void> | void
}

function createMockClient(options: MockClientOptions): {
	client: unknown
	state: MockClientState
} {
	let childCounter = 0
	const sessionParents = new Map<string, string | undefined>([[options.rootSessionID, undefined]])

	const state: MockClientState = {
		promptCalls: [],
		notificationTexts: [],
		messagesBySession: new Map(),
		createdChildSessions: [],
		artifactExistsOnNotify: false,
		deletedSessions: [],
	}

	const permissionMode = (agent: string): "readonly" | "write" => {
		return options.agentPermissions?.[agent] ?? "readonly"
	}

	const client = {
		app: {
			agents: async () => ({
				data: [
					{ name: "researcher", description: "Read-only research", mode: "subagent" },
					{ name: "explore", description: "Read-only codebase search", mode: "subagent" },
					{ name: "coder", description: "Write-capable implementation", mode: "subagent" },
				],
			}),
			log: async () => ({ data: {} }),
		},
		config: {
			get: async () => ({
				data: {
					agent: {
						researcher: {
							permission:
								permissionMode("researcher") === "readonly"
									? { edit: "deny", write: "deny", bash: { "*": "deny" } }
									: { edit: "allow", write: "allow", bash: { "*": "allow" } },
						},
						explore: {
							permission:
								permissionMode("explore") === "readonly"
									? { edit: "deny", write: "deny", bash: { "*": "deny" } }
									: { edit: "allow", write: "allow", bash: { "*": "allow" } },
						},
						coder: {
							permission:
								permissionMode("coder") === "readonly"
									? { edit: "deny", write: "deny", bash: { "*": "deny" } }
									: { edit: "allow", write: "allow", bash: { "*": "allow" } },
						},
					},
				},
			}),
		},
		session: {
			get: async ({ path: { id } }: { path: { id: string } }) => ({
				data: {
					id,
					parentID: sessionParents.get(id),
				},
			}),
			create: async ({ body }: { body: { parentID: string } }) => {
				childCounter += 1
				const childID = `child-${childCounter}`
				sessionParents.set(childID, body.parentID)
				state.createdChildSessions.push(childID)
				return { data: { id: childID } }
			},
			prompt: async ({
				path: { id },
				body,
			}: {
				path: { id: string }
				body: PromptCall["body"]
			}) => {
				state.promptCalls.push({ sessionID: id, body })

				if (id === options.rootSessionID) {
					const text = body.parts?.[0]?.text || ""
					state.notificationTexts.push(text)
					await options.onParentPrompt?.(text)
					return { data: { parts: [] } }
				}

				if (options.childPromptMode === "pending") {
					return await new Promise<never>(() => {})
				}

				return { data: { parts: [] } }
			},
			messages: async ({ path: { id } }: { path: { id: string } }) => {
				const text = state.messagesBySession.get(id)
				if (!text) return { data: [] }

				return {
					data: [
						{
							info: { role: "assistant" },
							parts: [{ type: "text", text }],
						},
					],
				}
			},
			delete: async ({ path: { id } }: { path: { id: string } }) => {
				state.deletedSessions.push(id)
				return { data: {} }
			},
		},
	}

	return { client, state }
}

function createNoopLogger() {
	return {
		debug: async () => {},
		info: async () => {},
		warn: async () => {},
		error: async () => {},
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function getPromptText(call: PromptCall): string {
	return call.body.parts?.[0]?.text || ""
}

let originalHome: string | undefined
const testDirs: string[] = []

beforeEach(async () => {
	originalHome = process.env.HOME
	const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "background-agents-home-"))
	testDirs.push(testHome)
	process.env.HOME = testHome
})

afterEach(async () => {
	process.env.HOME = originalHome

	for (const dir of testDirs.splice(0, testDirs.length)) {
		await fs.rm(dir, { recursive: true, force: true })
	}
})

describe("background-agents lifecycle refactor", () => {
	it("registers before execution, reuses stable ID, persists before notify, and suppresses duplicate terminal notifications", async () => {
		const rootSessionID = "root-session"
		const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "background-agents-manager-"))
		testDirs.push(baseDir)

		const { client, state } = createMockClient({
			rootSessionID,
			childPromptMode: "pending",
			onParentPrompt: async (text) => {
				if (!text.includes("<task-id>stable-lifecycle-id</task-id>")) return

				const artifactPathMatch = text.match(/<artifact>([^<]+)<\/artifact>/)
				if (!artifactPathMatch) return

				try {
					await fs.access(artifactPathMatch[1])
					state.artifactExistsOnNotify = true
				} catch {
					state.artifactExistsOnNotify = false
				}
			},
		})

		const manager = new DelegationManager(client as never, baseDir, createNoopLogger(), {
			idGenerator: () => "stable-lifecycle-id",
			metadataGenerator: async () => ({
				title: "Lifecycle Result",
				description: "Lifecycle checks complete.",
			}),
		})

		const delegation = await manager.delegate({
			parentSessionID: rootSessionID,
			parentMessageID: "msg-1",
			parentAgent: "plan",
			prompt: "Research delegation lifecycle behavior",
			agent: "researcher",
		})

		expect(delegation.id).toBe("stable-lifecycle-id")

		const runningList = await manager.listDelegations(rootSessionID)
		expect(runningList.find((item) => item.id === delegation.id)?.status).toBe("running")

		state.messagesBySession.set(delegation.sessionID, "Lifecycle result body")
		await manager.handleSessionIdle(delegation.sessionID)

		expect(state.artifactExistsOnNotify).toBe(true)

		const readOutput = await manager.readOutput(rootSessionID, delegation.id)
		expect(readOutput).toContain("**ID:** stable-lifecycle-id")
		expect(readOutput).toContain("Lifecycle result body")

		manager.handleMessageEvent(delegation.sessionID, "late progress update")
		await manager.handleSessionIdle(delegation.sessionID)

		const completedList = await manager.listDelegations(rootSessionID)
		expect(completedList.find((item) => item.id === delegation.id)?.status).toBe("complete")

		const terminalNotifications = state.notificationTexts.filter((text) =>
			text.includes("<task-id>stable-lifecycle-id</task-id>"),
		)
		expect(terminalNotifications).toHaveLength(1)
	})

	it("delegation_read blocks until terminal and resolves deterministic timeout path", async () => {
		const rootSessionID = "root-session"
		const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "background-agents-read-"))
		testDirs.push(baseDir)

		const { client, state } = createMockClient({
			rootSessionID,
			childPromptMode: "pending",
		})

		const manager = new DelegationManager(client as never, baseDir, createNoopLogger(), {
			idGenerator: (() => {
				const ids = ["blocking-read-id", "timeout-read-id"]
				return () => {
					const next = ids.shift()
					if (!next) throw new Error("No IDs left")
					return next
				}
			})(),
			maxRunTimeMs: 30,
			terminalWaitGraceMs: 20,
			metadataGenerator: async () => ({
				title: "Read Result",
				description: "Read path completed.",
			}),
		})

		const blockingDelegation = await manager.delegate({
			parentSessionID: rootSessionID,
			parentMessageID: "msg-1",
			parentAgent: "plan",
			prompt: "Run slowly",
			agent: "researcher",
		})

		const start = Date.now()
		const readPromise = manager.readOutput(rootSessionID, blockingDelegation.id)

		await sleep(40)
		state.messagesBySession.set(blockingDelegation.sessionID, "Delayed completion output")
		await manager.handleSessionIdle(blockingDelegation.sessionID)

		const blockingResult = await readPromise
		expect(Date.now() - start).toBeGreaterThanOrEqual(35)
		expect(blockingResult).toContain("Delayed completion output")

		const timeoutDelegation = await manager.delegate({
			parentSessionID: rootSessionID,
			parentMessageID: "msg-2",
			parentAgent: "plan",
			prompt: "Never finish",
			agent: "researcher",
		})

		const timeoutResult = await manager.readOutput(rootSessionID, timeoutDelegation.id)
		expect(timeoutResult).toContain("**Status:** timeout")
		expect(timeoutResult).toContain("[TIMEOUT REACHED]")
	})

	it("sends a single all-complete notification for staggered completions", async () => {
		const rootSessionID = "root-session"
		const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "background-agents-staggered-"))
		testDirs.push(baseDir)
		const allCompleteQuietPeriodMs = 50

		const { client, state } = createMockClient({
			rootSessionID,
			childPromptMode: "pending",
		})

		const manager = new DelegationManager(client as never, baseDir, createNoopLogger(), {
			idGenerator: (() => {
				const ids = ["slow-complete-id", "fast-complete-id"]
				return () => {
					const next = ids.shift()
					if (!next) throw new Error("No IDs left")
					return next
				}
			})(),
			metadataGenerator: async (_client, resultContent) => {
				if (resultContent.includes("slow completion")) {
					await sleep(120)
				}
				return {
					title: "Staggered",
					description: "Completion order test.",
				}
			},
			allCompleteQuietPeriodMs,
		})

		const slowDelegation = await manager.delegate({
			parentSessionID: rootSessionID,
			parentMessageID: "msg-1",
			parentAgent: "plan",
			prompt: "Run slow completion",
			agent: "researcher",
		})

		const fastDelegation = await manager.delegate({
			parentSessionID: rootSessionID,
			parentMessageID: "msg-2",
			parentAgent: "plan",
			prompt: "Run fast completion",
			agent: "researcher",
		})

		state.messagesBySession.set(slowDelegation.sessionID, "slow completion payload")
		state.messagesBySession.set(fastDelegation.sessionID, "fast completion payload")

		const slowFinalize = manager.handleSessionIdle(slowDelegation.sessionID)
		await sleep(15)
		await manager.handleSessionIdle(fastDelegation.sessionID)
		await slowFinalize
		await sleep(allCompleteQuietPeriodMs + 30)

		const allCompleteNotifications = state.notificationTexts.filter((text) =>
			text.includes("<summary>All delegations complete.</summary>"),
		)
		expect(allCompleteNotifications).toHaveLength(1)

		const terminalNotifications = state.notificationTexts.filter((text) =>
			text.includes("<task-id>"),
		)
		expect(terminalNotifications).toHaveLength(2)

		const parentPromptCalls = state.promptCalls.filter((call) => call.sessionID === rootSessionID)
		const terminalPromptCalls = parentPromptCalls.filter((call) =>
			getPromptText(call).includes("<task-id>"),
		)
		expect(terminalPromptCalls).toHaveLength(2)
		const terminalPromptIndices = parentPromptCalls
			.map((call, index) => ({ call, index }))
			.filter(({ call }) => getPromptText(call).includes("<task-id>"))
			.map(({ index }) => index)
		expect(terminalPromptIndices).toHaveLength(2)
		for (const call of terminalPromptCalls) {
			expect(call.body.noReply).toBe(true)
		}

		const allCompletePromptCalls = parentPromptCalls.filter((call) =>
			getPromptText(call).includes("<summary>All delegations complete.</summary>"),
		)
		expect(allCompletePromptCalls).toHaveLength(1)
		expect(allCompletePromptCalls[0]?.body.noReply).toBe(false)
		const allCompletePromptIndex = parentPromptCalls.findIndex((call) =>
			getPromptText(call).includes("<summary>All delegations complete.</summary>"),
		)
		expect(allCompletePromptIndex).toBeGreaterThan(Math.max(...terminalPromptIndices))
	})

	it("allows batch B registration while cycle A all-complete is pending and suppresses stale cycle A before dispatch", async () => {
		const rootSessionID = "root-session"
		const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "background-agents-next-cycle-"))
		testDirs.push(baseDir)

		const allCompleteQuietPeriodMs = 120

		const { client, state } = createMockClient({
			rootSessionID,
			childPromptMode: "pending",
		})

		const manager = new DelegationManager(client as never, baseDir, createNoopLogger(), {
			idGenerator: (() => {
				const ids = ["batch-a-id", "batch-b-id"]
				return () => {
					const next = ids.shift()
					if (!next) throw new Error("No IDs left")
					return next
				}
			})(),
			metadataGenerator: async () => ({
				title: "Cycle race",
				description: "Cross-cycle all-complete race test.",
			}),
			allCompleteQuietPeriodMs,
		})

		const batchADelegation = await manager.delegate({
			parentSessionID: rootSessionID,
			parentMessageID: "msg-a",
			parentAgent: "plan",
			prompt: "Batch A work",
			agent: "researcher",
		})

		state.messagesBySession.set(batchADelegation.sessionID, "Batch A result")
		await manager.handleSessionIdle(batchADelegation.sessionID)

		const allCompleteAfterBatchAFinalize = state.notificationTexts.filter((text) =>
			text.includes("<summary>All delegations complete.</summary>"),
		)
		expect(allCompleteAfterBatchAFinalize).toHaveLength(0)

		const batchBDelegationPromise = manager.delegate({
			parentSessionID: rootSessionID,
			parentMessageID: "msg-b",
			parentAgent: "plan",
			prompt: "Batch B work",
			agent: "researcher",
		})

		const batchBDelegation = await Promise.race([
			batchBDelegationPromise,
			sleep(50).then(() => null),
		])
		expect(batchBDelegation).not.toBeNull()
		if (!batchBDelegation) {
			throw new Error("Batch B delegation did not register immediately")
		}
		expect(batchBDelegation.id).toBe("batch-b-id")

		expect(manager.getPendingCount(rootSessionID)).toBe(1)

		await sleep(allCompleteQuietPeriodMs + 40)

		const allCompleteBeforeBatchBFinalize = state.notificationTexts.filter((text) =>
			text.includes("<summary>All delegations complete.</summary>"),
		)
		expect(allCompleteBeforeBatchBFinalize).toHaveLength(0)

		const notificationCountAtBatchBStart = state.notificationTexts.length

		state.messagesBySession.set(batchBDelegation.sessionID, "Batch B result")
		await manager.handleSessionIdle(batchBDelegation.sessionID)
		await sleep(allCompleteQuietPeriodMs + 40)

		const allCompleteNotifications = state.notificationTexts.filter((text) =>
			text.includes("<summary>All delegations complete.</summary>"),
		)
		expect(allCompleteNotifications).toHaveLength(1)
		expect(allCompleteNotifications[0]).toContain("<cycle>2</cycle>")
		expect(allCompleteNotifications[0]).toContain(
			`<cycle-token>${batchBDelegation.notificationCycleToken}</cycle-token>`,
		)
		expect(allCompleteNotifications[0]).not.toContain(
			`<cycle-token>${batchADelegation.notificationCycleToken}</cycle-token>`,
		)

		const notificationsAfterBatchBStart = state.notificationTexts
			.slice(notificationCountAtBatchBStart)
			.filter((text) => text.includes("<summary>All delegations complete.</summary>"))
		expect(notificationsAfterBatchBStart).toHaveLength(1)
		expect(notificationsAfterBatchBStart[0]).toContain("<cycle>2</cycle>")
	})

	it("preserves unread carry-forward when delegation_read returns terminal fallback first", async () => {
		const rootSessionID = "root-session"
		const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "background-agents-fallback-"))
		testDirs.push(baseDir)

		const { client, state } = createMockClient({
			rootSessionID,
			childPromptMode: "pending",
		})

		const manager = new DelegationManager(client as never, baseDir, createNoopLogger(), {
			idGenerator: () => "fallback-read-id",
			readPollIntervalMs: 10,
			metadataGenerator: async () => {
				await sleep(800)
				return {
					title: "Delayed persistence",
					description: "Artifact appears later.",
				}
			},
		})

		const delegation = await manager.delegate({
			parentSessionID: rootSessionID,
			parentMessageID: "msg-1",
			parentAgent: "plan",
			prompt: "Delay metadata and persistence",
			agent: "researcher",
		})

		state.messagesBySession.set(delegation.sessionID, "Terminal output before persistence")

		const finalizePromise = manager.handleSessionIdle(delegation.sessionID)
		await sleep(20)

		const fallbackRead = await manager.readOutput(rootSessionID, delegation.id)
		expect(fallbackRead).toContain("Delegation ID: fallback-read-id")
		expect(fallbackRead).toContain(
			'Use delegation_read("fallback-read-id") again after persistence completes.',
		)

		await finalizePromise

		const unreadAfterFallback = manager.getUnreadCompletedDelegations(rootSessionID)
		expect(unreadAfterFallback.some((item) => item.id === delegation.id)).toBe(true)

		const persistedRead = await manager.readOutput(rootSessionID, delegation.id)
		expect(persistedRead).toContain("**ID:** fallback-read-id")

		const unreadAfterArtifactRead = manager.getUnreadCompletedDelegations(rootSessionID)
		expect(unreadAfterArtifactRead.some((item) => item.id === delegation.id)).toBe(false)
	})

	it("compaction carries running/unread tasks and routing boundaries are enforced", async () => {
		const rootSessionID = "root-session"
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "background-agents-project-"))
		testDirs.push(projectDir)

		const { client, state } = createMockClient({
			rootSessionID,
			childPromptMode: "pending",
			agentPermissions: {
				researcher: "readonly",
				coder: "write",
			},
		})

		const hooks = await BackgroundAgentsPlugin({
			client,
			directory: projectDir,
		} as never)
		const abortSignal = new AbortController().signal

		const delegateTool = hooks.tool?.delegate as unknown as {
			execute: (
				args: { prompt: string; agent: string },
				ctx: { sessionID: string; messageID: string; agent: string; abort: AbortSignal },
			) => Promise<string>
		}
		const readTool = hooks.tool?.delegation_read as unknown as {
			execute: (
				args: { id: string },
				ctx: { sessionID: string; messageID: string; agent: string; abort: AbortSignal },
			) => Promise<string>
		}

		const delegateResponse = await delegateTool.execute(
			{ prompt: "Research unread compaction behavior", agent: "researcher" },
			{ sessionID: rootSessionID, messageID: "msg-1", agent: "plan", abort: abortSignal },
		)

		const delegationIdMatch = delegateResponse.match(/Delegation started: ([^\n]+)/)
		expect(delegationIdMatch).not.toBeNull()
		const delegationID = delegationIdMatch?.[1]
		if (!delegationID) throw new Error("Delegation ID missing from delegate response")

		const compactionHook = hooks["experimental.session.compacting"] as (
			input: { sessionID: string },
			output: { context: string[] },
		) => Promise<void>

		const runningCompaction = { context: [] as string[] }
		await compactionHook({ sessionID: rootSessionID }, runningCompaction)
		expect(runningCompaction.context.join("\n")).toContain("## Running Delegations")
		expect(runningCompaction.context.join("\n")).toContain(delegationID)

		const childSessionID = state.createdChildSessions[0]
		state.messagesBySession.set(childSessionID, "Unread completion payload")

		const eventHook = hooks.event as (input: { event: Record<string, unknown> }) => Promise<void>
		await eventHook({
			event: {
				type: "session.idle",
				properties: { sessionID: childSessionID },
			},
		})

		const unreadCompaction = { context: [] as string[] }
		await compactionHook({ sessionID: rootSessionID }, unreadCompaction)
		expect(unreadCompaction.context.join("\n")).toContain("## Unread Completed Delegations")
		expect(unreadCompaction.context.join("\n")).toContain(`delegation_read("${delegationID}")`)

		await readTool.execute(
			{ id: delegationID },
			{ sessionID: rootSessionID, messageID: "msg-3", agent: "plan", abort: abortSignal },
		)

		const postReadCompaction = { context: [] as string[] }
		await compactionHook({ sessionID: rootSessionID }, postReadCompaction)
		expect(postReadCompaction.context).toHaveLength(0)

		const writeCapableResponse = await delegateTool.execute(
			{ prompt: "Try write-capable delegation", agent: "coder" },
			{ sessionID: rootSessionID, messageID: "msg-2", agent: "plan", abort: abortSignal },
		)
		expect(writeCapableResponse).toContain("write-capable")

		const taskBeforeHook = hooks["tool.execute.before"] as (
			input: { tool: string },
			output: { args?: { subagent_type?: string } },
		) => Promise<void>

		await expect(
			taskBeforeHook({ tool: "task" }, { args: { subagent_type: "researcher" } }),
		).rejects.toThrow("read-only")
	})
})

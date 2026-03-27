/**
 * notify
 * Native OS notifications for OpenCode
 *
 * Philosophy: "Notify the human when the AI needs them back, not for every micro-event."
 *
 * Features:
 * - Uses cmux native notifications when running inside cmux
 * - Auto-detects terminal emulator (Ghostty, Kitty, iTerm, WezTerm, etc.)
 * - Suppresses notifications when terminal is focused (like Ghostty does)
 * - Click notification to focus terminal
 * - Parent session only by default (no spam from sub-tasks)
 *
 * Uses cmux CLI first (if available), then node-notifier fallback:
 * - cmux: `cmux notify --title ... --subtitle ... --body ...`
 * - macOS: terminal-notifier (native NSUserNotificationCenter)
 * - Windows: SnoreToast (native toast notifications)
 * - Linux: notify-send (native desktop notifications)
 */

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"
// @ts-expect-error - installed at runtime by OCX
import detectTerminal from "detect-terminal"
// @ts-expect-error - installed at runtime by OCX
import notifier from "node-notifier"
import type { OpencodeClient } from "./kdco-primitives/types"
import { sendNotificationWithFallback } from "./notify/backend"
import { canUseCmuxNotification, sendCmuxNotification } from "./notify/cmux"

interface NotifyConfig {
	/** Notify for child/sub-session events (default: false) */
	notifyChildSessions: boolean
	/** Sound configuration per event type */
	sounds: {
		idle: string
		error: string
		permission: string
		question?: string
	}
	/** Quiet hours configuration */
	quietHours: {
		enabled: boolean
		start: string // "HH:MM" format
		end: string // "HH:MM" format
	}
	/** Override terminal detection (optional) */
	terminal?: string
}

interface TerminalInfo {
	name: string | null
	bundleId: string | null
	processName: string | null
}

const DEFAULT_CONFIG: NotifyConfig = {
	notifyChildSessions: false,
	sounds: {
		idle: "Glass",
		error: "Basso",
		permission: "Submarine",
	},
	quietHours: {
		enabled: false,
		start: "22:00",
		end: "08:00",
	},
}

// Terminal name to macOS process name mapping (for focus detection)
const TERMINAL_PROCESS_NAMES: Record<string, string> = {
	ghostty: "Ghostty",
	kitty: "kitty",
	iterm: "iTerm2",
	iterm2: "iTerm2",
	wezterm: "WezTerm",
	alacritty: "Alacritty",
	terminal: "Terminal",
	apple_terminal: "Terminal",
	hyper: "Hyper",
	warp: "Warp",
	vscode: "Code",
	"vscode-insiders": "Code - Insiders",
}

// ==========================================
// CONFIGURATION
// ==========================================

async function loadConfig(): Promise<NotifyConfig> {
	const configPath = path.join(os.homedir(), ".config", "opencode", "kdco-notify.json")

	try {
		const content = await fs.readFile(configPath, "utf8")
		const userConfig = JSON.parse(content) as Partial<NotifyConfig>

		// Merge with defaults
		return {
			...DEFAULT_CONFIG,
			...userConfig,
			sounds: {
				...DEFAULT_CONFIG.sounds,
				...userConfig.sounds,
			},
			quietHours: {
				...DEFAULT_CONFIG.quietHours,
				...userConfig.quietHours,
			},
		}
	} catch {
		// Config doesn't exist or is invalid, use defaults
		return DEFAULT_CONFIG
	}
}

// ==========================================
// TERMINAL DETECTION (macOS)
// ==========================================

async function runOsascript(script: string): Promise<string | null> {
	if (process.platform !== "darwin") return null

	try {
		const proc = Bun.spawn(["osascript", "-e", script], {
			stdout: "pipe",
			stderr: "pipe",
		})
		const output = await new Response(proc.stdout).text()
		return output.trim()
	} catch {
		return null
	}
}

async function getBundleId(appName: string): Promise<string | null> {
	return runOsascript(`id of application "${appName}"`)
}

async function getFrontmostApp(): Promise<string | null> {
	return runOsascript(
		'tell application "System Events" to get name of first application process whose frontmost is true',
	)
}

async function detectTerminalInfo(config: NotifyConfig): Promise<TerminalInfo> {
	// Use config override if provided
	const terminalName = config.terminal || detectTerminal() || null

	if (!terminalName) {
		return { name: null, bundleId: null, processName: null }
	}

	// Get process name for focus detection
	const processName = TERMINAL_PROCESS_NAMES[terminalName.toLowerCase()] || terminalName

	// Dynamically get bundle ID from macOS (no hardcoding!)
	const bundleId = await getBundleId(processName)

	return {
		name: terminalName,
		bundleId,
		processName,
	}
}

async function isTerminalFocused(terminalInfo: TerminalInfo): Promise<boolean> {
	if (!terminalInfo.processName) return false
	if (process.platform !== "darwin") return false

	const frontmost = await getFrontmostApp()
	if (!frontmost) return false

	// Case-insensitive comparison
	return frontmost.toLowerCase() === terminalInfo.processName.toLowerCase()
}

// ==========================================
// QUIET HOURS CHECK
// ==========================================

function isQuietHours(config: NotifyConfig): boolean {
	if (!config.quietHours.enabled) return false

	const now = new Date()
	const currentMinutes = now.getHours() * 60 + now.getMinutes()

	const [startHour, startMin] = config.quietHours.start.split(":").map(Number)
	const [endHour, endMin] = config.quietHours.end.split(":").map(Number)

	const startMinutes = startHour * 60 + startMin
	const endMinutes = endHour * 60 + endMin

	// Handle overnight quiet hours (e.g., 22:00 - 08:00)
	if (startMinutes > endMinutes) {
		return currentMinutes >= startMinutes || currentMinutes < endMinutes
	}

	return currentMinutes >= startMinutes && currentMinutes < endMinutes
}

// ==========================================
// PARENT SESSION DETECTION
// ==========================================

async function isParentSession(client: OpencodeClient, sessionID: string): Promise<boolean> {
	try {
		const session = await client.session.get({ path: { id: sessionID } })
		// No parentID means this IS the parent/root session
		return !session.data?.parentID
	} catch {
		// If we can't fetch, assume it's a parent to be safe (notify rather than miss)
		return true
	}
}

// ==========================================
// NOTIFICATION SENDER
// ==========================================

interface NotificationOptions {
	title: string
	message: string
	subtitle?: string
	cmuxBody?: string
	sound: string
	terminalInfo: TerminalInfo
}

interface NotificationRuntime {
	preferCmux: boolean
}

const QUESTION_DEDUPE_WINDOW_MS = 1500
const READY_DEDUPE_WINDOW_MS = 1500
const PERMISSION_DEDUPE_WINDOW_MS = 1500

type RecentNotifications = Map<string, number>

function toNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") return null

	const normalized = value.trim()
	if (!normalized) return null

	return normalized
}

function shouldSendDedupedNotification(
	recentNotifications: RecentNotifications,
	dedupeKey: string,
	windowMs: number,
	nowMs = Date.now(),
): boolean {
	for (const [key, timestamp] of recentNotifications) {
		if (nowMs - timestamp >= windowMs) {
			recentNotifications.delete(key)
		}
	}

	const lastSentAt = recentNotifications.get(dedupeKey)
	if (lastSentAt !== undefined && nowMs - lastSentAt < windowMs) {
		return false
	}

	recentNotifications.set(dedupeKey, nowMs)
	return true
}

function buildQuestionToolDedupeKey(sessionID: unknown, callID: unknown): string | null {
	const normalizedSessionID = toNonEmptyString(sessionID)
	if (!normalizedSessionID) return null

	const normalizedCallID = toNonEmptyString(callID)
	if (!normalizedCallID) return null

	return `question:${normalizedSessionID}:${normalizedCallID}`
}

function buildQuestionEventDedupeKey(properties: unknown): string | null {
	if (!properties || typeof properties !== "object") return null

	const record = properties as Record<string, unknown>
	const normalizedSessionID = toNonEmptyString(record.sessionID)
	if (!normalizedSessionID) return null

	const toolInfo =
		record.tool && typeof record.tool === "object"
			? (record.tool as Record<string, unknown>)
			: undefined
	const normalizedCallID = toNonEmptyString(toolInfo?.callID)
	if (normalizedCallID) {
		return `question:${normalizedSessionID}:${normalizedCallID}`
	}

	const normalizedRequestID = toNonEmptyString(record.id)
	if (normalizedRequestID) {
		return `question:${normalizedSessionID}:request:${normalizedRequestID}`
	}

	return null
}

function buildSessionReadyDedupeKey(sessionID: unknown): string | null {
	const normalizedSessionID = toNonEmptyString(sessionID)
	if (!normalizedSessionID) return null

	return `session-ready:${normalizedSessionID}`
}

function buildPermissionEventDedupeKey(properties: unknown): string | null {
	if (!properties || typeof properties !== "object") return null

	const record = properties as Record<string, unknown>
	const normalizedRequestID = toNonEmptyString(record.id)
	if (!normalizedRequestID) return null

	return `permission:request:${normalizedRequestID}`
}

function sendNodeNotification(options: NotificationOptions): void {
	const { title, message, sound, terminalInfo } = options

	// Base notification options
	const notifyOptions: Record<string, unknown> = {
		title,
		message,
		sound,
	}

	// macOS-specific: click notification to focus terminal
	if (process.platform === "darwin" && terminalInfo.bundleId) {
		notifyOptions.activate = terminalInfo.bundleId
	}

	notifier.notify(notifyOptions)
}

async function sendNotification(
	options: NotificationOptions,
	runtime: NotificationRuntime,
): Promise<void> {
	await sendNotificationWithFallback({
		preferCmux: runtime.preferCmux,
		tryCmuxNotify: () =>
			sendCmuxNotification({
				title: options.title,
				subtitle: options.subtitle,
				body: options.cmuxBody ?? options.message,
			}),
		sendNodeNotify: () => sendNodeNotification(options),
	})
}

// ==========================================
// EVENT HANDLERS
// ==========================================

async function handleSessionIdle(
	client: OpencodeClient,
	sessionID: string,
	config: NotifyConfig,
	terminalInfo: TerminalInfo,
	notificationRuntime: NotificationRuntime,
): Promise<void> {
	// Check if we should notify for this session
	if (!config.notifyChildSessions) {
		const isParent = await isParentSession(client, sessionID)
		if (!isParent) return
	}

	// Check quiet hours
	if (isQuietHours(config)) return

	// Check if terminal is focused (suppress notification if user is already looking)
	if (await isTerminalFocused(terminalInfo)) return

	// Get session info for context
	let sessionTitle = "Task"
	try {
		const session = await client.session.get({ path: { id: sessionID } })
		if (session.data?.title) {
			sessionTitle = session.data.title.slice(0, 50)
		}
	} catch {
		// Use default title
	}

	await sendNotification(
		{
			title: "Ready for review",
			message: sessionTitle,
			subtitle: sessionTitle,
			cmuxBody: "OpenCode task is ready for review",
			sound: config.sounds.idle,
			terminalInfo,
		},
		notificationRuntime,
	)
}

async function handleSessionError(
	client: OpencodeClient,
	sessionID: string,
	error: string | undefined,
	config: NotifyConfig,
	terminalInfo: TerminalInfo,
	notificationRuntime: NotificationRuntime,
): Promise<void> {
	// Check if we should notify for this session
	if (!config.notifyChildSessions) {
		const isParent = await isParentSession(client, sessionID)
		if (!isParent) return
	}

	// Check quiet hours
	if (isQuietHours(config)) return

	// Check if terminal is focused (suppress notification if user is already looking)
	if (await isTerminalFocused(terminalInfo)) return

	const errorMessage = error?.slice(0, 100) || "Something went wrong"

	await sendNotification(
		{
			title: "Something went wrong",
			message: errorMessage,
			sound: config.sounds.error,
			terminalInfo,
		},
		notificationRuntime,
	)
}

async function handlePermissionUpdated(
	config: NotifyConfig,
	terminalInfo: TerminalInfo,
	notificationRuntime: NotificationRuntime,
): Promise<void> {
	// Always notify for permission events - AI is blocked waiting for human
	// No parent check needed: permissions always need human attention

	// Check quiet hours
	if (isQuietHours(config)) return

	// Check if terminal is focused (suppress notification if user is already looking)
	if (await isTerminalFocused(terminalInfo)) return

	await sendNotification(
		{
			title: "Waiting for you",
			message: "OpenCode needs your input",
			sound: config.sounds.permission,
			terminalInfo,
		},
		notificationRuntime,
	)
}

async function handleQuestionAsked(
	config: NotifyConfig,
	terminalInfo: TerminalInfo,
	notificationRuntime: NotificationRuntime,
): Promise<void> {
	// Guard: quiet hours only (no focus check for questions - tmux workflow)
	if (isQuietHours(config)) return

	const sound = config.sounds.question ?? config.sounds.permission

	await sendNotification(
		{
			title: "Question for you",
			message: "OpenCode needs your input",
			sound,
			terminalInfo,
		},
		notificationRuntime,
	)
}

// ==========================================
// PLUGIN EXPORT
// ==========================================

export const NotifyPlugin: Plugin = async (ctx) => {
	const { client } = ctx

	// Load config once at startup
	const config = await loadConfig()

	// Detect terminal once at startup (cached for performance)
	const terminalInfo = await detectTerminalInfo(config)
	const notificationRuntime: NotificationRuntime = {
		preferCmux: canUseCmuxNotification(),
	}
	const recentQuestionNotifications: RecentNotifications = new Map()
	const recentReadyNotifications: RecentNotifications = new Map()
	const recentPermissionNotifications: RecentNotifications = new Map()

	const notifyQuestionIfNeeded = async (dedupeKey: string | null): Promise<void> => {
		if (
			dedupeKey &&
			!shouldSendDedupedNotification(
				recentQuestionNotifications,
				dedupeKey,
				QUESTION_DEDUPE_WINDOW_MS,
			)
		) {
			return
		}

		await handleQuestionAsked(config, terminalInfo, notificationRuntime)
	}

	const notifySessionReadyIfNeeded = async (sessionID: unknown): Promise<void> => {
		const normalizedSessionID = toNonEmptyString(sessionID)
		if (!normalizedSessionID) return

		const dedupeKey = buildSessionReadyDedupeKey(normalizedSessionID)
		if (!dedupeKey) return

		if (
			!shouldSendDedupedNotification(recentReadyNotifications, dedupeKey, READY_DEDUPE_WINDOW_MS)
		) {
			return
		}

		await handleSessionIdle(
			client as OpencodeClient,
			normalizedSessionID,
			config,
			terminalInfo,
			notificationRuntime,
		)
	}

	const notifyPermissionIfNeeded = async (properties: unknown): Promise<void> => {
		const dedupeKey = buildPermissionEventDedupeKey(properties)

		if (
			dedupeKey &&
			!shouldSendDedupedNotification(
				recentPermissionNotifications,
				dedupeKey,
				PERMISSION_DEDUPE_WINDOW_MS,
			)
		) {
			return
		}

		await handlePermissionUpdated(config, terminalInfo, notificationRuntime)
	}

	return {
		"tool.execute.before": async (input: { tool: string; sessionID: string; callID: string }) => {
			if (input.tool === "question") {
				await notifyQuestionIfNeeded(buildQuestionToolDedupeKey(input.sessionID, input.callID))
			}
		},
		event: async ({ event }: { event: Event }): Promise<void> => {
			const runtimeEvent = event as { type: string; properties: Record<string, unknown> }

			switch (runtimeEvent.type) {
				case "session.status": {
					const sessionID = runtimeEvent.properties.sessionID
					const statusType =
						runtimeEvent.properties.status && typeof runtimeEvent.properties.status === "object"
							? ((runtimeEvent.properties.status as { type?: string }).type ?? undefined)
							: undefined

					if (sessionID && statusType === "idle") {
						await notifySessionReadyIfNeeded(sessionID)
					}
					break
				}
				case "session.idle": {
					await notifySessionReadyIfNeeded(runtimeEvent.properties.sessionID)
					break
				}
				case "session.error": {
					const sessionID = toNonEmptyString(runtimeEvent.properties.sessionID)
					const error = runtimeEvent.properties.error
					const errorMessage = typeof error === "string" ? error : error ? String(error) : undefined
					if (sessionID) {
						await handleSessionError(
							client as OpencodeClient,
							sessionID,
							errorMessage,
							config,
							terminalInfo,
							notificationRuntime,
						)
					}
					break
				}

				case "permission.updated":
				case "permission.asked": {
					await notifyPermissionIfNeeded(runtimeEvent.properties)
					break
				}
				case "question.asked": {
					const dedupeKey = buildQuestionEventDedupeKey(runtimeEvent.properties)
					await notifyQuestionIfNeeded(dedupeKey)
					break
				}
			}
		},
	}
}

export default NotifyPlugin

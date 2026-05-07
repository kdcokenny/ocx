import { describe, expect, it, mock } from "bun:test"
import {
	buildAlerterArguments,
	sendDesktopNotificationByPlatform,
	sendMacOSAlerterNotification,
	sendNotificationWithFallback,
} from "../files/plugins/notify/backend"
import { sendCmuxNotification } from "../files/plugins/notify/cmux"

describe("notify backend fallback behavior", () => {
	it("uses desktop notifications directly when cmux is not preferred", async () => {
		const tryCmuxNotify = mock(async () => true)
		const sendDesktopNotification = mock(() => {})

		await sendNotificationWithFallback({
			preferCmux: false,
			tryCmuxNotify,
			sendDesktopNotification,
		})

		expect(tryCmuxNotify).not.toHaveBeenCalled()
		expect(sendDesktopNotification).toHaveBeenCalledTimes(1)
	})

	it("prefers cmux when cmux delivery succeeds", async () => {
		const tryCmuxNotify = mock(async () => true)
		const sendDesktopNotification = mock(() => {})

		await sendNotificationWithFallback({
			preferCmux: true,
			tryCmuxNotify,
			sendDesktopNotification,
		})

		expect(tryCmuxNotify).toHaveBeenCalledTimes(1)
		expect(sendDesktopNotification).not.toHaveBeenCalled()
	})

	it("falls back to desktop notifications when cmux returns false", async () => {
		const tryCmuxNotify = mock(async () => false)
		const sendDesktopNotification = mock(() => {})

		await sendNotificationWithFallback({
			preferCmux: true,
			tryCmuxNotify,
			sendDesktopNotification,
		})

		expect(tryCmuxNotify).toHaveBeenCalledTimes(1)
		expect(sendDesktopNotification).toHaveBeenCalledTimes(1)
	})

	it("falls back to desktop notifications when cmux throws", async () => {
		const tryCmuxNotify = mock(async () => {
			throw new Error("cmux unavailable")
		})
		const sendDesktopNotification = mock(() => {})

		await sendNotificationWithFallback({
			preferCmux: true,
			tryCmuxNotify,
			sendDesktopNotification,
		})

		expect(tryCmuxNotify).toHaveBeenCalledTimes(1)
		expect(sendDesktopNotification).toHaveBeenCalledTimes(1)
	})

	it("falls back to desktop notifications when cmux exits non-zero", async () => {
		const sendDesktopNotification = mock(() => {})

		await sendNotificationWithFallback({
			preferCmux: true,
			tryCmuxNotify: () =>
				sendCmuxNotification(
					{
						title: "Something went wrong",
						body: "Task failed",
					},
					{
						spawnProcess: () => ({
							exited: Promise.resolve(1),
						}),
					},
				),
			sendDesktopNotification,
		})

		expect(sendDesktopNotification).toHaveBeenCalledTimes(1)
	})

	it("falls back to desktop notifications when cmux times out", async () => {
		const sendDesktopNotification = mock(() => {})

		await sendNotificationWithFallback({
			preferCmux: true,
			tryCmuxNotify: () =>
				sendCmuxNotification(
					{
						title: "Ready",
						body: "Task complete",
					},
					{
						timeoutMs: 10,
						spawnProcess: () => ({
							exited: new Promise<number>(() => {
								// Simulate hung cmux process
							}),
						}),
					},
				),
			sendDesktopNotification,
		})

		expect(sendDesktopNotification).toHaveBeenCalledTimes(1)
	})
})

describe("macOS alerter desktop notifications", () => {
	it("routes darwin desktop notifications to alerter without calling node-notifier", async () => {
		const sendMacOSNotification = mock(async () => true)
		const nodeNotifierNotify = mock(() => {})

		await sendDesktopNotificationByPlatform({
			platform: "darwin",
			title: "Waiting for you",
			message: "Permission needed",
			subtitle: "Session A",
			sound: "Submarine",
			senderBundleId: "com.mitchellh.ghostty",
			sendMacOSNotification,
			sendNodeNotifierNotification: nodeNotifierNotify,
		})

		expect(sendMacOSNotification).toHaveBeenCalledWith({
			title: "Waiting for you",
			message: "Permission needed",
			subtitle: "Session A",
			sound: "Submarine",
			senderBundleId: "com.mitchellh.ghostty",
		})
		expect(nodeNotifierNotify).not.toHaveBeenCalled()
	})

	it("routes non-macOS desktop notifications to node-notifier without resolving or spawning alerter", async () => {
		const sendMacOSNotification = mock(async () => {
			throw new Error("alerter should not be used on non-macOS")
		})
		const nodeNotifierNotify = mock(() => {})

		await sendDesktopNotificationByPlatform({
			platform: "linux",
			title: "Ready",
			message: "Task complete",
			sound: "Glass",
			senderBundleId: "com.example.Terminal",
			sendMacOSNotification,
			sendNodeNotifierNotification: nodeNotifierNotify,
		})

		expect(nodeNotifierNotify).toHaveBeenCalledTimes(1)
		expect(sendMacOSNotification).not.toHaveBeenCalled()
	})

	it("maps notification options to alerter argv", () => {
		expect(
			buildAlerterArguments({
				title: "Waiting for you",
				message: "Permission needed",
				subtitle: "Session A",
				sound: "Submarine",
				senderBundleId: "com.mitchellh.ghostty",
			}),
		).toEqual([
			"alerter",
			"--message",
			"Permission needed",
			"--title",
			"Waiting for you",
			"--subtitle",
			"Session A",
			"--sound",
			"Submarine",
			"--sender",
			"com.mitchellh.ghostty",
		])
	})

	it("omits optional alerter flags when not configured", () => {
		expect(
			buildAlerterArguments({
				title: "Ready",
				message: "Task complete",
			}),
		).toEqual(["alerter", "--message", "Task complete", "--title", "Ready"])
	})

	it("spawns the resolved alerter binary without shell interpolation", async () => {
		const spawnProcess = mock((argv: string[]) => ({
			exited: Promise.resolve(0),
		}))
		const warn = mock(() => {})

		const sent = await sendMacOSAlerterNotification(
			{
				title: "Question for you",
				message: "Please answer",
				sound: "Submarine",
				senderBundleId: "com.googlecode.iterm2",
			},
			{
				which: async () => "/opt/homebrew/bin/alerter",
				spawnProcess,
				warn,
			},
		)

		expect(sent).toBe(true)
		expect(spawnProcess).toHaveBeenCalledWith([
			"/opt/homebrew/bin/alerter",
			"--message",
			"Please answer",
			"--title",
			"Question for you",
			"--sound",
			"Submarine",
			"--sender",
			"com.googlecode.iterm2",
		])
		expect(warn).not.toHaveBeenCalled()
	})

	it("warns and reports false when alerter is missing", async () => {
		const spawnProcess = mock((argv: string[]) => ({
			exited: Promise.resolve(0),
		}))
		const warn = mock(() => {})

		const sent = await sendMacOSAlerterNotification(
			{
				title: "Ready",
				message: "Task complete",
			},
			{
				which: async () => null,
				spawnProcess,
				warn,
			},
		)

		expect(sent).toBe(false)
		expect(spawnProcess).not.toHaveBeenCalled()
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("alerter not found on PATH"))
	})

	it("warns and reports false when alerter exits non-zero", async () => {
		const warn = mock(() => {})

		const sent = await sendMacOSAlerterNotification(
			{
				title: "Ready",
				message: "Task complete",
			},
			{
				which: async () => "/usr/local/bin/alerter",
				spawnProcess: () => ({ exited: Promise.resolve(2) }),
				warn,
			},
		)

		expect(sent).toBe(false)
		expect(warn).toHaveBeenCalledWith("notify: macOS desktop notification skipped; alerter exited with code 2.")
	})

	it("warns and reports false when spawning alerter throws", async () => {
		const warn = mock(() => {})

		const sent = await sendMacOSAlerterNotification(
			{
				title: "Ready",
				message: "Task complete",
			},
			{
				which: async () => "/usr/local/bin/alerter",
				spawnProcess: () => {
					throw new Error("spawn failed")
				},
				warn,
			},
		)

		expect(sent).toBe(false)
		expect(warn).toHaveBeenCalledWith("notify: macOS desktop notification skipped; alerter failed (spawn failed).")
	})
})

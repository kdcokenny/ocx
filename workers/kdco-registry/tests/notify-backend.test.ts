import { describe, expect, it, mock } from "bun:test"
import { sendNotificationWithFallback } from "../files/plugins/notify/backend"
import { sendCmuxNotification } from "../files/plugins/notify/cmux"

describe("notify backend fallback behavior", () => {
	it("uses node notifier directly when cmux is not preferred", async () => {
		const tryCmuxNotify = mock(async () => true)
		const sendNodeNotify = mock(() => {})

		await sendNotificationWithFallback({
			preferCmux: false,
			tryCmuxNotify,
			sendNodeNotify,
		})

		expect(tryCmuxNotify).not.toHaveBeenCalled()
		expect(sendNodeNotify).toHaveBeenCalledTimes(1)
	})

	it("prefers cmux when cmux delivery succeeds", async () => {
		const tryCmuxNotify = mock(async () => true)
		const sendNodeNotify = mock(() => {})

		await sendNotificationWithFallback({
			preferCmux: true,
			tryCmuxNotify,
			sendNodeNotify,
		})

		expect(tryCmuxNotify).toHaveBeenCalledTimes(1)
		expect(sendNodeNotify).not.toHaveBeenCalled()
	})

	it("falls back to node notifier when cmux returns false", async () => {
		const tryCmuxNotify = mock(async () => false)
		const sendNodeNotify = mock(() => {})

		await sendNotificationWithFallback({
			preferCmux: true,
			tryCmuxNotify,
			sendNodeNotify,
		})

		expect(tryCmuxNotify).toHaveBeenCalledTimes(1)
		expect(sendNodeNotify).toHaveBeenCalledTimes(1)
	})

	it("falls back to node notifier when cmux throws", async () => {
		const tryCmuxNotify = mock(async () => {
			throw new Error("cmux unavailable")
		})
		const sendNodeNotify = mock(() => {})

		await sendNotificationWithFallback({
			preferCmux: true,
			tryCmuxNotify,
			sendNodeNotify,
		})

		expect(tryCmuxNotify).toHaveBeenCalledTimes(1)
		expect(sendNodeNotify).toHaveBeenCalledTimes(1)
	})

	it("falls back to node notifier when cmux exits non-zero", async () => {
		const sendNodeNotify = mock(() => {})

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
			sendNodeNotify,
		})

		expect(sendNodeNotify).toHaveBeenCalledTimes(1)
	})

	it("falls back to node notifier when cmux times out", async () => {
		const sendNodeNotify = mock(() => {})

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
			sendNodeNotify,
		})

		expect(sendNodeNotify).toHaveBeenCalledTimes(1)
	})
})

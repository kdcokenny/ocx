import { describe, expect, it } from "bun:test"
import {
	buildCmuxNotifyArgs,
	canUseCmuxNotification,
	sendCmuxNotification,
} from "../files/plugins/notify/cmux"

describe("notify cmux integration", () => {
	it("returns false when CMUX_WORKSPACE_ID is missing", () => {
		const env = { PATH: "/usr/bin" }
		const canUse = canUseCmuxNotification(env, () => "/usr/local/bin/cmux")

		expect(canUse).toBe(false)
	})

	it("returns false when cmux executable is unavailable", () => {
		const env = { CMUX_WORKSPACE_ID: "workspace-123" }
		const canUse = canUseCmuxNotification(env, () => undefined)

		expect(canUse).toBe(false)
	})

	it("returns true when workspace ID and executable are available", () => {
		const env = { CMUX_WORKSPACE_ID: "workspace-123" }
		const canUse = canUseCmuxNotification(env, () => "/usr/local/bin/cmux")

		expect(canUse).toBe(true)
	})

	it("builds cmux notify args with subtitle", () => {
		const args = buildCmuxNotifyArgs({
			title: "Ready for review",
			subtitle: "Refactor parser",
			body: "OpenCode task is ready for review",
		})

		expect(args).toEqual([
			"notify",
			"--title",
			"Ready for review",
			"--subtitle",
			"Refactor parser",
			"--body",
			"OpenCode task is ready for review",
		])
	})

	it("builds cmux notify args without subtitle", () => {
		const args = buildCmuxNotifyArgs({
			title: "Something went wrong",
			body: "Timeout while calling API",
		})

		expect(args).toEqual([
			"notify",
			"--title",
			"Something went wrong",
			"--body",
			"Timeout while calling API",
		])
	})

	it("returns true when cmux exits successfully", async () => {
		const commands: string[][] = []

		const sent = await sendCmuxNotification(
			{
				title: "Ready",
				body: "Task complete",
			},
			{
				spawnProcess: (command) => {
					commands.push(command)
					return {
						exited: Promise.resolve(0),
					}
				},
			},
		)

		expect(sent).toBe(true)
		expect(commands).toEqual([["cmux", "notify", "--title", "Ready", "--body", "Task complete"]])
	})

	it("returns false when cmux exits non-zero", async () => {
		const sent = await sendCmuxNotification(
			{
				title: "Ready",
				body: "Task complete",
			},
			{
				spawnProcess: () => ({
					exited: Promise.resolve(2),
				}),
			},
		)

		expect(sent).toBe(false)
	})

	it("returns false when cmux hangs and times out", async () => {
		let killed = false

		const sent = await sendCmuxNotification(
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
					kill: () => {
						killed = true
					},
				}),
			},
		)

		expect(sent).toBe(false)
		expect(killed).toBe(true)
	})
})

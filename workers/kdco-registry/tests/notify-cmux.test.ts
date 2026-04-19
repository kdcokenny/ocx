import { describe, expect, it } from "bun:test"
import {
	buildCmuxClearStatusArgs,
	buildCmuxNotifyArgs,
	buildCmuxStatusArgs,
	canUseCmuxNotification,
	clearCmuxStatus,
	sendCmuxNotification,
	sendCmuxStatus,
} from "../files/plugins/notify/cmux"

describe("notify cmux integration", () => {
	it("returns false when no cmux context is available", () => {
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

	it("returns true when socket allowAll context is available", () => {
		const env = {
			CMUX_SOCKET_PATH: " /tmp/cmux.sock ",
			CMUX_SOCKET_MODE: " allowAll ",
		}
		const canUse = canUseCmuxNotification(env, () => "/usr/local/bin/cmux")

		expect(canUse).toBe(true)
	})

	it("returns false when socket mode does not allow external control", () => {
		const env = {
			CMUX_SOCKET_PATH: "/tmp/cmux.sock",
			CMUX_SOCKET_MODE: "restricted",
		}
		const canUse = canUseCmuxNotification(env, () => "/usr/local/bin/cmux")

		expect(canUse).toBe(false)
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

	it("builds cmux status args", () => {
		const args = buildCmuxStatusArgs({
			key: "opencode.session.abc",
			text: "Needs input",
		})

		expect(args).toEqual(["set-status", "opencode.session.abc", "Needs input"])
	})

	it("builds cmux clear status args", () => {
		const args = buildCmuxClearStatusArgs({
			key: "opencode.session.abc",
		})

		expect(args).toEqual(["clear-status", "opencode.session.abc"])
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

	it("sendCmuxStatus runs cmux status command", async () => {
		const commands: string[][] = []

		const sent = await sendCmuxStatus(
			{
				key: "opencode.session.abc",
				text: "Busy",
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
		expect(commands).toEqual([
			["cmux", "set-status", "opencode.session.abc", "Busy"],
		])
	})

	it("clearCmuxStatus runs cmux clear status command", async () => {
		const commands: string[][] = []

		const sent = await clearCmuxStatus(
			{
				key: "opencode.session.abc",
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
		expect(commands).toEqual([
			["cmux", "clear-status", "opencode.session.abc"],
		])
	})

	it("sendCmuxStatus returns false on timeout and kills process", async () => {
		let killed = false

		const sent = await sendCmuxStatus(
			{
				key: "opencode.session.abc",
				text: "Needs input",
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

import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { parse as parseJsonc } from "jsonc-parser"
import { detectCmuxContext } from "../files/plugins/kdco-primitives/cmux"
import {
	buildCmuxClearStatusArgs,
	buildCmuxNotifyArgs,
	buildCmuxStatusArgs,
	canUseCmuxNotification,
	clearCmuxStatus,
	resolveCmuxNotificationCommand,
	sendCmuxNotification,
	sendCmuxStatus,
} from "../files/plugins/notify/cmux"

const registryPath = path.join(import.meta.dir, "..", "registry.jsonc")
const registryFilesRoot = path.join(import.meta.dir, "..", "files")

describe("notify cmux integration", () => {
	it("detects cmux context from the shared primitive", () => {
		const context = detectCmuxContext({
			CMUX_WORKSPACE_ID: " workspace-123 ",
			CMUX_SURFACE_ID: " ",
			CMUX_SOCKET_PATH: " /tmp/cmux.sock ",
			CMUX_SOCKET_MODE: " allowall ",
		})

		expect(context).toEqual({
			workspaceID: "workspace-123",
			surfaceID: undefined,
			socketPath: "/tmp/cmux.sock",
			socketMode: "allowall",
		})
	})

	it("imports from a notify plus kdco-primitives install footprint without worktree terminal", async () => {
		const registry = parseJsonc(fs.readFileSync(registryPath, "utf8")) as {
			components: Array<{ name: string; files: string[] }>
		}
		const componentFiles = ["notify", "kdco-primitives"].flatMap((componentName) => {
			const component = registry.components.find((entry) => entry.name === componentName)
			if (!component) {
				throw new Error(`Missing registry component: ${componentName}`)
			}
			return component.files
		})

		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "notify-cmux-footprint-"))
		try {
			for (const file of componentFiles) {
				const sourcePath = path.join(registryFilesRoot, file)
				const targetPath = path.join(tempRoot, file)
				fs.mkdirSync(path.dirname(targetPath), { recursive: true })
				fs.copyFileSync(sourcePath, targetPath)
			}

			expect(fs.existsSync(path.join(tempRoot, "plugins/worktree/terminal.ts"))).toBe(false)

			const moduleUrl = pathToFileURL(path.join(tempRoot, "plugins/notify/cmux.ts")).href
			const module = await import(`${moduleUrl}?test=${Date.now()}`)

			expect(
				module.canUseCmuxNotification(
					{ CMUX_WORKSPACE_ID: "workspace-123" },
					() => "/usr/local/bin/cmux",
				),
			).toBe(true)
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true })
		}
	})

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

	it("returns false when cmux resolves to a bare command", () => {
		const env = { CMUX_WORKSPACE_ID: "workspace-123" }
		const canUse = canUseCmuxNotification(env, () => "cmux")

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

	it("resolves a trusted absolute cmux command", () => {
		const env = { CMUX_WORKSPACE_ID: "workspace-123" }
		const resolved = resolveCmuxNotificationCommand(env, () => "/usr/local/bin/cmux")

		expect(resolved).toBe("/usr/local/bin/cmux")
	})

	it("does not reject every absolute cmux command when the current project is filesystem root", () => {
		const env = { CMUX_WORKSPACE_ID: "workspace-123" }
		const resolved = resolveCmuxNotificationCommand(env, () => "/usr/local/bin/cmux", "cmux", {
			currentWorkingDirectory: "/",
			tempDirectory: "/var/tmp",
		})

		expect(resolved).toBe("/usr/local/bin/cmux")
	})

	it("rejects cmux commands resolved from the current project", () => {
		const env = { CMUX_WORKSPACE_ID: "workspace-123" }
		const currentWorkingDirectory = "/tmp/project"
		const resolved = resolveCmuxNotificationCommand(
			env,
			() => "/tmp/project/node_modules/.bin/cmux",
			"cmux",
			{ currentWorkingDirectory, tempDirectory: "/var/tmp" },
		)

		expect(resolved).toBeUndefined()
	})

	it("does not confuse sibling project paths with the current project", () => {
		const env = { CMUX_WORKSPACE_ID: "workspace-123" }
		const resolved = resolveCmuxNotificationCommand(
			env,
			() => "/opt/project-other/bin/cmux",
			"cmux",
			{ currentWorkingDirectory: "/opt/project", tempDirectory: "/var/tmp" },
		)

		expect(resolved).toBe("/opt/project-other/bin/cmux")
	})

	it("rejects cmux commands resolved from the temp directory", () => {
		const env = { CMUX_WORKSPACE_ID: "workspace-123" }
		const resolved = resolveCmuxNotificationCommand(env, () => "/tmp/untrusted-bin/cmux", "cmux", {
			currentWorkingDirectory: "/workspace/project",
			tempDirectory: "/tmp",
		})

		expect(resolved).toBeUndefined()
	})

	it("rejects cmux commands resolved from common temp directories by default", () => {
		const env = { CMUX_WORKSPACE_ID: "workspace-123" }
		const resolved = resolveCmuxNotificationCommand(env, () => "/tmp/untrusted-bin/cmux")

		expect(resolved).toBeUndefined()
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
				cmuxCommand: "/usr/local/bin/cmux",
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
			["/usr/local/bin/cmux", "notify", "--title", "Ready", "--body", "Task complete"],
		])
	})

	it("returns false without spawning when no cmux command is provided", async () => {
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

		expect(sent).toBe(false)
		expect(commands).toEqual([])
	})

	it("returns false when cmux exits non-zero", async () => {
		const sent = await sendCmuxNotification(
			{
				title: "Ready",
				body: "Task complete",
			},
			{
				cmuxCommand: "/usr/local/bin/cmux",
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
				cmuxCommand: "/usr/local/bin/cmux",
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
				cmuxCommand: "/usr/local/bin/cmux",
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
			["/usr/local/bin/cmux", "set-status", "opencode.session.abc", "Busy"],
		])
	})

	it("clearCmuxStatus runs cmux clear status command", async () => {
		const commands: string[][] = []

		const sent = await clearCmuxStatus(
			{
				key: "opencode.session.abc",
			},
			{
				cmuxCommand: "/usr/local/bin/cmux",
				spawnProcess: (command) => {
					commands.push(command)
					return {
						exited: Promise.resolve(0),
					}
				},
			},
		)

		expect(sent).toBe(true)
		expect(commands).toEqual([["/usr/local/bin/cmux", "clear-status", "opencode.session.abc"]])
	})

	it("sendCmuxStatus returns false on timeout and kills process", async () => {
		let killed = false

		const sent = await sendCmuxStatus(
			{
				key: "opencode.session.abc",
				text: "Needs input",
			},
			{
				cmuxCommand: "/usr/local/bin/cmux",
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

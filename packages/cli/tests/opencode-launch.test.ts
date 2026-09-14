import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { runOpencode } from "../src/commands/opencode"
import { createIsolatedEnv } from "./helpers"

// Exercise the launch lifecycle in-process so coverage includes launch/error handling,
// while OpenCode itself remains a real subprocess with an isolated configuration.
let root: string
let previousCwd: string
let previousEnv: NodeJS.ProcessEnv
const LAUNCH_READY_TIMEOUT_MS = 10_000
const exitRequested = new Error("test intercepted process.exit")
let exitCode: number | undefined
let exitSpy: ReturnType<typeof spyOn>

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "ocx-launch-test-"))
	previousCwd = process.cwd()
	previousEnv = { ...process.env }
	process.env = createIsolatedEnv(root, { XDG_CONFIG_HOME: root })
	process.chdir(root)
	exitCode = undefined
	exitSpy = spyOn(process, "exit").mockImplementation((code) => {
		exitCode = Number(code)
		throw exitRequested
	})
	const profile = join(root, "opencode", "profiles", "work")
	await mkdir(profile, { recursive: true })
	await writeFile(join(profile, "ocx.jsonc"), '{"registries":{}}')
	await writeFile(
		join(profile, "opencode.jsonc"),
		'{"instructions":["custom.md"],"agent":{"probe":{"prompt":"{file:prompt.txt}"}}}',
	)
	await writeFile(join(profile, "prompt.txt"), "profile prompt")
})

afterEach(async () => {
	exitSpy.mockRestore()
	process.chdir(previousCwd)
	process.env = previousEnv
	await rm(root, { recursive: true, force: true })
})

async function launch(args: string[] = []) {
	try {
		await runOpencode(args, { rename: false, profile: "work" })
	} catch (error) {
		if (error !== exitRequested) throw error
	}
}

async function wrapper(body: string) {
	const path = join(root, "opencode-wrapper")
	await writeFile(path, `#!${process.execPath}\n${body}\n`)
	await chmod(path, 0o755)
	process.env.OPENCODE_BIN = path
}

describe("profile launcher compatibility", () => {
	it.each([
		"",
		"missing-opencode-command-for-test",
	])("maps launcher resolution failures to configuration errors: %s", async (bin) => {
		process.env.OPENCODE_BIN = bin
		await expect(launch()).rejects.toMatchObject({
			exitCode: 78,
			message: expect.stringContaining("ocx oc spawn error"),
		})
	})
	it("launches a wrapper that rejects --version and preserves the child's exit code", async () => {
		await wrapper('if (process.argv[2] === "--version") process.exit(2); process.exit(17)')
		await launch(["debug", "config"])
		expect(exitCode).toBe(17)
	})
	it("reuses versioned launchers and resolves launch-specific settings every time", async () => {
		const capture = join(root, "capture.json")
		await wrapper(`
if (process.argv[2] === "--version") { console.log("1.2.3"); process.exit(0) }
await Bun.write(${JSON.stringify(capture)}, JSON.stringify({ dir: process.env.OPENCODE_CONFIG_DIR, config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}"), args: process.argv.slice(2) }))
`)
		await launch(["debug", "config"])
		expect(exitCode).toBe(0)
		const first = JSON.parse(await readFile(capture, "utf8"))
		expect(first.args).toEqual(["debug", "config"])
		expect(first.config.agent.probe.prompt).toBe(
			`{file:${join(root, "opencode/profiles/work/prompt.txt")}}`,
		)
		await launch(["debug", "config"])
		const second = JSON.parse(await readFile(capture, "utf8"))
		expect(second.dir).toBe(first.dir)
	})
	it("maps missing executable identity errors and releases signal handlers", async () => {
		process.env.OPENCODE_BIN = join(root, "missing")
		const before = process.listenerCount("SIGINT")
		await expect(launch()).rejects.toMatchObject({ exitCode: 78 })
		expect(process.listenerCount("SIGINT")).toBe(before)
	})
	it.each([
		0, 2500,
	])("forwards termination and releases the lease after a %dms version probe", async (versionDelayMs) => {
		const ready = join(root, "ready")
		await wrapper(`
if (process.argv[2] === "--version") { await Bun.sleep(${versionDelayMs}); console.log("1.2.3"); process.exit(0) }
process.on("SIGTERM", () => process.exit(0))
await Bun.write(${JSON.stringify(ready)}, process.env.OPENCODE_CONFIG_DIR!)
setInterval(() => {}, 1000)
`)
		const handlers = process.listeners("SIGTERM")
		const running = launch()
		try {
			const readyDeadline = performance.now() + LAUNCH_READY_TIMEOUT_MS
			while (!(await Bun.file(ready).exists()) && performance.now() < readyDeadline)
				await Bun.sleep(10)
			expect(await Bun.file(ready).exists()).toBe(true)
		} finally {
			for (const handler of process.listeners("SIGTERM")) {
				if (!handlers.includes(handler)) handler("SIGTERM")
			}
			await running
		}
		expect(exitCode).toBe(143)
		const config = await readFile(ready, "utf8")
		expect(await readdir(dirname(config))).not.toContain("lease")
		expect(process.listeners("SIGTERM")).toEqual(handlers)
	}, 20_000)
	it("maps a non-executable launcher's spawn failure and releases its cache lease", async () => {
		await wrapper('console.log("unused")')
		await chmod(process.env.OPENCODE_BIN as string, 0o600)
		await expect(launch()).rejects.toMatchObject({
			exitCode: 78,
			message: expect.stringContaining("Failed to launch OpenCode binary"),
		})
	})
})

import { afterEach, beforeEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

let root: string
let binary: string
let config: string
let env: Record<string, string | undefined>
const cli = resolve(import.meta.dir, "../src/index.ts")
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "ocx-launcher-"))
	binary = join(root, "native wrapper")
	config = join(root, "config/ocx/profiles/work")
	await mkdir(config, { recursive: true })
	await writeFile(join(config, "ocx.jsonc"), "{}")
	env = {
		...process.env,
		XDG_CONFIG_HOME: join(root, "config"),
		OCX_PROFILE: "work",
		OPENCODE_BIN: binary,
	}
})
afterEach(async () => {
	await rm(root, { recursive: true, force: true })
})
async function wrapper(body: string, version = "opencode v2.0.3") {
	await writeFile(
		binary,
		`#!${process.execPath}\nif (process.argv[2] === "--version") { console.log(${JSON.stringify(version)}); process.exit(0); }\n${body}`,
	)
	await chmod(binary, 0o700)
}
function spawn(args: string[], overrides: Record<string, string | undefined> = {}) {
	return Bun.spawn([process.execPath, "--no-env-file", cli, "oc", ...args], {
		cwd: root,
		env: { ...env, ...overrides },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	})
}
async function result(args: string[], overrides: Record<string, string | undefined> = {}) {
	const child = spawn(args, overrides)
	child.stdin.end()
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	])
	return { code, stdout, stderr }
}
const posix = process.platform === "win32" ? test.skip : test
posix(
	"preserves cwd, opaque arguments, stdin, stdout, stderr and nonzero native exit",
	async () => {
		await wrapper(
			`console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), config: process.env.OPENCODE_CONFIG_DIR, input: await Bun.stdin.text() })); console.error("native stderr"); process.exit(7)`,
		)
		const child = spawn(["run", "a prompt with spaces", "--model", "provider/model#variant"])
		child.stdin.write("input payload")
		child.stdin.end()
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		])
		expect(code).toBe(7)
		expect(JSON.parse(stdout)).toEqual({
			cwd: root,
			args: ["run", "--standalone", "a prompt with spaces", "--model", "provider/model#variant"],
			config,
			input: "input payload",
		})
		expect(stderr).toBe("native stderr\n")
	},
)
posix.each(["1.18.23", "opencode v2.0.2", "opencode v3.0.0", "unrecognized wrapper"])(
	"rejects unsupported native identity before launching: %s",
	async (version) => {
		await wrapper('console.log("should not launch")', version)
		const output = await result([])
		expect(output.code).not.toBe(0)
		expect(output.stdout).not.toContain("should not launch")
		expect(output.stderr).toMatch(/requires OpenCode V2|Cannot identify/)
	},
)
posix("native version reaches the native binary instead of Commander", async () => {
	await wrapper("")
	const output = await result(["--version"])
	expect(output.code).toBe(0)
	expect(output.stdout.trim()).toBe("opencode v2.0.3")
})
posix(
	"profile binary wins over environment, including executable paths containing spaces",
	async () => {
		await wrapper('console.log("selected")')
		await writeFile(join(config, "ocx.jsonc"), JSON.stringify({ bin: binary }))
		const output = await result([], { OPENCODE_BIN: "/definitely/missing" })
		expect(output.code).toBe(0)
		expect(output.stdout.trim()).toBe("selected")
	},
)
posix("reports missing executable and missing profile without native fallback", async () => {
	const missingBinary = await result([])
	expect(missingBinary.code).not.toBe(0)
	await wrapper('console.log("wrong profile")')
	const missingProfile = await result([], { OCX_PROFILE: "absent" })
	expect(missingProfile.code).not.toBe(0)
	expect(missingProfile.stdout).not.toContain("wrong profile")
})
posix.each(["SIGINT", "SIGTERM"] as const)(
	"forwards %s, waits for child cleanup, and preserves signal exit code",
	async (signal) => {
		await wrapper(
			`process.on(${JSON.stringify(signal)}, () => { console.log("child cleaned up"); process.exit(0) }); console.log("ready"); setInterval(() => {}, 1000)`,
		)
		const child = spawn([])
		const reader = child.stdout.getReader()
		const first = await reader.read()
		expect(new TextDecoder().decode(first.value)).toContain("ready")
		child.kill(signal)
		const chunks: Uint8Array[] = []
		for (;;) {
			const item = await reader.read()
			if (item.done) break
			chunks.push(item.value)
		}
		expect(await child.exited).toBe(signal === "SIGINT" ? 130 : 143)
		expect(Buffer.concat(chunks).toString()).toContain("child cleaned up")
	},
)
posix(
	"kills a child that ignores shutdown after the grace period",
	async () => {
		await wrapper(
			'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)',
		)
		const child = spawn([])
		const reader = child.stdout.getReader()
		await reader.read()
		child.kill("SIGTERM")
		expect(await child.exited).toBe(143)
		expect((await reader.read()).done).toBe(true)
	},
	6000,
)

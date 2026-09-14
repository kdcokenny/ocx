import { expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createIsolatedEnv } from "./helpers"

// Opt in with an installed executable; this test lets OpenCode install real dependencies.
it.skipIf(!process.env.OCX_TEST_OPENCODE_BIN)(
	"real OpenCode retains dependency materialization and initializes local plugins",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "ocx-real-cache-"))
		try {
			const profile = join(root, "opencode", "profiles", "work")
			await mkdir(join(profile, "plugins"), { recursive: true })
			await writeFile(join(profile, "ocx.jsonc"), '{"registries":{}}')
			await writeFile(join(profile, "opencode.jsonc"), "{}")
			await writeFile(join(profile, "package.json"), '{"private":true}')
			const events = join(root, "events.jsonl")
			await writeFile(
				join(profile, "plugins", "probe.ts"),
				`
import { appendFileSync } from "node:fs"
export const Probe = async () => {
 appendFileSync(${JSON.stringify(events)}, JSON.stringify({ config: process.env.OPENCODE_CONFIG_DIR }) + "\\n")
 return {}
}
`,
			)
			const env = createIsolatedEnv(root, {
				XDG_CONFIG_HOME: root,
				XDG_DATA_HOME: join(root, "data"),
				XDG_STATE_HOME: join(root, "state"),
				OPENCODE_BIN: process.env.OCX_TEST_OPENCODE_BIN,
			})
			async function launch() {
				const proc = Bun.spawn(
					[
						process.execPath,
						join(import.meta.dir, "../src/index.ts"),
						"oc",
						"--no-rename",
						"-p",
						"work",
						"debug",
						"config",
					],
					{ cwd: root, env, stdout: "pipe", stderr: "pipe", timeout: 120000 },
				)
				const [stdout, stderr, code] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
					proc.exited,
				])
				expect({ code, error: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, error: "" })
			}
			await launch()
			const first = JSON.parse((await readFile(events, "utf8")).trim().split("\n").at(0) ?? "null")
			const dependency = join(
				first.config,
				"node_modules",
				"@opencode-ai",
				"plugin",
				"package.json",
			)
			const installed = await stat(dependency)
			await launch()
			const sequential = (await readFile(events, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
			expect(sequential).toHaveLength(2)
			expect(sequential[1].config).toBe(first.config)
			const retained = await stat(dependency)
			expect(retained.ino).toBe(installed.ino)
			expect(retained.mtimeMs).toBe(installed.mtimeMs)
			// A source change makes both concurrent launches cold and forces distinct leases.
			await writeFile(join(profile, "generation.txt"), "cold concurrent generation")
			await Promise.all([launch(), launch()])
			const concurrent = (await readFile(events, "utf8"))
				.trim()
				.split("\n")
				.slice(2)
				.map((line) => JSON.parse(line))
			expect(concurrent).toHaveLength(2)
			expect(concurrent[0].config).not.toBe(concurrent[1].config)
			for (const event of concurrent) expect(event.config).not.toBe(first.config)
			expect(
				await Bun.file(
					join(profile, "node_modules", "@opencode-ai", "plugin", "package.json"),
				).exists(),
			).toBe(false)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	},
	300000,
)

it("CLI retries an interrupted installer and then retains the completed installation", async () => {
	const { runCLIIsolated } = await import("./helpers")
	const root = await mkdtemp(join(tmpdir(), "ocx-interrupted-cache-"))
	try {
		const profile = join(root, "opencode", "profiles", "work")
		await mkdir(profile, { recursive: true })
		await writeFile(join(profile, "ocx.jsonc"), '{"registries":{}}')
		await writeFile(join(profile, "opencode.jsonc"), "{}")
		const output = join(root, "events.jsonl")
		const installer = join(root, "installer.ts")
		await writeFile(
			installer,
			`
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const config = process.env.OPENCODE_CONFIG_DIR!
const modules = join(config, "node_modules")
mkdirSync(modules, { recursive: true })
const ready = join(modules, "ready")
if (!existsSync(ready)) {
 appendFileSync(${JSON.stringify(output)}, JSON.stringify({ config, event: "install" }) + "\\n")
 writeFileSync(join(modules, "partial"), "started")
 if (process.env.INTERRUPT_INSTALL === "1") process.kill(process.pid, "SIGKILL")
 writeFileSync(join(config, "package.json"), '{"dependencies":{"generated":"1"}}')
 writeFileSync(join(config, "package-lock.json"), "lock")
 writeFileSync(ready, "ready")
}
appendFileSync(${JSON.stringify(output)}, JSON.stringify({ config, event: "plugin initialized" }) + "\\n")
`,
		)
		const args = ["oc", "--no-rename", "-p", "work", installer]
		const interrupted = await runCLIIsolated(args, root, {
			OPENCODE_BIN: process.execPath,
			INTERRUPT_INSTALL: "1",
		})
		expect(interrupted.exitCode).not.toBe(0)
		for (let i = 0; i < 2; i++) {
			const result = await runCLIIsolated(args, root, { OPENCODE_BIN: process.execPath })
			expect(result.exitCode).toBe(0)
		}
		const events = (await readFile(output, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
		expect(events.map((event) => event.event)).toEqual([
			"install",
			"install",
			"plugin initialized",
			"plugin initialized",
		])
		expect(new Set(events.map((event) => event.config)).size).toBe(1)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}, 30000)

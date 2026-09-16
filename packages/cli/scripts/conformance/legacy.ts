import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { restoreLegacyRegistry } from "../../../../legacy/restore"

const legacyCli = process.env.OCX_V1_ENTRYPOINT
if (!legacyCli) throw new Error("Set OCX_V1_ENTRYPOINT to the published ocx@2.0.15 dist/index.js")
const root = await mkdtemp(join(tmpdir(), "ocx-legacy-install-"))
await restoreLegacyRegistry("kdco-registry", join(root, "kdco"))
await restoreLegacyRegistry("ocx-kit", join(root, "kit"))
const served: string[] = []
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(req) {
		const path = new URL(req.url).pathname
		const [_, catalog, ...parts] = path.split("/")
		if (!["kdco", "kit"].includes(catalog ?? "")) return new Response("missing", { status: 404 })
		const base = join(root, catalog as string)
		const file = Bun.file(join(base, ...parts))
		if (!(await file.exists())) return new Response("missing", { status: 404 })
		served.push(path)
		return new Response(file)
	},
})
const env = {
	...process.env,
	XDG_CONFIG_HOME: join(root, "config"),
	XDG_DATA_HOME: join(root, "data"),
	XDG_CACHE_HOME: join(root, "cache"),
	XDG_STATE_HOME: join(root, "state"),
	OCX_NO_UPDATE_CHECK: "1",
	OCX_PROFILE: undefined,
}
let commandNumber = 0
async function run(args: string[]) {
	const child = Bun.spawn([process.execPath, legacyCli, ...args], {
		cwd: root,
		env,
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	})
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	])
	await writeFile(join(root, `command-${++commandNumber}.log`), stdout + stderr)
	assert.equal(code, 0, `${args.join(" ")}: ${stdout} ${stderr}`)
}
try {
	await run(["init", "--global"])
	await run([
		"registry",
		"add",
		`http://127.0.0.1:${server.port}/kdco`,
		"--name",
		"kdco",
		"--global",
	])
	await run(["registry", "add", `http://127.0.0.1:${server.port}/kit`, "--name", "kit", "--global"])
	await run(["profile", "add", "legacy-ws", "--source", "kit/ws", "--global"])
	await run(["profile", "add", "legacy-omo", "--source", "kit/omo", "--global"])
	await run(["profile", "add", "frozen", "--global"])
	await run([
		"add",
		"kdco/workspace",
		"--from",
		`http://127.0.0.1:${server.port}/kdco`,
		"--profile",
		"frozen",
	])
	assert(
		served.some((path) =>
			path.includes("/kdco/components/workspace-plugin/plugins/workspace-plugin.ts"),
		),
	)
	const profile = join(root, "config/opencode/profiles/frozen")
	assert(await Bun.file(join(profile, "plugins/workspace-plugin.ts")).exists())
	assert(await Bun.file(join(profile, "agents/researcher.md")).exists())
	assert(
		await Bun.file(
			join(root, "config/opencode/profiles/legacy-omo/oh-my-openagent.jsonc"),
		).exists(),
	)
	console.log(
		"PASS: published OCX 2.0.15 installs frozen workspace, dependencies and OMO profile; HTTP requests:",
		served.length,
	)
	console.log("Fixture:", root)
} finally {
	server.stop(true)
}

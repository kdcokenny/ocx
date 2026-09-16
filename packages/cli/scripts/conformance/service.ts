import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = await mkdtemp(join(tmpdir(), "ocx-native-extra-"))
const native = process.env.OPENCODE_V2_BIN
if (!native) throw new Error("Set OPENCODE_V2_BIN to the native V2 executable")
const ocx = join(import.meta.dir, "../../dist/index.js")
const env = {
	PATH: process.env.PATH,
	HOME: process.env.HOME,
	XDG_CONFIG_HOME: join(root, "config"),
	XDG_DATA_HOME: join(root, "data"),
	XDG_STATE_HOME: join(root, "state"),
	XDG_CACHE_HOME: join(root, "cache"),
	OPENCODE_DISABLE_MODELS_FETCH: "1",
	OPENCODE_BIN: native,
	NO_COLOR: "1",
}
await mkdir(join(root, "config/opencode"), { recursive: true })
await writeFile(
	join(root, "config/opencode/opencode.jsonc"),
	JSON.stringify({ model: "opencode/ambient-marker" }),
)
async function run(args: string[], nativeCommand = false) {
	const child = Bun.spawn(nativeCommand ? [native, ...args] : [process.execPath, ocx, ...args], {
		cwd: root,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	})
	const timer = setTimeout(() => child.kill("SIGKILL"), 30000)
	try {
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		])
		await writeFile(
			join(root, `${nativeCommand ? "native" : "ocx"}-${args.join("-").replaceAll("/", "_")}.log`),
			stdout + stderr,
		)
		assert.equal(code, 0, `${args.join(" ")}: ${stdout} ${stderr}`)
		return stdout
	} finally {
		clearTimeout(timer)
	}
}
try {
	console.log("START SERVICE", await run(["service", "start"], true))
	console.log("SERVICE STATUS", await run(["service", "status"], true))
	await run(["profile", "add", "ocx-dev"])
	console.log("HEALTH", await run(["oc", "-p", "ocx-dev", "api", "GET", "/api/health"]))
	const config = await run(["oc", "-p", "ocx-dev", "api", "GET", "/api/config"])
	assert(!config.includes("ambient-marker"), "profile attached to ambient service")
	console.log("PROFILE CONFIG isolated")
	console.log("AUTH", await run(["oc", "-p", "ocx-dev", "auth", "list"]))
	console.log("SESSIONS", await run(["oc", "-p", "ocx-dev", "session", "list"]))
	console.log("PATHS", await run(["oc", "-p", "ocx-dev", "debug", "paths"]))
} finally {
	console.log("STOP SERVICE", await run(["service", "stop"], true))
	console.log("Fixture:", root)
}

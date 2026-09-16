import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenCode } from "@opencode/client/promise"

const root = await mkdtemp(join(tmpdir(), "ocx-instruction-probe-"))
const binary = process.env.OPENCODE_V2_BIN
if (!binary) throw new Error("Set OPENCODE_V2_BIN to a released OpenCode V2 executable")
const ocx = join(import.meta.dir, "../../dist/index.js")
const project = join(root, "project")
await mkdir(join(project, "nested"), { recursive: true })
Bun.spawnSync(["git", "init", "-q", project])
await writeFile(join(project, "AGENTS.md"), "PROJECT_INSTRUCTION_MARKER\n")
await writeFile(join(project, "nested/AGENTS.md"), "NESTED_INSTRUCTION_MARKER\n")
await writeFile(join(project, "nested/example.txt"), "A fixture file.\n")
interface ModelRequest {
	tools?: { function?: { name: string; parameters?: unknown } }[]
	messages: { role: string; content?: unknown }[]
}
const requests: ModelRequest[] = []
const mock = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const body = (await request.json()) as ModelRequest
		requests.push(body)
		const read = body.tools?.find((t) => t.function?.name === "read")
		const hasToolResponse = body.messages?.some((m) => m.role === "tool")
		const tool = read && !hasToolResponse
		const delta = tool
			? {
					tool_calls: [
						{
							index: 0,
							id: "read_fixture",
							type: "function",
							function: {
								name: "read",
								arguments: JSON.stringify({ path: join(project, "nested/example.txt") }),
							},
						},
					],
				}
			: { content: "CONFORMANCE_OK" }
		const chunks = [
			{
				id: "chatcmpl-ocx",
				object: "chat.completion.chunk",
				created: 1,
				model: "ocx-test",
				choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }],
			},
			{
				id: "chatcmpl-ocx",
				object: "chat.completion.chunk",
				created: 1,
				model: "ocx-test",
				choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
				usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
			},
		]
		return new Response(
			chunks.map((x) => `data: ${JSON.stringify(x)}\n\n`).join("") + "data: [DONE]\n\n",
			{ headers: { "Content-Type": "text/event-stream" } },
		)
	},
})
const baseEnv = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => !key.startsWith("OPENCODE_")),
)
const env = {
	...baseEnv,
	XDG_CONFIG_HOME: join(root, "config"),
	XDG_DATA_HOME: join(root, "data"),
	XDG_STATE_HOME: join(root, "state"),
	XDG_CACHE_HOME: join(root, "cache"),
	OPENCODE_DISABLE_MODELS_FETCH: "1",
	OPENCODE_PASSWORD: "ocx-local-conformance-only",
}
try {
	for (const inherit of [false, true]) {
		const name = inherit ? "inherit" : "ignore"
		const profile = join(root, "config/ocx/profiles", name)
		await mkdir(profile, { recursive: true })
		await writeFile(join(profile, "AGENTS.md"), "PROFILE_INSTRUCTION_MARKER\n")
		await writeFile(
			join(profile, "ocx.jsonc"),
			JSON.stringify({ projectConfig: inherit ? "inherit" : "ignore" }),
		)
		await writeFile(
			join(profile, "opencode.jsonc"),
			JSON.stringify({
				model: "ocx-test/ocx-test",
				agents: { title: { disabled: true }, build: { steps: 4 } },
				permissions: [{ action: "*", resource: "*", effect: "allow" }],
				providers: {
					"ocx-test": {
						package: "aisdk:@ai-sdk/openai-compatible",
						settings: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: "local-fixture" },
						models: {
							"ocx-test": {
								name: "OCX Test",
								limit: { context: 128000, output: 8000 },
								capabilities: { tools: true, input: ["text"], output: ["text"] },
							},
						},
					},
				},
			}),
		)
		const proc = Bun.spawn(
			[process.execPath, ocx, "oc", "--profile", name, "serve", "--stdio", "--port", "0"],
			{
				cwd: project,
				env: { ...env, OPENCODE_BIN: binary },
				stdin: "pipe",
				stdout: "pipe",
				stderr: Bun.file(join(root, `${inherit}.log`)),
			},
		)
		const timer = setTimeout(() => proc.kill(), 45000)
		try {
			const reader = proc.stdout.getReader()
			let line = ""
			while (!line.includes("\n")) {
				const item = await reader.read()
				if (item.done) throw new Error("server exited")
				line += new TextDecoder().decode(item.value)
			}
			const { url } = JSON.parse(line.slice(0, line.indexOf("\n")))
			const client = OpenCode.make({
				baseUrl: url,
				headers: { Authorization: `Basic ${btoa(`opencode:${env.OPENCODE_PASSWORD}`)}` },
			})
			await client.plugin.awaitActivation({ location: { directory: project } })
			const session = await client.session.create({
				location: { directory: project },
				model: { providerID: "ocx-test", id: "ocx-test" },
				title: "Conformance",
			})
			const before = requests.length
			await client.session.prompt({
				sessionID: session.id,
				text: "Read nested/example.txt, then say CONFORMANCE_OK.",
			})
			await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(35000) })
			const messages = await client.message.list({ sessionID: session.id })
			await writeFile(join(root, `${inherit}-messages.json`), JSON.stringify(messages, null, 2))
			const observed = requests.slice(before)
			await writeFile(join(root, `${inherit}-requests.json`), JSON.stringify(observed, null, 2))
			assert(observed.length > 0, "mock received no requests")
			const initial = JSON.stringify(observed[0].messages)
			const all = JSON.stringify(observed.map((x) => x.messages))
			assert(initial.includes("PROFILE_INSTRUCTION_MARKER"), "profile guidance missing")
			assert.equal(initial.includes("PROJECT_INSTRUCTION_MARKER"), inherit, "project guidance mode")
			assert(all.includes("NESTED_INSTRUCTION_MARKER"), "native nested instruction discovery")
			assert(JSON.stringify(messages).includes("CONFORMANCE_OK"), "model turn did not finish")
			console.log(
				`PASS ${inherit ? "inherit" : "ignore"}: initial and nested instructions (${observed.length} model requests)`,
			)
			const resumed = Bun.spawn(
				[
					process.execPath,
					ocx,
					"oc",
					"--profile",
					name,
					"run",
					"--session",
					session.id,
					"--format",
					"json",
					"Say CONFORMANCE_OK.",
				],
				{
					cwd: project,
					env: { ...env, OPENCODE_BIN: binary },
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				},
			)
			const runTimer = setTimeout(() => resumed.kill("SIGTERM"), 35000)
			try {
				const [code, stdout, stderr] = await Promise.all([
					resumed.exited,
					new Response(resumed.stdout).text(),
					new Response(resumed.stderr).text(),
				])
				await writeFile(join(root, `${name}-headless.log`), stdout + stderr)
				assert.equal(code, 0, `headless resume failed: ${stderr}`)
				assert(stdout.includes("CONFORMANCE_OK"), "headless run did not emit the model response")
				console.log(
					`PASS ${name}: headless run resumes a session while another native profile server is running`,
				)
			} finally {
				clearTimeout(runTimer)
			}
		} finally {
			proc.stdin.end()
			await proc.exited
			clearTimeout(timer)
		}
	}
} finally {
	mock.stop(true)
	console.log("Fixture:", root)
}

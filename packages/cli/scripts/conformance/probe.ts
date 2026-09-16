import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenCode } from "@opencode/client/promise"

const root = await mkdtemp(join(tmpdir(), "ocx-native-probe-"))
const binary = process.env.OPENCODE_V2_BIN
if (!binary) throw new Error("Set OPENCODE_V2_BIN to a released OpenCode V2 executable")
const ocx = join(import.meta.dir, "../../dist/index.js")
const project = join(root, "project")
await mkdir(join(project, ".git"), { recursive: true })
await mkdir(join(project, ".opencode/agents"), { recursive: true })
await mkdir(join(project, "nested"), { recursive: true })
await writeFile(
	join(project, ".opencode/opencode.jsonc"),
	JSON.stringify({
		model: "opencode/project-marker",
		commands: { projectcommand: { template: "project" } },
	}),
)
await writeFile(
	join(project, ".opencode/agents/projectagent.md"),
	"---\ndescription: Project marker\n---\nPROJECT_AGENT_MARKER\n",
)
await writeFile(join(project, "AGENTS.md"), "PROJECT_INSTRUCTION_MARKER\n")
await writeFile(join(project, "nested/AGENTS.md"), "NESTED_INSTRUCTION_MARKER\n")
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
	OPENCODE_SIMULATE: "1",
	OPENCODE_PASSWORD: "ocx-local-conformance-only",
}

async function start(name: string, inherit: boolean) {
	const profile = join(root, "config/ocx/profiles", name)
	await mkdir(join(profile, "agents"), { recursive: true })
	await mkdir(join(profile, "skills", `${name}skill`), { recursive: true })
	await writeFile(
		join(profile, "ocx.jsonc"),
		JSON.stringify({ projectConfig: inherit ? "inherit" : "ignore" }),
	)
	await writeFile(
		join(profile, "opencode.jsonc"),
		JSON.stringify({
			model: `opencode/${name}-marker`,
			commands: { [`${name}command`]: { template: name } },
			permissions: [{ action: "edit", resource: `${name}-only/*`, effect: "deny" }],
		}),
	)
	await writeFile(join(profile, "AGENTS.md"), `${name.toUpperCase()}_INSTRUCTION_MARKER\n`)
	await writeFile(
		join(profile, "agents", `${name}agent.md`),
		`---\ndescription: ${name} marker\n---\n${name}_AGENT_MARKER\n`,
	)
	await writeFile(
		join(profile, "skills", `${name}skill`, "SKILL.md"),
		`---\nname: ${name}skill\ndescription: ${name} marker\n---\n${name}_SKILL_MARKER\n`,
	)
	const proc = Bun.spawn(
		[process.execPath, ocx, "oc", "--profile", name, "serve", "--stdio", "--port", "0"],
		{
			cwd: project,
			env: { ...env, OPENCODE_BIN: binary },
			stdin: "pipe",
			stdout: "pipe",
			stderr: Bun.file(join(root, `${name}.log`)),
		},
	)
	const reader = proc.stdout.getReader()
	let output = ""
	const deadline = setTimeout(() => proc.kill("SIGKILL"), 30000)
	try {
		while (!output.includes("\n")) {
			const chunk = await reader.read()
			if (chunk.done) throw new Error(`Server ${name} exited before readiness: ${output}`)
			output += new TextDecoder().decode(chunk.value)
		}
		const { url } = JSON.parse(output.slice(0, output.indexOf("\n")))
		const client = OpenCode.make({
			baseUrl: url,
			headers: { Authorization: `Basic ${btoa(`opencode:${env.OPENCODE_PASSWORD}`)}` },
		})
		return { name, profile, process: proc, client, reader }
	} catch (error) {
		proc.kill("SIGKILL")
		await proc.exited
		throw error
	} finally {
		clearTimeout(deadline)
	}
}

const servers: Awaited<ReturnType<typeof start>>[] = []
try {
	for (const [name, inherit] of [
		["alpha", false],
		["beta", false],
		["gamma", true],
	] as const) {
		const server = await start(name, inherit)
		servers.push(server)
		const location = { directory: project }
		const request = { signal: AbortSignal.timeout(30_000) }
		const health = await server.client.health.get(request)
		await server.client.plugin.awaitActivation({ location }, request)
		const configs = await server.client.config.get({ location }, request)
		const agents = await server.client.agent.list({ location }, request)
		const commands = await server.client.command.list({ location }, request)
		const skills = await server.client.skill.list({ location }, request)
		await writeFile(
			join(root, `${name}-observed.json`),
			JSON.stringify({ health, configs, agents, commands, skills }, null, 2),
		)
		const text = JSON.stringify({ agents, commands, configs, skills })
		assert(text.includes(`${name}agent`), "profile agent missing")
		assert(JSON.stringify(commands).includes(`${name}command`), "profile command missing")
		assert(JSON.stringify(skills).includes(`${name}skill`), "profile skill missing")
		assert(JSON.stringify(configs).includes(`${name}-marker`), "profile model missing")
		assert(
			agents.data.some((agent) =>
				agent.permissions.some(
					(rule) =>
						rule.action === "edit" && rule.resource === `${name}-only/*` && rule.effect === "deny",
				),
			),
			"profile permission missing",
		)
		assert.equal(text.includes("projectagent"), inherit, "project discovery mismatch")
		assert.equal(text.includes("projectcommand"), inherit, "project command discovery mismatch")
		assert.equal(text.includes("project-marker"), inherit, "project config discovery mismatch")
		for (const other of ["alpha", "beta", "gamma"].filter((other) => other !== name))
			assert(
				!text.includes(`${other}agent`) &&
					!text.includes(`${other}skill`) &&
					!text.includes(`${other}command`) &&
					!text.includes(`${other}-marker`) &&
					!text.includes(`${other}-only/*`),
				"other profile leaked",
			)
	}
	console.log(
		"PASS: built OCX launches three simultaneous native servers with distinct profiles and both discovery modes",
	)
} finally {
	for (const server of servers) {
		server.process.stdin.end()
		await server.reader.cancel()
		const timer = setTimeout(() => server.process.kill("SIGKILL"), 5000)
		await server.process.exited
		clearTimeout(timer)
	}
	console.log("Fixture:", root)
}

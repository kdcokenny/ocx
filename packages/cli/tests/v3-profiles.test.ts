import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { buildOpenCodeArgs, buildOpenCodeEnv } from "../src/commands/opencode"
import { getProfileDir } from "../src/profile/paths"

let fixture: string
let project: string
let env: Record<string, string | undefined>
const cli = resolve(import.meta.dir, "../src/index.ts")

beforeEach(async () => {
	fixture = await mkdtemp(join(tmpdir(), "ocx-v3-profiles-"))
	project = join(fixture, "project")
	await mkdir(project)
	env = {
		...process.env,
		XDG_CONFIG_HOME: join(fixture, "config"),
		XDG_DATA_HOME: join(fixture, "data"),
		XDG_STATE_HOME: join(fixture, "state"),
		XDG_CACHE_HOME: join(fixture, "cache"),
		OCX_NO_UPDATE_CHECK: "1",
		OCX_PROFILE: undefined,
	}
})
afterEach(async () => {
	await rm(fixture, { recursive: true, force: true })
})

async function run(args: string[], overrides: Record<string, string | undefined> = {}) {
	const child = Bun.spawn([process.execPath, "--no-env-file", cli, ...args], {
		cwd: project,
		env: { ...env, ...overrides },
		stdout: "pipe",
		stderr: "pipe",
	})
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	])
	return { stdout, stderr, code }
}
const profile = (name: string) => join(fixture, "config/ocx/profiles", name)

test("profiles are usable without global initialization and clones copy supporting files", async () => {
	expect((await run(["profile", "add", "work"])).code).toBe(0)
	await mkdir(join(profile("work"), "skills/example"), { recursive: true })
	await writeFile(join(profile("work"), "skills/example/data.bin"), Buffer.from([0, 255, 1]))
	await writeFile(join(profile("work"), "cli.json"), '{"theme":"custom"}\n')
	const source = await readFile(join(profile("work"), "ocx.jsonc"))
	expect((await run(["profile", "add", "copy", "--clone", "work"])).code).toBe(0)
	expect(await readFile(join(profile("copy"), "ocx.jsonc"))).toEqual(source)
	expect(await readFile(join(profile("copy"), "skills/example/data.bin"))).toEqual(
		Buffer.from([0, 255, 1]),
	)
	expect(await Bun.file(join(profile("copy"), "cli.json")).text()).toBe('{"theme":"custom"}\n')
	expect((await run(["profile", "move", "copy", "renamed"])).code).toBe(0)
	expect((await run(["profile", "remove", "renamed"])).code).toBe(0)
	expect(JSON.parse((await run(["profile", "list", "--json"])).stdout).profiles).toEqual(["work"])
})

test("selection is explicit and repository profile settings cannot override it", async () => {
	await run(["profile", "add", "work"])
	await run(["profile", "add", "personal"])
	await mkdir(join(project, ".opencode"))
	await writeFile(join(project, ".opencode/ocx.jsonc"), '{"profile":"missing"}')
	expect((await run(["profile", "show", "--json"])).code).not.toBe(0)
	expect((await run(["profile", "use", "work"])).code).toBe(0)
	expect(JSON.parse((await run(["profile", "show", "--json"])).stdout).name).toBe("work")
	expect(
		JSON.parse((await run(["profile", "show", "--json"], { OCX_PROFILE: "personal" })).stdout).name,
	).toBe("personal")
	expect(
		JSON.parse(
			(await run(["profile", "show", "work", "--json"], { OCX_PROFILE: "personal" })).stdout,
		).name,
	).toBe("work")
	expect((await run(["profile", "show", "missing", "--json"])).code).not.toBe(0)
	expect((await run(["profile", "show", "--json"], { OCX_PROFILE: "" })).code).not.toBe(0)
})

test("rename updates the default and removal protects it until explicitly cleared", async () => {
	await run(["init", "--global"])
	expect((await run(["profile", "move", "default", "work"])).code).toBe(0)
	expect(JSON.parse((await run(["profile", "show", "--json"])).stdout).name).toBe("work")
	expect((await run(["profile", "remove", "work"])).code).not.toBe(0)
	expect((await run(["profile", "use", "--clear"])).code).toBe(0)
	expect((await run(["profile", "remove", "work"])).code).toBe(0)
})

test("replaying an interrupted move repairs the default without losing other metadata", async () => {
	await run(["init", "--global"])
	await writeFile(
		join(fixture, "config/ocx/.ocx/profile-move.json"),
		JSON.stringify({ oldName: "default", newName: "work" }),
	)
	await rename(profile("default"), profile("work"))
	expect((await run(["profile", "remove", "work"])).code).not.toBe(0)
	expect((await run(["profile", "move", "default", "work"])).code).toBe(0)
	expect(JSON.parse((await run(["profile", "show", "--json"])).stdout).name).toBe("work")
	expect(await Bun.file(join(fixture, "config/ocx/.ocx/profile-move.json")).exists()).toBe(false)
})

test("profile removal preserves interrupted installation recovery files", async () => {
	await run(["profile", "add", "work"])
	await mkdir(join(profile("work"), ".ocx/transaction-interrupted"), { recursive: true })
	await writeFile(
		join(profile("work"), ".ocx/transaction-interrupted/manifest.json"),
		'{"complete":false}',
	)
	const result = await run(["profile", "remove", "work"])
	expect(result.code).not.toBe(0)
	expect(result.stderr).toContain("Interrupted operation")
	expect(await Bun.file(join(profile("work"), "ocx.jsonc")).exists()).toBe(true)
})

test("V1 files remain untouched and mutation destinations never come from launch defaults", async () => {
	const legacy = join(fixture, "config/opencode/profiles/work")
	await mkdir(legacy, { recursive: true })
	await writeFile(join(legacy, "ocx.jsonc"), '{"include":["**"]}\n')
	await run(["init", "--global"])
	expect(await Bun.file(join(legacy, "ocx.jsonc")).text()).toBe('{"include":["**"]}\n')
	const result = await run(["add", "team/guide", "--json"], { OCX_PROFILE: "default" })
	expect(result.code).not.toBe(0)
	expect(result.stdout).toContain("Choose exactly one destination")
	expect((await run(["add", "team/guide", "--profile", "default", "--project"])).code).not.toBe(0)
	expect((await run(["profile", "add", "../escape"])).code).not.toBe(0)
})

test("launcher removes inherited config overlays and sets native project mode", () => {
	const original = {
		OPENCODE_CONFIG: "/wrong",
		OPENCODE_CONFIG_CONTENT: "{}",
		OPENCODE_CONFIG_DIR: "/wrong",
		OPENCODE_DISABLE_PROJECT_CONFIG: "true",
		OPENCODE_CONFIG_PROJECT_DISABLE: "true",
		OCX_CONTEXT: "1",
		OCX_TITLE_CONTEXT: "old",
		KEEP: "value",
	}
	const actual = buildOpenCodeEnv({
		baseEnv: original,
		profileName: "work",
		projectConfig: "inherit",
	})
	expect(actual.OPENCODE_CONFIG_DIR).toBe(getProfileDir("work"))
	expect(actual.OPENCODE_CONFIG).toBeUndefined()
	expect(actual.OPENCODE_CONFIG_CONTENT).toBeUndefined()
	expect(actual.OPENCODE_DISABLE_PROJECT_CONFIG).toBeUndefined()
	expect(actual.OPENCODE_CONFIG_PROJECT_DISABLE).toBe("false")
	expect(actual.OCX_CONTEXT).toBeUndefined()
	expect(actual.KEEP).toBe("value")
	expect(original.OPENCODE_CONFIG).toBe("/wrong")
})

test("native argument dispatch uses only supported private-server commands", () => {
	expect(buildOpenCodeArgs([])).toEqual(["--standalone"])
	expect(buildOpenCodeArgs(["run", "hello"])).toEqual(["run", "--standalone", "hello"])
	expect(buildOpenCodeArgs(["auth", "list"])).toEqual(["auth", "list", "--standalone"])
	expect(buildOpenCodeArgs(["session", "list"])).toEqual(["session", "list", "--standalone"])
	expect(buildOpenCodeArgs(["plugin", "add", "example"])).toEqual(["plugin", "add", "example"])
	expect(buildOpenCodeArgs(["acp"])).toEqual(["acp"])
	expect(buildOpenCodeArgs(["run", "--help"])).toEqual(["run", "--help"])
	expect(() => buildOpenCodeArgs(["debug", "config"])).toThrow("private profile server")
	expect(() => buildOpenCodeArgs(["plugin", "list"])).toThrow("private profile server")
	expect(() => buildOpenCodeArgs(["serve", "--service"])).toThrow("cannot use --service")
})

test("profile name locks also exclude installations, renames and clones", async () => {
	expect((await run(["profile", "add", "work"])).code).toBe(0)
	await mkdir(join(fixture, "config/ocx/profiles/.locks/work"))
	for (const args of [
		["profile", "add", "copy", "--clone", "work"],
		["profile", "move", "work", "renamed"],
		["profile", "remove", "work"],
		["add", "team/review", "--profile", "work"],
	]) {
		const result = await run(args)
		expect(result.code).not.toBe(0)
		expect(result.stderr).toContain("busy")
	}
	expect(await Bun.file(join(profile("work"), "ocx.jsonc")).exists()).toBe(true)
	expect(await Bun.file(join(profile("copy"), "ocx.jsonc")).exists()).toBe(false)
})
test("profile publication rejects invalid metadata without leaving a selectable directory", async () => {
	expect((await run(["profile", "add", "work"])).code).toBe(0)
	await writeFile(join(profile("work"), "ocx.jsonc"), '{"include":["*"]}')
	expect((await run(["profile", "add", "copy", "--clone", "work"])).code).not.toBe(0)
	expect(await Bun.file(join(profile("copy"), "ocx.jsonc")).exists()).toBe(false)
})

test("default selection and global sources share one metadata lock", async () => {
	await run(["init", "--global"])
	await mkdir(join(fixture, "config/ocx/.ocx/operation.lock"))
	for (const args of [
		["profile", "use", "--clear"],
		["profile", "move", "default", "renamed"],
		["registry", "add", "https://example.com", "--name", "team", "--global"],
	]) {
		const result = await run(args)
		expect(result.code).not.toBe(0)
		expect(result.stderr).toContain("Another OCX operation")
	}
	expect(JSON.parse((await run(["profile", "show", "--json"])).stdout).name).toBe("default")
})
test.each([
	["run", "--standalone", "false"],
	["--no-standalone"],
	["run", "--standalone=false"],
])("rejects disabling the private server: %s", (...args) => {
	expect(() => buildOpenCodeArgs(args)).toThrow("private server")
})

test("profile roots and individual profiles cannot escape through symlinks", async () => {
	const external = join(fixture, "external")
	await mkdir(external)
	await mkdir(join(fixture, "config/ocx"), { recursive: true })
	await symlink(external, join(fixture, "config/ocx/profiles"), "dir")
	const add = await run(["profile", "add", "work"])
	expect(add.code).not.toBe(0)
	expect(add.stderr).toContain("real directory")
	expect(await Bun.file(join(external, "work/ocx.jsonc")).exists()).toBe(false)
	await rm(join(fixture, "config/ocx/profiles"))
	await run(["profile", "add", "real"])
	await symlink(profile("real"), profile("linked"), "dir")
	expect(JSON.parse((await run(["profile", "list", "--json"])).stdout).profiles).toEqual(["real"])
	for (const args of [
		["profile", "show", "linked"],
		["oc", "-p", "linked", "--version"],
		["profile", "remove", "linked"],
	]) {
		const result = await run(args)
		expect(result.code).not.toBe(0)
		expect(result.stderr).toContain("real directory")
	}
	expect(await Bun.file(join(profile("real"), "ocx.jsonc")).exists()).toBe(true)
})

test("config edit repairs malformed metadata and reports JSON success", async () => {
	await run(["profile", "add", "work"])
	await writeFile(join(profile("work"), "ocx.jsonc"), "{ broken")
	const editor = join(fixture, "repair.ts")
	await writeFile(
		editor,
		"console.log('editor output'); await Bun.write(process.argv.at(-1), '{}\\n')",
	)
	const result = await run(["config", "edit", "-p", "work", "--json"], {
		VISUAL: `"${process.execPath}" "${editor}"`,
	})
	expect(result.code, result.stderr).toBe(0)
	expect(JSON.parse(result.stdout)).toEqual({
		success: true,
		path: join(profile("work"), "ocx.jsonc"),
	})
	expect((await run(["config", "show", "-p", "work"])).stdout).toContain(profile("work"))
})

test("explicit external servers cannot override a profile's private server", () => {
	for (const args of [
		["--server", "http://localhost"],
		["run", "--server=http://localhost"],
	])
		expect(() => buildOpenCodeArgs(args)).toThrow("do not supply --server")
})

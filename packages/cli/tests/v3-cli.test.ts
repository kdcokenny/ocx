import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { REGISTRY_SCHEMA_LATEST_URL } from "../src/constants"
import { buildRegistry } from "../src/lib/build-registry"
import { runCLI } from "./helpers"

let root: string
let project: string
let registry: string
let profile: string
let env: Record<string, string>
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "ocx-v3-cli-"))
	project = join(root, "project with spaces")
	registry = join(root, "published")
	profile = join(root, "config/ocx/profiles/work")
	env = { XDG_CONFIG_HOME: join(root, "config") }
	await mkdir(project)
	await mkdir(join(root, "source/files/skills/review"), { recursive: true })
	await writeFile(join(root, "source/files/skills/review/SKILL.md"), "original")
	await writeFile(join(root, "source/files/ocx.jsonc"), '{"projectConfig":"ignore"}')
	await writeFile(
		join(root, "source/files/opencode.jsonc"),
		'// untouched native fields\n{"future_setting":42}',
	)
	await writeFile(
		join(root, "source/registry.jsonc"),
		JSON.stringify({
			$schema: REGISTRY_SCHEMA_LATEST_URL,
			name: "Fixtures",
			version: "1.0.0",
			author: "Test",
			components: [
				{
					name: "review",
					type: "skill",
					description: "Review code",
					files: ["skills/review/SKILL.md"],
				},
				{
					name: "starter",
					type: "profile",
					description: "Starter",
					files: ["ocx.jsonc", "opencode.jsonc"],
					dependencies: ["review"],
				},
			],
		}),
	)
	await publish()
})
afterEach(async () => {
	await rm(root, { recursive: true, force: true })
})
const cli = (args: string[]) => runCLI(args, project, { env, isolated: true })
const publish = () => buildRegistry({ source: join(root, "source"), out: registry })
async function ok(args: string[]) {
	const result = await cli(args)
	expect(result.exitCode, result.output).toBe(0)
	return result
}
async function setupProject() {
	await ok(["init", "--project"])
	await ok(["registry", "add", pathToFileURL(registry).href, "--name", "team", "--project"])
}

test("project lifecycle: source, search, add, inspect, edit, update, verify, remove", async () => {
	await setupProject()
	const search = JSON.parse((await ok(["search", "review", "--project", "--json"])).stdout)
	expect(search.data.components[0].name).toBe("team/review")
	const preview = JSON.parse(
		(await ok(["add", "team/review", "--project", "--dry-run", "--json"])).stdout,
	)
	expect(preview.dryRun).toBe(true)
	const owned = join(project, ".opencode/skills/review/SKILL.md")
	expect(await Bun.file(owned).exists()).toBe(false)
	await ok(["add", "team/review", "--project"])
	await ok(["verify", "--project", "--json"])
	expect(
		JSON.parse((await ok(["search", "--installed", "--project", "--json"])).stdout).data.components,
	).toHaveLength(1)
	await writeFile(owned, "local edit")
	expect((await cli(["verify", "--project", "--json"])).exitCode).not.toBe(0)
	await writeFile(join(root, "source/files/skills/review/SKILL.md"), "upstream change")
	await publish()
	expect((await cli(["update", "--all", "--project"])).exitCode).not.toBe(0)
	expect(await readFile(owned, "utf8")).toBe("local edit")
	await ok(["update", "--all", "--project", "--force", "--dry-run"])
	expect(await readFile(owned, "utf8")).toBe("local edit")
	await ok(["update", "--registry", "team", "--project", "--force"])
	expect(await readFile(owned, "utf8")).toBe("upstream change")
	await ok(["verify", "team/review", "--project"])
	await ok(["remove", "team/review", "--project", "--dry-run"])
	expect(await Bun.file(owned).exists()).toBe(true)
	await ok(["remove", "team/review", "--project", "--json"])
	expect(await Bun.file(owned).exists()).toBe(false)
	await ok(["registry", "remove", "team", "--project"])
	expect(await Bun.file(join(project, "opencode.jsonc")).exists()).toBe(false)
})

test("profile recipes preserve opaque config, dependencies and receipt origins without global registration", async () => {
	await ok([
		"profile",
		"add",
		"work",
		"--source",
		"team/starter",
		"--from",
		pathToFileURL(registry).href,
	])
	expect(await readFile(join(profile, "opencode.jsonc"), "utf8")).toBe(
		'// untouched native fields\n{"future_setting":42}',
	)
	await ok(["verify", "--profile", "work"])
	expect((await cli(["remove", "team/review", "--profile", "work"])).output).toContain(
		"still depends",
	)
	await ok(["update", "--all", "--profile", "work"])
	await ok(["profile", "add", "copy", "--clone", "work"])
	await ok(["verify", "--profile", "copy"])
	await ok(["remove", "team/starter", "team/review", "--profile", "copy"])
	expect(await Bun.file(join(profile, "skills/review/SKILL.md")).exists()).toBe(true)
	expect(await Bun.file(join(root, "config/opencode/ocx.jsonc")).exists()).toBe(false)
})

test("destinations are explicit, independent, and configuration browsing never merges native files", async () => {
	await setupProject()
	await ok(["profile", "add", "work"])
	await ok(["profile", "use", "work"])
	for (const args of [
		["add", "team/review"],
		["update", "--all"],
		["remove", "team/review"],
		["verify"],
		["config", "show"],
	])
		expect((await cli(args)).exitCode).not.toBe(0)
	expect((await cli(["add", "team/review", "--profile", "work", "--project"])).exitCode).not.toBe(0)
	await ok([
		"registry",
		"add",
		pathToFileURL(registry).href,
		"--name",
		"private",
		"--profile",
		"work",
	])
	const projectSources = (await ok(["registry", "list", "--project", "--json"])).stdout
	expect(projectSources).toContain("team")
	expect(projectSources).not.toContain("private")
	await ok(["add", "private/review", "--profile", "work"])
	expect(await Bun.file(join(project, ".opencode/skills/review/SKILL.md")).exists()).toBe(false)
	const config = (await ok(["config", "show", "--profile", "work", "--json"])).stdout
	expect(config).toContain("private")
	expect(config).not.toContain("future_setting")
})

test("registry failures and invalid input produce one JSON error without partial installs", async () => {
	await setupProject()
	for (const args of [
		["add", "team/missing", "--project"],
		["add", "../escape", "--project"],
		["update", "--all", "team/review", "--project"],
		["registry", "add", pathToFileURL(registry).href, "--name", "../escape", "--project"],
	]) {
		const result = await cli([...args, "--json"])
		expect(result.exitCode).not.toBe(0)
		expect(JSON.parse(result.stdout).success).toBe(false)
	}
	expect(await Bun.file(join(project, ".opencode/.ocx/receipt.jsonc")).exists()).toBe(false)
})

test("global initialization is quiet, repeatable and keeps existing native and legacy config", async () => {
	const legacy = join(root, "config/opencode")
	await mkdir(legacy, { recursive: true })
	await writeFile(join(legacy, "ocx.jsonc"), "legacy bytes")
	await writeFile(join(legacy, "opencode.jsonc"), "native bytes")
	const first = await ok(["init", "--global", "--quiet"])
	expect(first.stdout).toBe("")
	const native = join(root, "config/ocx/profiles/default/opencode.jsonc")
	await writeFile(native, "// custom\n{}")
	const second = JSON.parse((await ok(["init", "--global", "--quiet", "--json"])).stdout)
	expect(second.success).toBe(true)
	expect(await readFile(native, "utf8")).toBe("// custom\n{}")
	expect(await readFile(join(legacy, "ocx.jsonc"), "utf8")).toBe("legacy bytes")
	expect(await readFile(join(legacy, "opencode.jsonc"), "utf8")).toBe("native bytes")
})

test("global source registration needs no initialization and never changes existing auth headers", async () => {
	env.TEAM_TOKEN = "test-fixture-only"
	await ok(["registry", "add", pathToFileURL(registry).href, "--name", "team", "--global"])
	const path = join(root, "config/ocx/ocx.jsonc")
	const config = await Bun.file(path).json()
	const tokenTemplate = "Bearer " + "${" + "TEAM_TOKEN}"
	config.registries.team.headers = { authorization: tokenTemplate }
	await writeFile(path, JSON.stringify(config))
	await ok(["registry", "add", pathToFileURL(registry).href, "--name", "team", "--global"])
	expect((await Bun.file(path).json()).registries.team.headers.authorization).toBe(tokenTemplate)
	const listed = JSON.parse((await ok(["registry", "list", "--global", "--json"])).stdout)
	expect(listed.registries).toHaveLength(1)
	await ok(["registry", "remove", "team", "--global"])
	expect((await Bun.file(path).json()).registries).toEqual({})
})

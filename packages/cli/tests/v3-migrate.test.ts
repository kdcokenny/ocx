import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

let fixture: string
let source: string
let destination: string
let env: Record<string, string | undefined>
const cli = resolve(import.meta.dir, "../src/index.ts")
beforeEach(async () => {
	fixture = await mkdtemp(join(tmpdir(), "ocx-v3-import-"))
	source = join(fixture, "legacy")
	destination = join(fixture, "config/ocx/profiles/imported")
	await mkdir(source)
	await writeFile(
		join(source, "ocx.jsonc"),
		'{"exclude":["**/.opencode/**"],"registries":{"old":{"url":"https://example.invalid"}}}',
	)
	env = { ...process.env, XDG_CONFIG_HOME: join(fixture, "config"), OCX_NO_UPDATE_CHECK: "1" }
})
afterEach(async () => {
	await rm(fixture, { recursive: true, force: true })
})
async function migrate(flags: string[] = []) {
	const child = Bun.spawn(
		[
			process.execPath,
			"--no-env-file",
			cli,
			"migrate",
			"--from",
			source,
			"--profile",
			"imported",
			"--json",
			...flags,
		],
		{ env, stdout: "pipe", stderr: "pipe" },
	)
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	])
	return { stdout, stderr, code }
}

test("preview inventories decisions without modifying source or creating a profile", async () => {
	await writeFile(
		join(source, "opencode.jsonc"),
		'{"plugin":["unknown-plugin"],"model":"provider/model"}',
	)
	const original = await readFile(join(source, "opencode.jsonc"))
	const preview = await migrate()
	expect(preview.code).toBe(0)
	const report = JSON.parse(preview.stdout)
	expect(report.unresolved.join("\n")).toContain("project-config")
	expect(report.unresolved.join("\n")).toContain("unverified plugin")
	expect(report.applied).toBe(false)
	expect(await Bun.file(join(destination, "ocx.jsonc")).exists()).toBe(false)
	expect((await migrate(["--apply"])).code).not.toBe(0)
	expect(await readFile(join(source, "opencode.jsonc"))).toEqual(original)
})

test("applied import omits complete runtime directories and embeds local instructions", async () => {
	const native =
		'{\n // Preserve this comment\n "model":"provider/model", "plugin":["unverified"], "instructions":["rules.md"]\n}\n'
	await writeFile(join(source, "opencode.jsonc"), native)
	await writeFile(join(source, "AGENTS.md"), "Original guidance")
	await writeFile(join(source, "rules.md"), "Extra local guidance")
	await mkdir(join(source, "plugins/custom"), { recursive: true })
	await writeFile(join(source, "plugins/custom/package.json"), '{"main":"index.ts"}')
	await writeFile(join(source, "plugins/custom/index.ts"), "throw new Error('never execute')")
	await mkdir(join(source, ".ocx"))
	await writeFile(join(source, ".ocx/receipt.jsonc"), '{"version":1,"installed":{}}')
	await writeFile(join(source, "package.json"), '{"dependencies":{"unverified":"*"}}')
	await writeFile(join(source, ".env"), "FIXTURE_SECRET=private")
	const result = await migrate(["--apply", "--project-config", "ignore", "--omit-plugins"])
	expect(result.code).toBe(0)
	expect(JSON.parse(result.stdout).applied).toBe(true)
	expect(await Bun.file(join(source, "opencode.jsonc")).text()).toBe(native)
	const imported = await Bun.file(join(destination, "opencode.jsonc")).text()
	expect(imported).toContain("Preserve this comment")
	expect(imported).toContain('"model":"provider/model"')
	expect(imported).not.toContain('"plugin"')
	expect(imported).not.toContain('"instructions"')
	const guidance = await Bun.file(join(destination, "AGENTS.md")).text()
	expect(guidance).toContain("Original guidance")
	expect(guidance).toContain("Extra local guidance")
	for (const path of [
		"plugins/custom/package.json",
		"plugins/custom/index.ts",
		"package.json",
		".env",
		".ocx/receipt.jsonc",
	])
		expect(await Bun.file(join(destination, path)).exists()).toBe(false)
	expect(await Bun.file(join(destination, ".ocx/import.json")).exists()).toBe(true)
	expect(JSON.parse(await Bun.file(join(destination, "ocx.jsonc")).text())).toEqual({
		registries: {},
		projectConfig: "ignore",
	})
})

test("external instruction references and retired-tool guidance need explicit decisions", async () => {
	await writeFile(
		join(source, "opencode.json"),
		'{"instructions":["https://example.invalid/rules"]}',
	)
	await writeFile(join(source, "CLAUDE.md"), "Call plan_save to persist plans")
	const blocked = await migrate(["--apply", "--project-config", "inherit"])
	expect(blocked.code).not.toBe(0)
	expect(await Bun.file(join(destination, "ocx.jsonc")).exists()).toBe(false)
	const result = await migrate([
		"--apply",
		"--project-config",
		"inherit",
		"--omit-instructions",
		"--accept-guidance",
	])
	expect(result.code).toBe(0)
	expect(await Bun.file(join(destination, "AGENTS.md")).text()).toBe(
		"Call plan_save to persist plans",
	)
	expect(
		(
			await migrate([
				"--apply",
				"--project-config",
				"inherit",
				"--omit-instructions",
				"--accept-guidance",
			])
		).code,
	).not.toBe(0)
})

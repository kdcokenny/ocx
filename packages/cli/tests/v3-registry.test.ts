import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { ConfigProvider } from "../src/config/provider"
import { REGISTRY_SCHEMA_LATEST_URL } from "../src/constants"
import { _clearFetcherCacheForTests } from "../src/registry/fetcher"
import { installComponents, removeComponents } from "../src/registry/install"
import { readReceipt } from "../src/schemas/config"
import { checkFileIntegrity } from "../src/utils/receipt"

let temporary: string
let root: string
let registry: string
let provider: ConfigProvider

beforeEach(async () => {
	temporary = await mkdtemp(join(tmpdir(), "ocx-v3-registry-"))
	root = join(temporary, "profile")
	registry = join(temporary, "registry")
	await mkdir(root)
	await mkdir(registry)
	provider = {
		cwd: root,
		getRegistries: () => ({ team: { url: pathToFileURL(registry).href } }),
		getComponentPath: () => "",
	}
})
afterEach(async () => {
	_clearFetcherCacheForTests()
	await rm(temporary, { recursive: true, force: true })
})

interface FixtureComponent {
	name: string
	dependencies?: string[]
	files: Record<string, string | Buffer>
}
async function publish(components: FixtureComponent[]) {
	await writeFile(
		join(registry, "index.json"),
		JSON.stringify({
			$schema: REGISTRY_SCHEMA_LATEST_URL,
			name: "test",
			author: "Test",
			components: components.map(({ name }) => ({ name, type: "skill", description: name })),
		}),
	)
	await mkdir(join(registry, "components"), { recursive: true })
	for (const component of components) {
		const manifest = {
			name: component.name,
			type: "skill",
			description: "fixture",
			dependencies: component.dependencies ?? [],
			files: Object.keys(component.files),
		}
		await writeFile(
			join(registry, "components", `${component.name}.json`),
			JSON.stringify({
				name: component.name,
				"dist-tags": { latest: "1.0.0" },
				versions: { "1.0.0": manifest },
			}),
		)
		for (const [path, content] of Object.entries(component.files)) {
			const target = join(registry, "components", component.name, path)
			await mkdir(join(target, ".."), { recursive: true })
			await writeFile(target, content)
		}
	}
	_clearFetcherCacheForTests()
}

test("binary supporting files survive installation and verification", async () => {
	const bytes = Buffer.from([0, 255, 128, 13, 10])
	await publish([{ name: "asset", files: { "skills/assets/data.bin": bytes } }])
	await installComponents(["team/asset"], provider, { mode: "add" })
	expect(await readFile(join(root, "skills/assets/data.bin"))).toEqual(bytes)
	const receipt = await readReceipt(root)
	const entry = Object.values(receipt?.installed ?? {})[0]
	expect(entry).toBeDefined()
	if (!entry) throw new Error("Missing receipt")
	expect((await checkFileIntegrity(root, entry)).intact).toBe(true)
})

test("dry runs check conflicts and leave no receipt or files", async () => {
	await publish([{ name: "guide", files: { "skills/guide/SKILL.md": "one" } }])
	const preview = await installComponents(["team/guide"], provider, { mode: "add", dryRun: true })
	expect(preview.changes).toEqual([{ path: "skills/guide/SKILL.md", action: "add" }])
	expect(await Bun.file(join(root, ".ocx/receipt.jsonc")).exists()).toBe(false)
	expect(await Bun.file(join(root, "skills/guide/SKILL.md")).exists()).toBe(false)
	await mkdir(join(root, "skills/guide"), { recursive: true })
	await writeFile(join(root, "skills/guide/SKILL.md"), "my file")
	await expect(
		installComponents(["team/guide"], provider, { mode: "add", dryRun: true }),
	).rejects.toThrow("Unmanaged")
})

test("updates remove obsolete upstream files and retain unchanged local edits", async () => {
	await publish([
		{ name: "guide", files: { "skills/guide/old.md": "old", "skills/guide/custom.md": "base" } },
	])
	await installComponents(["team/guide"], provider, { mode: "add" })
	await writeFile(join(root, "skills/guide/custom.md"), "user edit")
	await publish([
		{ name: "guide", files: { "skills/guide/new.md": "new", "skills/guide/custom.md": "base" } },
	])
	await installComponents(["team/guide"], provider, { mode: "update" })
	expect(await Bun.file(join(root, "skills/guide/old.md")).exists()).toBe(false)
	expect(await Bun.file(join(root, "skills/guide/new.md")).text()).toBe("new")
	expect(await Bun.file(join(root, "skills/guide/custom.md")).text()).toBe("user edit")
})

test("upstream changes cannot overwrite edited files without an explicit force", async () => {
	await publish([{ name: "guide", files: { "skills/guide/SKILL.md": "base" } }])
	await installComponents(["team/guide"], provider, { mode: "add" })
	await writeFile(join(root, "skills/guide/SKILL.md"), "my edits")
	const receipt = await readFile(join(root, ".ocx/receipt.jsonc"))
	await publish([{ name: "guide", files: { "skills/guide/SKILL.md": "upstream" } }])
	await expect(installComponents(["team/guide"], provider, { mode: "update" })).rejects.toThrow(
		"edited",
	)
	expect(await readFile(join(root, ".ocx/receipt.jsonc"))).toEqual(receipt)
	await installComponents(["team/guide"], provider, { mode: "update", force: true, dryRun: true })
	expect(await Bun.file(join(root, "skills/guide/SKILL.md")).text()).toBe("my edits")
	await installComponents(["team/guide"], provider, { mode: "update", force: true })
	expect(await Bun.file(join(root, "skills/guide/SKILL.md")).text()).toBe("upstream")
})

test("an edited obsolete file blocks the entire update", async () => {
	await publish([{ name: "guide", files: { "skills/guide/old.md": "base" } }])
	await installComponents(["team/guide"], provider, { mode: "add" })
	await writeFile(join(root, "skills/guide/old.md"), "my edits")
	await publish([{ name: "guide", files: { "skills/guide/new.md": "new" } }])
	await expect(installComponents(["team/guide"], provider, { mode: "update" })).rejects.toThrow(
		"Obsolete",
	)
	expect(await Bun.file(join(root, "skills/guide/new.md")).exists()).toBe(false)
})

test("updates install newly declared dependencies and protect shared dependencies on removal", async () => {
	await publish([
		{ name: "one", files: {} },
		{ name: "two", files: {}, dependencies: ["shared"] },
		{ name: "shared", files: { "skills/shared/SKILL.md": "shared" } },
	])
	await installComponents(["team/one", "team/two"], provider, { mode: "add" })
	await publish([
		{ name: "one", files: {}, dependencies: ["new", "shared"] },
		{ name: "two", files: {}, dependencies: ["shared"] },
		{ name: "shared", files: { "skills/shared/SKILL.md": "shared" } },
		{ name: "new", files: { "skills/new/SKILL.md": "new" } },
	])
	await installComponents(["team/one"], provider, { mode: "update" })
	expect(await Bun.file(join(root, "skills/new/SKILL.md")).text()).toBe("new")
	await expect(removeComponents(["team/shared"], provider, {})).rejects.toThrow("depends")
	await removeComponents(["team/one"], provider, {})
	expect(await Bun.file(join(root, "skills/shared/SKILL.md")).text()).toBe("shared")
	await expect(removeComponents(["team/shared"], provider, {})).rejects.toThrow("team/two")
})

test("failed publication restores removed files, replacements, and the original receipt", async () => {
	await publish([
		{ name: "guide", files: { "skills/guide/old.md": "old", "skills/guide/edit.md": "base" } },
	])
	await installComponents(["team/guide"], provider, { mode: "add" })
	const receipt = await readFile(join(root, ".ocx/receipt.jsonc"))
	await publish([
		{ name: "guide", files: { "skills/guide/new.md": "new", "skills/guide/edit.md": "updated" } },
	])
	await expect(
		installComponents(["team/guide"], provider, {
			mode: "update",
			beforeWrite: async (index) => {
				if (index === 3) throw new Error("disk failure")
			},
		}),
	).rejects.toThrow("disk failure")
	expect(await Bun.file(join(root, "skills/guide/new.md")).exists()).toBe(false)
	expect(await Bun.file(join(root, "skills/guide/old.md")).text()).toBe("old")
	expect(await Bun.file(join(root, "skills/guide/edit.md")).text()).toBe("base")
	expect(await readFile(join(root, ".ocx/receipt.jsonc"))).toEqual(receipt)
})

test("remove checks local edits and rolls back a mid-operation failure", async () => {
	await publish([{ name: "guide", files: { "skills/guide/a.md": "a", "skills/guide/b.md": "b" } }])
	await installComponents(["team/guide"], provider, { mode: "add" })
	await expect(
		removeComponents(["team/guide"], provider, {
			beforeWrite: async (index) => {
				if (index === 1) throw new Error("stop")
			},
		}),
	).rejects.toThrow("stop")
	expect(await Bun.file(join(root, "skills/guide/a.md")).text()).toBe("a")
	await writeFile(join(root, "skills/guide/a.md"), "edit")
	await expect(removeComponents(["team/guide"], provider, {})).rejects.toThrow("local edits")
	await removeComponents(["team/guide"], provider, { force: true })
	expect(await Bun.file(join(root, "skills/guide/a.md")).exists()).toBe(false)
})

test("colliding owners and symlink escapes fail before publication", async () => {
	await publish([
		{ name: "one", files: { "skills/shared.md": "same" } },
		{ name: "two", files: { "skills/shared.md": "same" } },
	])
	await expect(
		installComponents(["team/one", "team/two"], provider, { mode: "add" }),
	).rejects.toThrow("Two components")
	await mkdir(join(temporary, "outside"))
	await symlink(join(temporary, "outside"), join(root, "skills"))
	await expect(installComponents(["team/one"], provider, { mode: "add" })).rejects.toThrow(
		"symlink",
	)
	expect(await Bun.file(join(temporary, "outside/shared.md")).exists()).toBe(false)
})

test("ephemeral origins remain usable for updates without silently switching registry URLs", async () => {
	await publish([{ name: "guide", files: { "skills/guide/SKILL.md": "base" } }])
	const ephemeral = { ...provider, getRegistries: () => ({}) }
	await installComponents(["team/guide"], ephemeral, {
		mode: "add",
		from: pathToFileURL(registry).href,
	})
	await publish([{ name: "guide", files: { "skills/guide/SKILL.md": "updated" } }])
	await installComponents(["team/guide"], ephemeral, { mode: "update" })
	expect(await Bun.file(join(root, "skills/guide/SKILL.md")).text()).toBe("updated")
})

test.each([
	".",
	"",
	"/tmp/outside",
	"../outside",
	"skills/../../outside",
	".ocx/receipt.jsonc",
])("tampered receipt paths block forced removal before any deletion: %s", async (path) => {
	await publish([
		{ name: "guide", files: { "skills/guide/a.md": "keep", "skills/guide/b.md": "keep too" } },
	])
	await installComponents(["team/guide"], provider, { mode: "add" })
	const receiptPath = join(root, ".ocx/receipt.jsonc")
	const receipt = await Bun.file(receiptPath).json()
	const entry = Object.values(receipt.installed)[0] as { files: { path: string }[] }
	const file = entry.files[1]
	if (!file) throw new Error("Expected second fixture file")
	file.path = path
	await writeFile(receiptPath, JSON.stringify(receipt))
	const before = await readFile(receiptPath)
	await expect(removeComponents(["team/guide"], provider, { force: true })).rejects.toThrow()
	expect(await readFile(join(root, "skills/guide/a.md"), "utf8")).toBe("keep")
	expect(await readFile(receiptPath)).toEqual(before)
})

test("a file edited after planning aborts and rolls back earlier deletions", async () => {
	await publish([{ name: "guide", files: { "skills/guide/a.md": "a", "skills/guide/b.md": "b" } }])
	await installComponents(["team/guide"], provider, { mode: "add" })
	const before = await readFile(join(root, ".ocx/receipt.jsonc"))
	await expect(
		removeComponents(["team/guide"], provider, {
			beforeWrite: async (index) => {
				if (index === 1) await writeFile(join(root, "skills/guide/b.md"), "concurrent edit")
			},
		}),
	).rejects.toThrow("File changed")
	expect(await readFile(join(root, "skills/guide/a.md"), "utf8")).toBe("a")
	expect(await readFile(join(root, "skills/guide/b.md"), "utf8")).toBe("concurrent edit")
	expect(await readFile(join(root, ".ocx/receipt.jsonc"))).toEqual(before)
})

test("a busy installation refuses a second mutation without changing its receipt", async () => {
	await publish([{ name: "guide", files: { "skills/guide/a.md": "a" } }])
	await installComponents(["team/guide"], provider, { mode: "add" })
	const before = await readFile(join(root, ".ocx/receipt.jsonc"))
	await mkdir(join(root, ".ocx/operation.lock"))
	await expect(removeComponents(["team/guide"], provider, {})).rejects.toThrow(
		"Another OCX operation",
	)
	expect(await readFile(join(root, ".ocx/receipt.jsonc"))).toEqual(before)
})

test("an abrupt process exit leaves a recovery manifest and blocks subsequent mutations", async () => {
	await publish([
		{
			name: "guide",
			files: { "skills/guide/a.md": "original-a", "skills/guide/b.md": "original-b" },
		},
	])
	await installComponents(["team/guide"], provider, { mode: "add" })
	const transactionModule = new URL("../src/utils/file-transaction.ts", import.meta.url).href
	const receiptModule = new URL("../src/utils/receipt.ts", import.meta.url).href
	const script = `
  import { applyFileChanges, withInstallLock } from ${JSON.stringify(transactionModule)};
  import { hashContent } from ${JSON.stringify(receiptModule)};
  await withInstallLock(${JSON.stringify(root)}, () => applyFileChanges(${JSON.stringify(root)}, [
   { path: "skills/guide/a.md", content: Buffer.from("changed-a"), beforeHash: hashContent("original-a") },
   { path: "skills/guide/b.md", content: Buffer.from("changed-b"), beforeHash: hashContent("original-b") },
  ], async index => { if (index === 1) process.exit(42) }));`
	const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" })
	expect(await child.exited).toBe(42)
	expect(await readFile(join(root, "skills/guide/a.md"), "utf8")).toBe("changed-a")
	await expect(removeComponents(["team/guide"], provider, { force: true })).rejects.toThrow(
		"Another OCX operation",
	)
	await rm(join(root, ".ocx/operation.lock"), { recursive: true })
	await expect(removeComponents(["team/guide"], provider, { force: true })).rejects.toThrow(
		"Interrupted operation",
	)
	const stageName = (await readdir(join(root, ".ocx"))).find((name) =>
		name.startsWith("transaction-"),
	)
	if (!stageName) throw new Error("Missing recovery directory")
	const stage = join(root, ".ocx", stageName)
	const manifest = await Bun.file(join(stage, "manifest.json")).json()
	expect(manifest.complete).toBe(false)
	expect(manifest.files[0].path).toBe("skills/guide/a.md")
	// Exercise the documented recovery: restore available originals, then clear the journal.
	await rm(join(root, manifest.files[0].path))
	await rename(join(stage, manifest.files[0].backup), join(root, manifest.files[0].path))
	await rm(stage, { recursive: true })
	const receipt = await readReceipt(root)
	const entry = Object.values(receipt?.installed ?? {})[0]
	if (!entry) throw new Error("Missing original receipt")
	expect((await checkFileIntegrity(root, entry)).intact).toBe(true)
	await removeComponents(["team/guide"], provider, {})
})

test("case-only target collisions fail before copying on every platform", async () => {
	await publish([
		{ name: "one", files: { "skills/guide/README.md": "one" } },
		{ name: "two", files: { "skills/guide/readme.md": "two" } },
	])
	await expect(
		installComponents(["team/one", "team/two"], provider, { mode: "add" }),
	).rejects.toThrow("Receipt assigns")
	expect(await Bun.file(join(root, "skills/guide/README.md")).exists()).toBe(false)
	expect(await Bun.file(join(root, ".ocx/receipt.jsonc")).exists()).toBe(false)
})

test("a stale canonical reference cannot remove a replaced installation", async () => {
	await publish([{ name: "guide", files: { "skills/guide/SKILL.md": "first" } }])
	await installComponents(["team/guide"], provider, { mode: "add" })
	const oldId = Object.keys((await readReceipt(root))?.installed ?? {})[0] as string
	await publish([{ name: "guide", files: { "skills/guide/SKILL.md": "second" } }])
	await installComponents(["team/guide"], provider, { mode: "update" })
	await expect(removeComponents([oldId], provider, {})).rejects.toThrow("not installed")
	expect(await readFile(join(root, "skills/guide/SKILL.md"), "utf8")).toBe("second")
})

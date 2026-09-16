import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runRegistryAddCore } from "../src/commands/registry"
import { REGISTRY_SCHEMA_LATEST_URL } from "../src/constants"
import { _clearFetcherCacheForTests } from "../src/registry/fetcher"
import { targetPathSchema } from "../src/schemas/registry"
import { withDirectoryLock } from "../src/utils/directory-lock"
import { editorCommand } from "../src/utils/editor-command"
import { applyFileChanges, assertNoInterruptedTransaction } from "../src/utils/file-transaction"
import { publishDirectory } from "../src/utils/publish-directory"
import { hashContent } from "../src/utils/receipt"

let root: string
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "ocx-review-"))
})
afterEach(async () => {
	_clearFetcherCacheForTests()
	await rm(root, { recursive: true, force: true })
})

test("registry alias conflicts never send the previous source's credentials to the candidate", async () => {
	const headers: (string | null)[] = []
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			headers.push(request.headers.get("authorization"))
			return Response.json({
				$schema: REGISTRY_SCHEMA_LATEST_URL,
				name: "Candidate",
				author: "test",
				components: [],
			})
		},
	})
	try {
		await expect(
			runRegistryAddCore(
				server.url.href,
				{ name: "team" },
				{
					getRegistries: () => ({
						team: {
							url: "https://private.example.test",
							headers: { Authorization: "Bearer private-secret" },
						},
					}),
					setRegistry: async () => {
						throw new Error("Must not mutate")
					},
				},
			),
		).rejects.toThrow("already exists")
		expect(headers).toEqual([null])
	} finally {
		server.stop(true)
	}
})

test("an old lock owner cannot remove a replacement lock", async () => {
	const lock = join(root, "lock")
	let release!: () => void
	let second!: Promise<void>
	await withDirectoryLock(lock, "busy", async () => {
		await rm(lock, { recursive: true })
		const held = new Promise<void>((resolve) => {
			release = resolve
		})
		let ready!: () => void
		const acquired = new Promise<void>((resolve) => {
			ready = resolve
		})
		second = withDirectoryLock(lock, "busy", async () => {
			ready()
			await held
		})
		await acquired
	})
	await expect(withDirectoryLock(lock, "busy", async () => {})).rejects.toThrow("busy")
	release()
	await second
	expect(await readdir(root)).toEqual([])
})

test("rollback preserves edits made after a file was installed and keeps its backup", async () => {
	await writeFile(join(root, "first"), "original")
	await expect(
		applyFileChanges(
			root,
			[
				{ path: "first", content: Buffer.from("installed"), beforeHash: hashContent("original") },
				{ path: "second", content: Buffer.from("second"), beforeHash: null },
			],
			async (index) => {
				if (index === 1) {
					await writeFile(join(root, "first"), "user edit")
					throw new Error("later failure")
				}
			},
		),
	).rejects.toThrow("Rollback was incomplete")
	expect(await readFile(join(root, "first"), "utf8")).toBe("user edit")
	await expect(assertNoInterruptedTransaction(root)).rejects.toThrow("Interrupted operation")
	const stages = await readdir(join(root, ".ocx"))
	expect(await readFile(join(root, ".ocx", stages[0] as string, "0.original"), "utf8")).toBe(
		"original",
	)
})

test("direct transactions refuse symlink roots and metadata", async () => {
	const real = join(root, "real")
	await mkdir(real)
	const linked = join(root, "linked")
	await symlink(real, linked)
	const changes = [{ path: "file", content: Buffer.from("data"), beforeHash: null }]
	await expect(applyFileChanges(linked, changes)).rejects.toThrow("real directory")
	await symlink(real, join(root, ".ocx"))
	await expect(applyFileChanges(root, changes)).rejects.toThrow("symlink")
	expect(await readdir(real)).toEqual([])
})

test.each([
	"populate",
	"backup",
])("publication recovers a process exit during %s", async (phase) => {
	const out = join(root, "dist")
	await mkdir(out)
	await writeFile(join(out, "old"), "preserved")
	const module = resolve(import.meta.dir, "../src/utils/publish-directory.ts")
	const script = `import {publishDirectory} from ${JSON.stringify(module)}; await publishDirectory(${JSON.stringify(out)}, async candidate => { await Bun.write(candidate + '/new', 'new'); if (${JSON.stringify(phase)} === 'populate') process.exit(42) }, async () => { process.exit(42) })`
	const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" })
	expect(await child.exited).toBe(42)
	await expect(
		publishDirectory(out, async () => {
			throw new Error("invalid next build")
		}),
	).rejects.toThrow("invalid next build")
	expect(await readFile(join(out, "old"), "utf8")).toBe("preserved")
	expect(await readdir(root)).toEqual(["dist"])
})

test("public target validation rejects reserved paths and preserves safe supporting files", () => {
	for (const path of [
		".git/config",
		".ocx/receipt.jsonc",
		"package.json",
		"a/../b",
		"a\\..\\b",
		"skills/CON.txt",
	])
		expect(targetPathSchema.safeParse(path).success).toBe(false)
	expect(targetPathSchema.safeParse("skills/example/data.bin").success).toBe(true)
})

test("editor commands support arguments and quoted paths without shell expansion", () => {
	expect(editorCommand("code --wait")).toEqual(["code", "--wait"])
	expect(editorCommand('"/editor path/editor" --wait "a b"')).toEqual([
		"/editor path/editor",
		"--wait",
		"a b",
	])
	expect(editorCommand('editor "$(no-shell)"')).toEqual(["editor", "$(no-shell)"])
	expect(() => editorCommand('editor "unfinished')).toThrow("Unclosed quote")
})

test("a profile renamed after destination resolution is not recreated by installation", async () => {
	const manager = resolve(import.meta.dir, "../src/profile/manager.ts")
	const destination = resolve(import.meta.dir, "../src/config/provider.ts")
	const installer = resolve(import.meta.dir, "../src/registry/install.ts")
	const script = `import {ProfileManager} from ${JSON.stringify(manager)}; import {resolveDestination} from ${JSON.stringify(destination)}; import {installComponents} from ${JSON.stringify(installer)}; const manager = ProfileManager.create(); await manager.add('work'); const provider = await resolveDestination({profile:'work'}); await manager.move('work','renamed'); try {await installComponents(['team/guide'],provider,{mode:'add'}); process.exit(1)} catch(error) { if (!String(error).includes('not found')) throw error }`
	const child = Bun.spawn([process.execPath, "--eval", script], {
		env: { ...process.env, XDG_CONFIG_HOME: root },
		stdout: "pipe",
		stderr: "pipe",
	})
	const error = await new Response(child.stderr).text()
	expect(await child.exited, error).toBe(0)
	expect(await Bun.file(join(root, "ocx/profiles/work/ocx.jsonc")).exists()).toBe(false)
	expect(await Bun.file(join(root, "ocx/profiles/renamed/ocx.jsonc")).exists()).toBe(true)
})

test.each([
	"stage",
	"previous",
	"candidate",
	"output",
])("publication recovery rejects a replaced %s directory without touching external files", async (replaced) => {
	const out = join(root, "dist")
	const stage = join(root, ".dist.ocx-publish-interrupted")
	const external = join(root, "external")
	const journal = `${out}.ocx-publication.json`
	await mkdir(join(external, "previous"), { recursive: true })
	await writeFile(join(external, "previous/original"), "external original")
	if (replaced === "stage") await symlink(external, stage, "dir")
	else {
		await mkdir(stage)
		const path = replaced === "output" ? out : join(stage, replaced)
		await symlink(external, path, "dir")
	}
	await writeFile(journal, JSON.stringify({ stage }))
	await expect(
		publishDirectory(out, async () => {
			throw new Error("Must not populate while recovery is unsafe")
		}),
	).rejects.toThrow("real directory")
	expect(await readFile(join(external, "previous/original"), "utf8")).toBe("external original")
	expect(await Bun.file(journal).exists()).toBe(true)
})

test("publication recovery retains a journal whose stage is missing", async () => {
	const out = join(root, "dist")
	const journal = `${out}.ocx-publication.json`
	await mkdir(out)
	await writeFile(join(out, "original"), "preserved")
	await writeFile(journal, JSON.stringify({ stage: join(root, ".dist.ocx-publish-missing") }))
	await expect(publishDirectory(out, async () => {})).rejects.toThrow("stage is missing")
	expect(await readFile(join(out, "original"), "utf8")).toBe("preserved")
	expect(await Bun.file(journal).exists()).toBe(true)
})

test("publication recovery does not follow a symlinked journal", async () => {
	const out = join(root, "dist")
	const external = join(root, "external.json")
	await writeFile(external, "external data")
	await symlink(external, `${out}.ocx-publication.json`, "file")
	await expect(publishDirectory(out, async () => {})).rejects.toThrow("regular file")
	expect(await readFile(external, "utf8")).toBe("external data")
})

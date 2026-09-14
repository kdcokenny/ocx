import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { identifyOpenCode, mergedCacheRoot } from "../src/commands/opencode-cache"
import { prepareMergedConfigDirForProfile } from "../src/commands/opencode-overlay"

let root: string
let profileDir: string
let projectDir: string
let cacheRoot: string
const leases: Array<{ cleanup: () => Promise<void> }> = []

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "ocx-cache-test-"))
	profileDir = join(root, "profile")
	projectDir = join(root, "project")
	cacheRoot = join(root, "cache")
	await mkdir(join(profileDir, "plugins"), { recursive: true })
	await mkdir(projectDir)
	await writeFile(
		join(profileDir, "plugins", "local.ts"),
		"export const plugin = () => 'initialized'",
	)
	await writeFile(join(profileDir, "package.json"), '{"dependencies":{}}')
})
afterEach(async () => {
	for (const lease of leases.splice(0)) await lease.cleanup()
	await rm(root, { recursive: true, force: true })
})
async function prepare(
	overrides: Partial<Parameters<typeof prepareMergedConfigDirForProfile>[0]> = {},
) {
	const result = await prepareMergedConfigDirForProfile({
		profileDir,
		projectDir,
		cacheRoot,
		openCodeIdentity: "opencode-1",
		profileVisibilityPolicy: { include: [], exclude: [] },
		...overrides,
	})
	leases.push(result)
	return result
}

async function expirePruneStamp(config: string) {
	const old = new Date(Date.now() - 2 * 86400000)
	await utimes(join(dirname(dirname(dirname(config))), ".pruned-at"), old, old)
}

describe("persistent merged profile cache", () => {
	it("uses absolute XDG cache homes and falls back for empty or relative values", () => {
		expect(mergedCacheRoot("/custom")).toBe("/custom/ocx/opencode/v1")
		for (const invalid of ["", "relative"])
			expect(mergedCacheRoot(invalid)).toBe(join(homedir(), ".cache/ocx/opencode/v1"))
	})
	it("reuses the complete installation root without restoring generated manifests", async () => {
		const first = await prepare()
		await writeFile(join(first.path, "package.json"), '{"dependencies":{"generated":"1"}}')
		await writeFile(join(first.path, "package-lock.json"), "generated lock")
		await mkdir(join(first.path, "node_modules"))
		await writeFile(join(first.path, "node_modules", "installed"), "dependency")
		await first.cleanup()
		const second = await prepare()
		expect(second.path).toBe(first.path)
		expect(await readFile(join(second.path, "package.json"), "utf8")).toContain("generated")
		expect(await readFile(join(second.path, "package-lock.json"), "utf8")).toBe("generated lock")
		expect(await readFile(join(second.path, "node_modules", "installed"), "utf8")).toBe(
			"dependency",
		)
		expect(await readFile(join(profileDir, "package.json"), "utf8")).toBe('{"dependencies":{}}')
		const plugin = await import(join(second.path, "plugins", "local.ts"))
		expect(plugin.plugin()).toBe("initialized")
		await first.cleanup()
		expect((await lstat(join(dirname(second.path), "lease"))).isDirectory()).toBe(true)
	})
	it.each([
		"plugins/local.ts",
		"package.json",
		"package-lock.json",
		"bun.lock",
		".npmrc",
	])("invalidates source edits to %s", async (file) => {
		const first = await prepare()
		await first.cleanup()
		await writeFile(join(profileDir, file), "changed")
		const second = await prepare()
		expect(second.path).not.toBe(first.path)
		expect(await readFile(join(second.path, file), "utf8")).toBe("changed")
	})
	it("invalidates deletion, policy, project identity and executable version", async () => {
		const first = await prepare()
		await first.cleanup()
		const version = await prepare({ openCodeIdentity: "opencode-2" })
		expect(version.path).not.toBe(first.path)
		const otherProject = join(root, "other")
		await mkdir(otherProject)
		expect((await prepare({ projectDir: otherProject })).path).not.toBe(first.path)
		expect(
			(await prepare({ profileVisibilityPolicy: { include: [], exclude: [".opencode/**"] } })).path,
		).not.toBe(first.path)
		await rm(join(profileDir, "plugins", "local.ts"))
		const deleted = await prepare()
		expect(deleted.path).not.toBe(first.path)
		expect(await Bun.file(join(deleted.path, "plugins", "local.ts")).exists()).toBe(false)
	})
	it("keeps overlay precedence and snapshots active generations", async () => {
		await mkdir(join(profileDir, "agents"))
		await writeFile(join(profileDir, "agents", "test.md"), "profile")
		await mkdir(join(projectDir, ".opencode", "agents"), { recursive: true })
		const overlay = join(projectDir, ".opencode", "agents", "test.md")
		await writeFile(overlay, "project")
		const first = await prepare()
		await writeFile(overlay, "changed")
		const second = await prepare()
		expect(await readFile(join(first.path, "agents", "test.md"), "utf8")).toBe("project")
		expect(await readFile(join(second.path, "agents", "test.md"), "utf8")).toBe("changed")
		await writeFile(join(projectDir, ".opencode", "ocx.jsonc"), '{"exclude":["agents/**"]}')
		const excluded = await prepare()
		expect(await readFile(join(excluded.path, "agents", "test.md"), "utf8")).toBe("profile")
	})
	it("skips source node_modules at every depth", async () => {
		for (const base of [profileDir, join(profileDir, "plugins")]) {
			await mkdir(join(base, "node_modules"))
			await writeFile(join(base, "node_modules", "huge"), "do not copy")
		}
		const first = await prepare()
		expect(await readdir(first.path)).not.toContain("node_modules")
		expect(await readdir(join(first.path, "plugins"))).not.toContain("node_modules")
		await first.cleanup()
		await writeFile(join(profileDir, "node_modules", "huge"), "changed output")
		expect((await prepare()).path).toBe(first.path)
	})
	it("leases separate complete roots for simultaneous cold launches and reuses released slots", async () => {
		const concurrent = await Promise.all(Array.from({ length: 8 }, () => prepare()))
		expect(new Set(concurrent.map((item) => item.path)).size).toBe(8)
		for (const item of concurrent) {
			expect(await readFile(join(item.path, "plugins", "local.ts"), "utf8")).toContain(
				"initialized",
			)
			await item.cleanup()
		}
		const next = await prepare()
		expect(concurrent.map((item) => item.path)).toContain(next.path)
		expect((await readdir(cacheRoot)).some((name) => name.startsWith(".staging"))).toBe(false)
	})
	it("keeps dependency writes exclusive during repeated lease contention", async () => {
		const results = await Promise.allSettled(
			Array.from({ length: 8 }, async (_, worker) => {
				for (let turn = 0; turn < 10; turn++) {
					const current = await prepare()
					try {
						const marker = join(current.path, "installer-owner")
						const token = `${worker}:${turn}`
						await writeFile(marker, token)
						await Bun.sleep(1)
						expect(await readFile(marker, "utf8")).toBe(token)
					} finally {
						await current.cleanup()
					}
				}
			}),
		)
		for (const result of results) expect(result.status).toBe("fulfilled")
	})
	it("prepares and reuses installations when hard-link operations are unavailable", async () => {
		const modulePath = join(import.meta.dir, "../src/commands/opencode-overlay.ts")
		const script = `
import { mock } from "bun:test"
import * as fs from "node:fs/promises"
const original = { ...fs }
mock.module("node:fs/promises", () => ({ ...original, link: async () => { throw Object.assign(new Error("unsupported hard link"), { code: "ENOSYS" }) } }))
const { prepareMergedConfigDirForProfile } = await import(${JSON.stringify(modulePath)})
const options = ${JSON.stringify({ profileDir, projectDir, cacheRoot, openCodeIdentity: "test", profileVisibilityPolicy: { include: [], exclude: [] } })}
const first = await prepareMergedConfigDirForProfile(options)
await first.cleanup()
const second = await prepareMergedConfigDirForProfile(options)
if (first.path !== second.path) throw new Error("installation was not reused")
await second.cleanup()
`
		const proc = Bun.spawn([process.execPath, "--eval", script], {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
		})
		const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
		expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
	})

	it("preserves interrupted installer state without claiming dependencies are ready", async () => {
		const first = await prepare()
		await mkdir(join(first.path, "node_modules"))
		await writeFile(join(first.path, "node_modules", "partial"), "unfinished")
		await first.cleanup()
		const second = await prepare()
		expect(second.path).toBe(first.path)
		expect(await readdir(join(second.path, "node_modules"))).toEqual(["partial"])
		const metadata = JSON.parse(await readFile(join(dirname(second.path), "metadata.json"), "utf8"))
		expect(metadata).not.toHaveProperty("dependenciesReady")
	})
	it("prunes inactive old slots while retaining active launches and private permissions", async () => {
		const active = await prepare()
		const inactive = await prepare()
		await inactive.cleanup()
		const old = new Date(Date.now() - 31 * 86400000)
		for (const item of [active, inactive])
			await utimes(join(dirname(item.path), "metadata.json"), old, old)
		await expirePruneStamp(active.path)
		await prepare({ openCodeIdentity: "new" })
		expect(await Bun.file(join(active.path, "package.json")).exists()).toBe(true)
		expect(await Bun.file(join(inactive.path, "package.json")).exists()).toBe(false)
		expect((await lstat(cacheRoot)).mode & 0o777).toBe(0o700)
	})
	it("snapshots profile symlinks and invalidates target changes without writing through", async () => {
		const source = join(root, "manifest.json")
		await writeFile(source, '{"private":true}')
		await rm(join(profileDir, "package.json"))
		await symlink(source, join(profileDir, "package.json"))
		const first = await prepare()
		expect((await lstat(join(first.path, "package.json"))).isSymbolicLink()).toBe(false)
		await writeFile(join(first.path, "package.json"), "generated")
		expect(await readFile(source, "utf8")).toBe('{"private":true}')
		await first.cleanup()
		await writeFile(source, '{"private":false}')
		expect((await prepare()).path).not.toBe(first.path)
	})
	it("fingerprints bytes published by the validated copy rather than an earlier source read", async () => {
		await mkdir(join(projectDir, ".opencode", "agents"), { recursive: true })
		const source = join(projectDir, ".opencode", "agents", "test.md")
		await writeFile(source, "before")
		const changed = await prepare({
			seams: {
				copy: {
					publishAtomically: async (_, destination) => {
						await writeFile(source, "after")
						await writeFile(destination, "after")
					},
				},
			},
		})
		await changed.cleanup()
		expect((await prepare()).path).toBe(changed.path)
	})

	it("avoids abandoned slots and prunes them after retention expires", async () => {
		const abandoned = await prepare()
		await abandoned.cleanup()
		const child = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore" })
		await child.exited
		await writeFile(join(dirname(abandoned.path), "lease"), String(child.pid))
		const next = await prepare()
		expect(next.path).not.toBe(abandoned.path)
		const old = new Date(Date.now() - 31 * 86400000)
		await utimes(join(dirname(abandoned.path), "metadata.json"), old, old)
		await expirePruneStamp(abandoned.path)
		await Promise.all(Array.from({ length: 6 }, () => prepare()))
		expect(await Bun.file(join(abandoned.path, "package.json")).exists()).toBe(false)
		expect(await Bun.file(join(next.path, "package.json")).exists()).toBe(true)
	})
	it("cleans failed staging without publishing a partial generation", async () => {
		await mkdir(join(projectDir, ".opencode", "agents"), { recursive: true })
		await writeFile(join(projectDir, ".opencode", "agents", "test.md"), "agent")
		await expect(
			prepare({
				seams: {
					copy: {
						publishAtomically: async () => {
							throw new Error("copy interrupted")
						},
					},
				},
			}),
		).rejects.toThrow("copy interrupted")
		expect(await readdir(cacheRoot)).toEqual([])
		const next = await prepare()
		expect(await readFile(join(next.path, "agents", "test.md"), "utf8")).toBe("agent")
	})
	it("rejects a symlink cache root", async () => {
		const outside = join(root, "outside")
		await mkdir(outside)
		await symlink(outside, cacheRoot)
		await expect(prepare()).rejects.toThrow("real directory")
		expect(await readdir(outside)).toEqual([])
	})

	it("skips pruning until the daily interval expires", async () => {
		const inactive = await prepare()
		await inactive.cleanup()
		const old = new Date(Date.now() - 31 * 86400000)
		await utimes(join(dirname(inactive.path), "metadata.json"), old, old)
		await prepare({ openCodeIdentity: "different" })
		expect(await Bun.file(join(inactive.path, "package.json")).exists()).toBe(true)
		await expirePruneStamp(inactive.path)
		await prepare({ openCodeIdentity: "third" })
		expect(await Bun.file(join(inactive.path, "package.json")).exists()).toBe(false)
	})
	it.each([
		"process.exit(2)",
		"process.exit(0)",
	])("isolates unversioned launchers: %s", async (body) => {
		const wrapper = join(root, "wrapper")
		await writeFile(wrapper, `#!${process.execPath}\n${body}\n`)
		await chmod(wrapper, 0o755)
		const first = await identifyOpenCode(wrapper)
		const second = await identifyOpenCode(wrapper)
		expect(JSON.parse(first)[2]).toBeNull()
		expect(first).not.toBe(second)
		const initial = await prepare({ openCodeIdentity: first })
		await initial.cleanup()
		expect((await prepare({ openCodeIdentity: second })).path).not.toBe(initial.path)
	})
	it("bounds version probing even if the wrapper ignores SIGTERM", async () => {
		const wrapper = join(root, "slow-wrapper")
		await writeFile(
			wrapper,
			`#!${process.execPath}\nprocess.on("SIGTERM", () => {}); setInterval(() => {}, 1000)\n`,
		)
		await chmod(wrapper, 0o755)
		expect(JSON.parse(await identifyOpenCode(wrapper))[2]).toBeNull()
	}, 10000)

	it("identifies executable contents and version", async () => {
		const identity = await identifyOpenCode(process.execPath)
		expect(JSON.parse(identity)[2]).toBe(Bun.version)
	})
})

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import { getGlobalOpencodeRoot } from "../src/profile/paths"
import { getGlobalTuiConfigPath } from "../src/updaters/update-tui-config"
import { cleanupTempDir, createTempDir, parseJsonc as parseJsoncHelper, runCLI } from "./helpers"

const THIRD_PARTY = "@streetturtle/opencode-context-progress"

interface RegistryState {
	/** component name -> manifest (mutable, so tests can simulate upstream changes) */
	components: Record<string, Record<string, unknown>>
	/** "<component>/<filePath>" -> file content */
	files: Record<string, string>
}

/**
 * A tiny mock registry whose served manifests + files are mutable (unlike the shared
 * startMockRegistry), so tests can simulate an upstream `tui` block changing.
 */
function startTuiRegistry(state: RegistryState): { url: string; stop: () => void } {
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			const { pathname } = new URL(req.url)

			if (pathname === "/index.json") {
				return Response.json({
					$schema: "https://ocx.kdco.dev/schemas/v2/registry.json",
					name: "TUI Test Registry",
					version: "1.0.0",
					author: "Test",
					components: Object.values(state.components).map((m) => ({
						name: m.name,
						type: m.type,
						description: m.description,
					})),
				})
			}

			const componentMatch = pathname.match(/^\/components\/(.+)\.json$/)
			if (componentMatch) {
				const manifest = state.components[componentMatch[1] as string]
				if (manifest) {
					return Response.json({
						name: manifest.name,
						"dist-tags": { latest: "1.0.0" },
						versions: { "1.0.0": manifest },
					})
				}
			}

			const fileMatch = pathname.match(/^\/components\/(.+?)\/(.+)$/)
			if (fileMatch) {
				const [, name, filePath] = fileMatch
				const content = state.files[`${name}/${filePath}`]
				if (content !== undefined) {
					return new Response(content)
				}
			}

			return new Response("Not Found", { status: 404 })
		},
	})
	return { url: `http://localhost:${server.port}`, stop: () => server.stop() }
}

async function setupProject(name: string, registryUrl: string): Promise<string> {
	const dir = await createTempDir(name)
	await runCLI(["init"], dir)
	const configPath = join(dir, ".opencode", "ocx.jsonc")
	const config = parseJsoncHelper(await readFile(configPath, "utf-8")) as Record<string, unknown>
	config.registries = { kdco: { url: registryUrl } }
	await writeFile(configPath, JSON.stringify(config, null, 2))
	return dir
}

async function seedTuiJson(entries: string[]): Promise<void> {
	await mkdir(getGlobalOpencodeRoot(), { recursive: true })
	await writeFile(
		getGlobalTuiConfigPath(),
		JSON.stringify({ $schema: "https://opencode.ai/tui.json", plugin: entries }, null, "\t"),
	)
}

async function readTuiPlugins(): Promise<string[]> {
	const content = await readFile(getGlobalTuiConfigPath(), "utf-8")
	return (parseJsonc(content) as { plugin?: string[] }).plugin ?? []
}

describe("ocx add/update — tui.json", () => {
	let testDir: string
	let registry: { url: string; stop: () => void }
	let state: RegistryState

	beforeEach(async () => {
		await rm(getGlobalTuiConfigPath(), { force: true })
		state = { components: {}, files: {} }
		registry = startTuiRegistry(state)
	})

	afterEach(async () => {
		registry?.stop()
		await rm(getGlobalTuiConfigPath(), { force: true })
		if (testDir) await cleanupTempDir(testDir)
	})

	it("installs the file and adds its absolute path to tui.json, preserving third-party entries", async () => {
		state.components["tui-status"] = {
			name: "tui-status",
			type: "plugin",
			description: "A TUI status plugin",
			files: [{ path: "status.tui.tsx", target: "plugins/tui-status/status.tui.tsx" }],
			dependencies: [],
			tui: { plugin: ["./plugins/tui-status/status.tui.tsx"] },
		}
		state.files["tui-status/status.tui.tsx"] = "// v1"

		await seedTuiJson([THIRD_PARTY])
		testDir = await setupProject("tui-add", registry.url)

		const { exitCode, output } = await runCLI(["add", "kdco/tui-status"], testDir)
		if (exitCode !== 0) console.log(output)
		expect(exitCode).toBe(0)

		const installedFile = join(testDir, ".opencode", "plugins", "tui-status", "status.tui.tsx")
		expect(existsSync(installedFile)).toBe(true)

		const plugins = await readTuiPlugins()
		expect(plugins).toContain(installedFile)
		expect(plugins).toContain(THIRD_PARTY)
	})

	it("reflects an upstream tui removal on update, leaving third-party entries intact", async () => {
		state.components["tui-status"] = {
			name: "tui-status",
			type: "plugin",
			description: "A TUI status plugin",
			files: [{ path: "status.tui.tsx", target: "plugins/tui-status/status.tui.tsx" }],
			dependencies: [],
			tui: { plugin: ["./plugins/tui-status/status.tui.tsx"] },
		}
		state.files["tui-status/status.tui.tsx"] = "// v1"

		await seedTuiJson([THIRD_PARTY])
		testDir = await setupProject("tui-update-remove", registry.url)

		expect((await runCLI(["add", "kdco/tui-status"], testDir)).exitCode).toBe(0)
		const installedFile = join(testDir, ".opencode", "plugins", "tui-status", "status.tui.tsx")
		expect(await readTuiPlugins()).toContain(installedFile)

		// Upstream drops the tui block and changes the file (so the update is detected).
		const next = { ...state.components["tui-status"] }
		delete (next as { tui?: unknown }).tui
		state.components["tui-status"] = next
		state.files["tui-status/status.tui.tsx"] = "// v2"

		const upd = await runCLI(["update", "kdco/tui-status"], testDir)
		if (upd.exitCode !== 0) console.log(upd.output)
		expect(upd.exitCode).toBe(0)

		const plugins = await readTuiPlugins()
		expect(plugins).not.toContain(installedFile)
		expect(plugins).toContain(THIRD_PARTY)
	})

	it("detects a tui-only manifest change (identical files) on update", async () => {
		// Ships two files but registers only one; later registers the second with NO
		// file-content change — the bundle hash is identical, so only tui-change
		// detection can surface this update.
		state.components.p = {
			name: "p",
			type: "plugin",
			description: "plugin with two tui files",
			files: [
				{ path: "a.tui.tsx", target: "plugins/p/a.tui.tsx" },
				{ path: "b.tui.tsx", target: "plugins/p/b.tui.tsx" },
			],
			dependencies: [],
			tui: { plugin: ["./plugins/p/a.tui.tsx"] },
		}
		state.files["p/a.tui.tsx"] = "// a"
		state.files["p/b.tui.tsx"] = "// b"

		testDir = await setupProject("tui-only-change", registry.url)
		expect((await runCLI(["add", "kdco/p"], testDir)).exitCode).toBe(0)

		const absA = join(testDir, ".opencode", "plugins", "p", "a.tui.tsx")
		const absB = join(testDir, ".opencode", "plugins", "p", "b.tui.tsx")
		expect(await readTuiPlugins()).toEqual([absA])

		// Register b too — WITHOUT changing any file content.
		;(state.components.p as { tui: { plugin: string[] } }).tui.plugin = [
			"./plugins/p/a.tui.tsx",
			"./plugins/p/b.tui.tsx",
		]

		const upd = await runCLI(["update", "kdco/p"], testDir)
		if (upd.exitCode !== 0) console.log(upd.output)
		expect(upd.exitCode).toBe(0)

		const plugins = await readTuiPlugins()
		expect(plugins).toContain(absA)
		expect(plugins).toContain(absB)
	})

	it("does not unregister a shared entry still declared by another component", async () => {
		const shared = "shared-tui-plugin"
		for (const name of ["comp-a", "comp-b"]) {
			state.components[name] = {
				name,
				type: "plugin",
				description: `component ${name}`,
				files: [{ path: "marker.ts", target: `plugins/${name}/marker.ts` }],
				dependencies: [],
				tui: { plugin: [shared] },
			}
			state.files[`${name}/marker.ts`] = "// v1"
		}

		testDir = await setupProject("tui-shared-entry", registry.url)
		expect((await runCLI(["add", "kdco/comp-a", "kdco/comp-b"], testDir)).exitCode).toBe(0)
		expect(await readTuiPlugins()).toEqual([shared])

		// comp-a drops the shared entry (and changes its file so the update is detected).
		;(state.components["comp-a"] as { tui: { plugin: string[] } }).tui.plugin = []
		state.files["comp-a/marker.ts"] = "// v2"

		const upd = await runCLI(["update", "kdco/comp-a"], testDir)
		if (upd.exitCode !== 0) console.log(upd.output)
		expect(upd.exitCode).toBe(0)

		// comp-b still declares it, so it must remain registered.
		expect(await readTuiPlugins()).toContain(shared)
	})
})

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
	manifest: Record<string, unknown>
	fileContents: Record<string, string>
}

/**
 * A tiny mock registry whose served manifest is mutable (unlike the shared
 * startMockRegistry), so we can simulate an upstream `tui` block changing.
 */
function startTuiRegistry(state: RegistryState): { url: string; stop: () => void } {
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			const { pathname } = new URL(req.url)

			if (pathname === "/index.json") {
				const m = state.manifest
				return Response.json({
					$schema: "https://ocx.kdco.dev/schemas/v2/registry.json",
					name: "TUI Test Registry",
					version: "1.0.0",
					author: "Test",
					components: [{ name: m.name, type: m.type, description: m.description }],
				})
			}

			const componentMatch = pathname.match(/^\/components\/(.+)\.json$/)
			if (componentMatch && componentMatch[1] === state.manifest.name) {
				return Response.json({
					name: state.manifest.name,
					"dist-tags": { latest: "1.0.0" },
					versions: { "1.0.0": state.manifest },
				})
			}

			const fileMatch = pathname.match(/^\/components\/(.+?)\/(.+)$/)
			if (fileMatch) {
				const [, name, filePath] = fileMatch
				const content = state.fileContents[filePath]
				if (name === state.manifest.name && content !== undefined) {
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

function baseManifest(): Record<string, unknown> {
	return {
		name: "tui-status",
		type: "plugin",
		description: "A TUI status plugin",
		files: [{ path: "status.tui.tsx", target: "plugins/tui-status/status.tui.tsx" }],
		dependencies: [],
		tui: { plugin: ["./plugins/tui-status/status.tui.tsx"] },
	}
}

describe("ocx add/update — tui.json", () => {
	let testDir: string
	let registry: { url: string; stop: () => void }
	let state: RegistryState

	beforeEach(async () => {
		await rm(getGlobalTuiConfigPath(), { force: true })
		state = { manifest: baseManifest(), fileContents: { "status.tui.tsx": "// v1" } }
		registry = startTuiRegistry(state)
	})

	afterEach(async () => {
		registry?.stop()
		await rm(getGlobalTuiConfigPath(), { force: true })
		if (testDir) await cleanupTempDir(testDir)
	})

	it("installs the file and adds its absolute path to tui.json, preserving third-party entries", async () => {
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
		await seedTuiJson([THIRD_PARTY])
		testDir = await setupProject("tui-update-remove", registry.url)

		const add = await runCLI(["add", "kdco/tui-status"], testDir)
		expect(add.exitCode).toBe(0)

		const installedFile = join(testDir, ".opencode", "plugins", "tui-status", "status.tui.tsx")
		expect(await readTuiPlugins()).toContain(installedFile)

		// Upstream drops the tui block and changes the file (so the update is detected).
		const nextManifest = baseManifest()
		delete nextManifest.tui
		state.manifest = nextManifest
		state.fileContents["status.tui.tsx"] = "// v2"

		const upd = await runCLI(["update", "kdco/tui-status"], testDir)
		if (upd.exitCode !== 0) console.log(upd.output)
		expect(upd.exitCode).toBe(0)

		const plugins = await readTuiPlugins()
		expect(plugins).not.toContain(installedFile)
		expect(plugins).toContain(THIRD_PARTY)
	})
})

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import { getGlobalOpencodeRoot } from "../src/profile/paths"
import {
	applyTuiConfigDelta,
	getGlobalTuiConfigPath,
	readTuiConfig,
	resolveTuiPluginEntries,
} from "../src/updaters/update-tui-config"

const THIRD_PARTY = "@streetturtle/opencode-context-progress"

async function readTuiPlugins(): Promise<string[]> {
	const content = await readFile(getGlobalTuiConfigPath(), "utf-8")
	const parsed = parseJsonc(content) as { plugin?: string[] }
	return parsed.plugin ?? []
}

describe("update-tui-config", () => {
	// preload.ts points XDG_CONFIG_HOME at an isolated per-process temp dir, so the
	// global tui.json lives under it. Reset it before/after each test.
	beforeEach(async () => {
		await rm(getGlobalTuiConfigPath(), { force: true })
	})

	afterEach(async () => {
		await rm(getGlobalTuiConfigPath(), { force: true })
	})

	describe("applyTuiConfigDelta", () => {
		it("creates tui.json with a seed $schema and the added plugin when absent", async () => {
			const result = await applyTuiConfigDelta([], ["/abs/plugins/my-plugin/status.tui.tsx"])

			expect(result.created).toBe(true)
			expect(result.changed).toBe(true)
			expect(result.path).toBe(getGlobalTuiConfigPath())

			const content = await readFile(getGlobalTuiConfigPath(), "utf-8")
			const config = parseJsonc(content) as { $schema?: string; plugin?: string[] }
			expect(config.$schema).toBe("https://opencode.ai/tui.json")
			expect(config.plugin).toEqual(["/abs/plugins/my-plugin/status.tui.tsx"])
		})

		it("preserves an unrelated pre-existing entry while adding the new one", async () => {
			await mkdir(getGlobalOpencodeRoot(), { recursive: true })
			await writeFile(
				getGlobalTuiConfigPath(),
				JSON.stringify(
					{ $schema: "https://opencode.ai/tui.json", plugin: [THIRD_PARTY] },
					null,
					"\t",
				),
			)

			await applyTuiConfigDelta([], ["/abs/plugins/mine/status.tui.tsx"])

			const plugins = await readTuiPlugins()
			expect(plugins).toContain(THIRD_PARTY)
			expect(plugins).toContain("/abs/plugins/mine/status.tui.tsx")
			expect(plugins).toHaveLength(2)
		})

		it("dedupes on re-apply (idempotent)", async () => {
			await applyTuiConfigDelta([], ["/abs/plugins/mine/status.tui.tsx"])
			const result = await applyTuiConfigDelta([], ["/abs/plugins/mine/status.tui.tsx"])

			expect(result.changed).toBe(false)
			expect(await readTuiPlugins()).toEqual(["/abs/plugins/mine/status.tui.tsx"])
		})

		it("preserves JSONC comments and other keys", async () => {
			await mkdir(getGlobalOpencodeRoot(), { recursive: true })
			await writeFile(
				getGlobalTuiConfigPath(),
				`{
	// keep this comment
	"$schema": "https://opencode.ai/tui.json",
	"plugin": ["${THIRD_PARTY}"]
}
`,
			)

			await applyTuiConfigDelta([], ["/abs/plugins/mine/status.tui.tsx"])

			const content = await readFile(getGlobalTuiConfigPath(), "utf-8")
			expect(content).toContain("// keep this comment")
			expect(content).toContain(THIRD_PARTY)
		})

		it("reconciles by delta: drops old, adds new, keeps third-party", async () => {
			await mkdir(getGlobalOpencodeRoot(), { recursive: true })
			await writeFile(
				getGlobalTuiConfigPath(),
				JSON.stringify(
					{ $schema: "https://opencode.ai/tui.json", plugin: [THIRD_PARTY, "/abs/old.tui.tsx"] },
					null,
					"\t",
				),
			)

			await applyTuiConfigDelta(["/abs/old.tui.tsx"], ["/abs/new.tui.tsx"])

			const plugins = await readTuiPlugins()
			expect(plugins).toContain(THIRD_PARTY)
			expect(plugins).toContain("/abs/new.tui.tsx")
			expect(plugins).not.toContain("/abs/old.tui.tsx")
		})

		it("keeps an entry present in both the remove and add sets (unchanged component)", async () => {
			await applyTuiConfigDelta([], ["/abs/plugins/mine/status.tui.tsx"])
			// Same entry declared old and new -> stays.
			await applyTuiConfigDelta(
				["/abs/plugins/mine/status.tui.tsx"],
				["/abs/plugins/mine/status.tui.tsx"],
			)

			expect(await readTuiPlugins()).toEqual(["/abs/plugins/mine/status.tui.tsx"])
		})
	})

	describe("resolveTuiPluginEntries", () => {
		it("passes npm names and absolute paths through unchanged", () => {
			const resolved = resolveTuiPluginEntries(
				[THIRD_PARTY, "/already/absolute/status.tui.tsx"],
				"/tmp/some-project",
			)
			expect(resolved).toEqual([THIRD_PARTY, "/already/absolute/status.tui.tsx"])
		})

		it("resolves ./relative entries to the local .opencode/ install path", () => {
			// A project dir outside the global opencode root => local (non-flattened) scope.
			const installRoot = join(import.meta.dir, "fixtures", "tui-local-project")
			const [resolved] = resolveTuiPluginEntries(
				["./plugins/my-plugin/status.tui.tsx"],
				installRoot,
			)
			expect(resolved).toBe(
				join(installRoot, ".opencode", "plugins", "my-plugin", "status.tui.tsx"),
			)
		})

		it("resolves ./relative entries to the flattened path for global installs", () => {
			// The global opencode root => flattened scope (no .opencode/ prefix).
			const installRoot = getGlobalOpencodeRoot()
			const [resolved] = resolveTuiPluginEntries(
				["./plugins/my-plugin/status.tui.tsx"],
				installRoot,
			)
			expect(resolved).toBe(join(installRoot, "plugins", "my-plugin", "status.tui.tsx"))
		})
	})

	describe("readTuiConfig", () => {
		it("returns null when tui.json does not exist", async () => {
			expect(await readTuiConfig()).toBeNull()
		})
	})
})

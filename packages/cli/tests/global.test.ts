import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { getGlobalConfigPath, globalDirectoryExists, resolveTargetPath } from "../src/utils/paths"

describe("global utilities", () => {
	describe("getGlobalConfigPath", () => {
		const originalXdg = process.env.XDG_CONFIG_HOME

		afterEach(() => {
			if (originalXdg) {
				process.env.XDG_CONFIG_HOME = originalXdg
			} else {
				delete process.env.XDG_CONFIG_HOME
			}
		})

		it("returns ~/.config/opencode by default", () => {
			delete process.env.XDG_CONFIG_HOME
			const result = getGlobalConfigPath()
			expect(result).toBe(join(homedir(), ".config", "opencode"))
		})

		it("uses XDG_CONFIG_HOME when set and absolute", () => {
			process.env.XDG_CONFIG_HOME = "/custom/config"
			const result = getGlobalConfigPath()
			expect(result).toBe("/custom/config/opencode")
		})

		it("ignores XDG_CONFIG_HOME when relative", () => {
			process.env.XDG_CONFIG_HOME = "relative/path"
			const result = getGlobalConfigPath()
			expect(result).toBe(join(homedir(), ".config", "opencode"))
		})
	})

	describe("globalDirectoryExists", () => {
		const testDir = join(homedir(), ".config", "opencode-test-temp")

		beforeEach(() => {
			if (existsSync(testDir)) {
				rmSync(testDir, { recursive: true })
			}
		})

		afterEach(() => {
			if (existsSync(testDir)) {
				rmSync(testDir, { recursive: true })
			}
		})

		it("returns false when directory does not exist", async () => {
			// Point to non-existent dir via XDG
			const originalXdg = process.env.XDG_CONFIG_HOME
			process.env.XDG_CONFIG_HOME = join(homedir(), ".config", "nonexistent-test-dir")

			const result = await globalDirectoryExists()
			expect(result).toBe(false)

			if (originalXdg) {
				process.env.XDG_CONFIG_HOME = originalXdg
			} else {
				delete process.env.XDG_CONFIG_HOME
			}
		})
	})

	describe("resolveTargetPath", () => {
		it("strips .opencode/ prefix when isFlattened is true", () => {
			const result = resolveTargetPath(".opencode/plugin/foo.ts", true)
			expect(result).toBe("plugin/foo.ts")
		})

		it("preserves .opencode/ prefix when isFlattened is false", () => {
			const result = resolveTargetPath(".opencode/plugin/foo.ts", false)
			expect(result).toBe(".opencode/plugin/foo.ts")
		})

		it("preserves path without .opencode/ prefix even when isFlattened", () => {
			const result = resolveTargetPath("other/path.ts", true)
			expect(result).toBe("other/path.ts")
		})

		it("handles nested paths correctly when isFlattened", () => {
			const result = resolveTargetPath(".opencode/components/ui/button.tsx", true)
			expect(result).toBe("components/ui/button.tsx")
		})
	})
})

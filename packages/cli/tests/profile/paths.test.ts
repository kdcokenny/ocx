import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { findLocalConfigDir, getGlobalConfig } from "../../src/profile/paths"

describe("findLocalConfigDir", () => {
	let tempDir: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "ocx-paths-"))
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	it("returns .opencode path when found in given directory", () => {
		const configDir = join(tempDir, ".opencode")
		mkdirSync(configDir)
		expect(findLocalConfigDir(tempDir)).toBe(configDir)
	})

	it("walks up to find .opencode in parent directory", () => {
		const configDir = join(tempDir, ".opencode")
		const subdir = join(tempDir, "subdir")
		mkdirSync(configDir)
		mkdirSync(subdir)
		expect(findLocalConfigDir(subdir)).toBe(configDir)
	})

	it("walks up multiple levels to find .opencode", () => {
		const configDir = join(tempDir, ".opencode")
		const deepDir = join(tempDir, "a", "b", "c")
		mkdirSync(configDir)
		mkdirSync(deepDir, { recursive: true })
		expect(findLocalConfigDir(deepDir)).toBe(configDir)
	})

	it("returns null when .git is found before .opencode", () => {
		const gitDir = join(tempDir, ".git")
		const subdir = join(tempDir, "subdir")
		mkdirSync(gitDir)
		mkdirSync(subdir)
		expect(findLocalConfigDir(subdir)).toBeNull()
	})

	it("prefers closest .opencode when multiple exist", () => {
		const parentConfig = join(tempDir, ".opencode")
		const childDir = join(tempDir, "child")
		const childConfig = join(childDir, ".opencode")
		mkdirSync(parentConfig)
		mkdirSync(childConfig, { recursive: true })
		expect(findLocalConfigDir(childDir)).toBe(childConfig)
	})

	it("ignores .opencode if it is a file, not a directory", () => {
		const gitDir = join(tempDir, ".git") // Create boundary
		const subdir = join(tempDir, "subdir")
		mkdirSync(gitDir)
		mkdirSync(subdir)
		writeFileSync(join(subdir, ".opencode"), "not a directory")
		expect(findLocalConfigDir(subdir)).toBeNull()
	})
})

describe("getGlobalConfig", () => {
	it("returns XDG_CONFIG_HOME path when set", () => {
		const originalXdg = process.env.XDG_CONFIG_HOME
		try {
			process.env.XDG_CONFIG_HOME = "/custom/config"
			expect(getGlobalConfig()).toBe("/custom/config/opencode/ocx.jsonc")
		} finally {
			if (originalXdg !== undefined) {
				process.env.XDG_CONFIG_HOME = originalXdg
			} else {
				delete process.env.XDG_CONFIG_HOME
			}
		}
	})

	it("returns default ~/.config path when XDG_CONFIG_HOME is not set", () => {
		const originalXdg = process.env.XDG_CONFIG_HOME
		try {
			delete process.env.XDG_CONFIG_HOME
			const expected = join(homedir(), ".config", "opencode", "ocx.jsonc")
			expect(getGlobalConfig()).toBe(expected)
		} finally {
			if (originalXdg !== undefined) {
				process.env.XDG_CONFIG_HOME = originalXdg
			} else {
				delete process.env.XDG_CONFIG_HOME
			}
		}
	})
})

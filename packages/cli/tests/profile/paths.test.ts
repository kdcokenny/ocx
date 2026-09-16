import { describe, expect, it } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"
import { getGlobalConfig } from "../../src/profile/paths"

describe("getGlobalConfig", () => {
	it("returns XDG_CONFIG_HOME path when set", () => {
		const originalXdg = process.env.XDG_CONFIG_HOME
		try {
			process.env.XDG_CONFIG_HOME = "/custom/config"
			expect(getGlobalConfig()).toBe("/custom/config/ocx/ocx.jsonc")
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
			const expected = join(homedir(), ".config", "ocx", "ocx.jsonc")
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

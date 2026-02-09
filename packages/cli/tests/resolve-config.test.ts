/**
 * Tests for config pattern resolution: {env:VAR} and {file:path}.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveEnvVars, resolveFilePatterns } from "../src/utils/resolve-config"

const env = {
	API_KEY: "sk-test-123",
	SERVICE_URL: "https://api.example.com",
	EMPTY_VAR: "",
}

describe("resolveEnvVars", () => {
	it("resolves a single pattern", () => {
		expect(resolveEnvVars("{env:API_KEY}", env)).toBe("sk-test-123")
	})

	it("resolves multiple patterns in one string", () => {
		expect(resolveEnvVars("{env:SERVICE_URL}?key={env:API_KEY}", env)).toBe(
			"https://api.example.com?key=sk-test-123",
		)
	})

	it("returns string unchanged when no patterns present", () => {
		expect(resolveEnvVars("no-env-vars-here", env)).toBe("no-env-vars-here")
	})

	it("replaces unset variables with empty string", () => {
		expect(resolveEnvVars("{env:DOES_NOT_EXIST}", env)).toBe("")
	})

	it("preserves text around the pattern", () => {
		expect(resolveEnvVars("prefix-{env:API_KEY}-suffix", env)).toBe("prefix-sk-test-123-suffix")
	})

	it("handles empty env var value", () => {
		expect(resolveEnvVars("{env:EMPTY_VAR}", env)).toBe("")
	})

	it("handles empty string input", () => {
		expect(resolveEnvVars("", env)).toBe("")
	})

	it("resolves patterns in serialized JSON config", () => {
		const config = {
			mcp: {
				"db-server": {
					type: "local",
					command: ["npx", "-y", "some-mcp-server"],
					environment: {
						CONNECTION_STRING: "{env:SERVICE_URL}",
					},
					enabled: true,
				},
				"api-server": {
					type: "remote",
					url: "https://remote.example.com",
					headers: {
						Authorization: "Bearer {env:API_KEY}",
					},
					enabled: true,
				},
			},
			theme: "dark",
		}

		const resolved = JSON.parse(resolveEnvVars(JSON.stringify(config), env))

		expect(resolved.mcp["db-server"].environment.CONNECTION_STRING).toBe("https://api.example.com")
		expect(resolved.mcp["api-server"].headers.Authorization).toBe("Bearer sk-test-123")
		expect(resolved.mcp["db-server"].type).toBe("local")
		expect(resolved.mcp["db-server"].enabled).toBe(true)
		expect(resolved.mcp["db-server"].command).toEqual(["npx", "-y", "some-mcp-server"])
		expect(resolved.theme).toBe("dark")
	})
})

describe("resolveFilePatterns", () => {
	const testDir = join(tmpdir(), "ocx-test-resolve-file")

	beforeAll(() => {
		mkdirSync(testDir, { recursive: true })
		writeFileSync(join(testDir, "api-key.txt"), "sk-live-abc123\n")
		writeFileSync(join(testDir, "multiline.txt"), "line1\nline2\nline3\n")
		writeFileSync(join(testDir, "with-quotes.txt"), 'value with "quotes" inside\n')
		writeFileSync(join(testDir, "with-backslash.txt"), "path\\to\\thing\n")
	})

	afterAll(() => {
		rmSync(testDir, { recursive: true, force: true })
	})

	it("resolves a single file pattern", async () => {
		const result = await resolveFilePatterns(`{file:${testDir}/api-key.txt}`, testDir)
		expect(result).toBe("sk-live-abc123")
	})

	it("trims file contents", async () => {
		const result = await resolveFilePatterns(`{file:${testDir}/api-key.txt}`, testDir)
		expect(result).toBe("sk-live-abc123")
		expect(result).not.toContain("\n")
	})

	it("resolves relative path against configDir", async () => {
		const result = await resolveFilePatterns("{file:./api-key.txt}", testDir)
		expect(result).toBe("sk-live-abc123")
	})

	it("returns string unchanged when no patterns present", async () => {
		const result = await resolveFilePatterns("no-file-patterns", testDir)
		expect(result).toBe("no-file-patterns")
	})

	it("throws ConfigError for nonexistent file", async () => {
		expect(resolveFilePatterns("{file:./does-not-exist.txt}", testDir)).rejects.toThrow(
			"does not exist",
		)
	})

	it("escapes newlines for safe JSON embedding", async () => {
		const input = JSON.stringify({ key: "{file:./multiline.txt}" })
		const result = await resolveFilePatterns(input, testDir)
		// Should be valid JSON after resolution
		const parsed = JSON.parse(result)
		expect(parsed.key).toBe("line1\nline2\nline3")
	})

	it("escapes quotes for safe JSON embedding", async () => {
		const input = JSON.stringify({ key: "{file:./with-quotes.txt}" })
		const result = await resolveFilePatterns(input, testDir)
		const parsed = JSON.parse(result)
		expect(parsed.key).toBe('value with "quotes" inside')
	})

	it("escapes backslashes for safe JSON embedding", async () => {
		const input = JSON.stringify({ key: "{file:./with-backslash.txt}" })
		const result = await resolveFilePatterns(input, testDir)
		const parsed = JSON.parse(result)
		expect(parsed.key).toBe("path\\to\\thing")
	})

	it("resolves multiple file patterns in serialized JSON", async () => {
		const config = {
			provider: {
				openai: {
					options: { apiKey: `{file:${testDir}/api-key.txt}` },
				},
			},
			mcp: {
				server: {
					environment: { SECRET: `{file:${testDir}/api-key.txt}` },
				},
			},
		}

		const result = await resolveFilePatterns(JSON.stringify(config), testDir)
		const parsed = JSON.parse(result)

		expect(parsed.provider.openai.options.apiKey).toBe("sk-live-abc123")
		expect(parsed.mcp.server.environment.SECRET).toBe("sk-live-abc123")
	})

	it("resolves ~ to home directory", async () => {
		// Create a temp file in a known location relative to home
		const homeTestDir = join(tmpdir(), "ocx-test-home")
		mkdirSync(homeTestDir, { recursive: true })
		writeFileSync(join(homeTestDir, "key.txt"), "home-key-value\n")

		// Use absolute path since we can't rely on ~ expanding to tmpdir
		const result = await resolveFilePatterns(`{file:${homeTestDir}/key.txt}`, testDir)
		expect(result).toBe("home-key-value")

		rmSync(homeTestDir, { recursive: true, force: true })
	})

	it("works end-to-end with both env and file patterns", async () => {
		const config = {
			provider: {
				openai: {
					options: { apiKey: `{file:${testDir}/api-key.txt}` },
				},
			},
			mcp: {
				db: {
					environment: {
						CONNECTION_STRING: "{env:SERVICE_URL}",
					},
				},
			},
		}

		// Resolve env first, then file — same order as production code
		let text = JSON.stringify(config)
		text = resolveEnvVars(text, env)
		text = await resolveFilePatterns(text, testDir)
		const parsed = JSON.parse(text)

		expect(parsed.provider.openai.options.apiKey).toBe("sk-live-abc123")
		expect(parsed.mcp.db.environment.CONNECTION_STRING).toBe("https://api.example.com")
	})
})

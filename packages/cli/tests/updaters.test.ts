import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import { updateOpencodeJsonConfig } from "../src/updaters/update-opencode-config"

describe("updateOpencodeJsonConfig", () => {
	let testDir: string
	let opencodeDir: string

	beforeEach(async () => {
		testDir = join(
			import.meta.dir,
			"fixtures",
			`tmp-updater-${Math.random().toString(36).slice(2)}`,
		)
		opencodeDir = join(testDir, ".opencode")
		await mkdir(opencodeDir, { recursive: true })
	})

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true })
	})

	it("should create opencode.jsonc if it does not exist", async () => {
		const result = await updateOpencodeJsonConfig(testDir, {
			mcp: {
				"test-mcp": { type: "remote", url: "https://mcp.test.com", enabled: true },
			},
		})

		expect(result.changed).toBe(true)

		const configPath = join(testDir, ".opencode", "opencode.jsonc")
		const content = await readFile(configPath, "utf-8")
		const config = parseJsonc(content)

		expect(config.mcp["test-mcp"]).toEqual({
			type: "remote",
			url: "https://mcp.test.com",
			enabled: true,
		})
	})

	it("should add MCP servers via opencode.mcp", async () => {
		const result = await updateOpencodeJsonConfig(testDir, {
			mcp: {
				"global-mcp": { type: "remote", url: "https://mcp.global.com", enabled: true },
			},
		})

		expect(result.changed).toBe(true)

		const configPath = join(testDir, ".opencode", "opencode.jsonc")
		const config = parseJsonc(await readFile(configPath, "utf-8"))

		expect(config.mcp["global-mcp"]).toBeDefined()
	})

	it("should deep merge opencode config", async () => {
		const result = await updateOpencodeJsonConfig(testDir, {
			mcp: {
				context7: { type: "remote", url: "https://mcp.context7.com", enabled: true },
				gh_grep: { type: "remote", url: "https://mcp.grep.app", enabled: true },
			},
			tools: {
				"context7_*": false,
				"gh_grep_*": false,
			},
			agent: {
				researcher: {
					tools: {
						"context7_*": true,
						"gh_grep_*": true,
					},
				},
			},
		})

		expect(result.changed).toBe(true)

		const configPath = join(testDir, ".opencode", "opencode.jsonc")
		const config = parseJsonc(await readFile(configPath, "utf-8"))

		// MCPs should be added
		expect(config.mcp.context7).toBeDefined()
		expect(config.mcp.gh_grep).toBeDefined()

		// Tools should be set
		expect(config.tools["context7_*"]).toBe(false)
		expect(config.tools["gh_grep_*"]).toBe(false)

		// Agent tools should be set
		expect(config.agent.researcher.tools["context7_*"]).toBe(true)
		expect(config.agent.researcher.tools["gh_grep_*"]).toBe(true)
	})

	it("should preserve existing config (deep merge)", async () => {
		// Create existing config in .opencode
		const existingConfig = {
			$schema: "https://opencode.ai/config.json",
			theme: "catppuccin",
			model: "anthropic/claude-sonnet-4-5",
			mcp: {
				"existing-mcp": { type: "remote", url: "https://existing.com" },
			},
			tools: {
				bash: false,
			},
			agent: {
				"my-agent": {
					description: "My custom agent",
				},
			},
		}
		await writeFile(join(opencodeDir, "opencode.json"), JSON.stringify(existingConfig, null, 2))

		await updateOpencodeJsonConfig(testDir, {
			mcp: {
				"new-mcp": { type: "remote", url: "https://new-mcp.com", enabled: true },
			},
			tools: {
				webfetch: false,
			},
			agent: {
				"new-agent": {
					tools: { "new-mcp_*": true },
				},
			},
		})

		const configPath = join(opencodeDir, "opencode.json")
		const config = parseJsonc(await readFile(configPath, "utf-8"))

		// Existing config preserved
		expect(config.theme).toBe("catppuccin")
		expect(config.model).toBe("anthropic/claude-sonnet-4-5")
		expect(config.mcp["existing-mcp"]).toBeDefined()
		expect(config.tools.bash).toBe(false)
		expect(config.agent["my-agent"].description).toBe("My custom agent")

		// New config added
		expect(config.mcp["new-mcp"]).toBeDefined()
		expect(config.tools.webfetch).toBe(false)
		expect(config.agent["new-agent"].tools["new-mcp_*"]).toBe(true)
	})

	it("should overwrite existing values (component wins)", async () => {
		// Create existing config with MCP already defined in .opencode
		const existingConfig = {
			mcp: {
				context7: { type: "remote", url: "https://old-url.com" },
			},
		}
		await writeFile(join(opencodeDir, "opencode.json"), JSON.stringify(existingConfig, null, 2))

		await updateOpencodeJsonConfig(testDir, {
			mcp: {
				context7: { type: "remote", url: "https://new-url.com", enabled: true },
			},
		})

		// New URL should overwrite (ShadCN-style: component wins)
		const config = parseJsonc(await readFile(join(opencodeDir, "opencode.json"), "utf-8"))
		expect(config.mcp.context7.url).toBe("https://new-url.com")
	})

	it("should preserve JSONC comments", async () => {
		// Create existing config with comments in .opencode
		const existingContent = `{
  // This is my OpenCode config
  "$schema": "https://opencode.ai/config.json",
  "theme": "opencode", // My favorite theme
  "mcp": {
    // Existing MCP servers
  }
}`
		await writeFile(join(opencodeDir, "opencode.json"), existingContent)

		await updateOpencodeJsonConfig(testDir, {
			mcp: {
				"new-mcp": { type: "remote", url: "https://new.com", enabled: true },
			},
		})

		const content = await readFile(join(opencodeDir, "opencode.json"), "utf-8")

		// Comments should be preserved
		expect(content).toContain("// This is my OpenCode config")
		expect(content).toContain("// My favorite theme")
		expect(content).toContain("// Existing MCP servers")

		// New MCP should be added
		const config = parseJsonc(content)
		expect(config.mcp["new-mcp"]).toBeDefined()
	})

	it("should handle opencode.jsonc extension", async () => {
		// Create config with .jsonc extension in .opencode
		const existingConfig = { theme: "opencode" }
		await writeFile(join(opencodeDir, "opencode.jsonc"), JSON.stringify(existingConfig, null, 2))

		await updateOpencodeJsonConfig(testDir, {
			mcp: {
				"test-mcp": { type: "remote", url: "https://test.com", enabled: true },
			},
		})

		// Should update the .jsonc file
		const config = parseJsonc(await readFile(join(opencodeDir, "opencode.jsonc"), "utf-8"))
		expect(config.theme).toBe("opencode")
		expect(config.mcp["test-mcp"]).toBeDefined()
	})

	it("should configure tools", async () => {
		await updateOpencodeJsonConfig(testDir, {
			tools: { webfetch: false, "some-tool": true },
		})

		const config = parseJsonc(await readFile(join(testDir, ".opencode", "opencode.jsonc"), "utf-8"))
		expect(config.tools.webfetch).toBe(false)
		expect(config.tools["some-tool"]).toBe(true)
	})

	it("should write local MCP with environment variables", async () => {
		await updateOpencodeJsonConfig(testDir, {
			mcp: {
				"local-mcp": {
					type: "local",
					command: ["uvx", "some-mcp"],
					environment: { API_KEY: "{env:API_KEY}" },
					enabled: false,
				},
			},
		})

		const config = parseJsonc(await readFile(join(testDir, ".opencode", "opencode.jsonc"), "utf-8"))
		expect(config.mcp["local-mcp"].type).toBe("local")
		expect(config.mcp["local-mcp"].command).toEqual(["uvx", "some-mcp"])
		expect(config.mcp["local-mcp"].environment).toEqual({ API_KEY: "{env:API_KEY}" })
		expect(config.mcp["local-mcp"].enabled).toBe(false)
	})

	it("should write all optional MCP fields", async () => {
		await updateOpencodeJsonConfig(testDir, {
			mcp: {
				"full-mcp": {
					type: "remote",
					url: "https://mcp.example.com",
					headers: { "X-Custom": "value" },
					oauth: true,
					enabled: true,
				},
			},
		})

		const config = parseJsonc(await readFile(join(testDir, ".opencode", "opencode.jsonc"), "utf-8"))
		expect(config.mcp["full-mcp"].headers).toEqual({ "X-Custom": "value" })
		expect(config.mcp["full-mcp"].oauth).toBe(true)
	})

	it("should configure permissions with pattern record", async () => {
		await updateOpencodeJsonConfig(testDir, {
			permission: {
				bash: { "*": "deny", "git *": "allow" },
			},
		})

		const config = parseJsonc(await readFile(join(testDir, ".opencode", "opencode.jsonc"), "utf-8"))
		expect(config.permission.bash["*"]).toBe("deny")
		expect(config.permission.bash["git *"]).toBe("allow")
	})

	it("should add plugins", async () => {
		await updateOpencodeJsonConfig(testDir, {
			plugin: ["@some/plugin@1.0.0", ["@another/plugin", { nested: { enabled: true } }]],
		})

		const config = parseJsonc(await readFile(join(testDir, ".opencode", "opencode.jsonc"), "utf-8"))
		expect(config.plugin).toContain("@some/plugin@1.0.0")
		expect(config.plugin).toContainEqual(["@another/plugin", { nested: { enabled: true } }])
	})

	it("should add instructions", async () => {
		await updateOpencodeJsonConfig(testDir, {
			instructions: [".opencode/instructions.md", ".opencode/**/*.md"],
		})

		const config = parseJsonc(await readFile(join(testDir, ".opencode", "opencode.jsonc"), "utf-8"))
		expect(config.instructions).toContain(".opencode/instructions.md")
		expect(config.instructions).toContain(".opencode/**/*.md")
	})

	it("should configure agent settings", async () => {
		await updateOpencodeJsonConfig(testDir, {
			agent: {
				researcher: {
					temperature: 0.7,
					prompt: "You are a knowledge architect",
					tools: {
						bash: true,
						edit: false,
					},
				},
			},
		})

		const config = parseJsonc(await readFile(join(testDir, ".opencode", "opencode.jsonc"), "utf-8"))
		expect(config.agent.researcher.temperature).toBe(0.7)
		expect(config.agent.researcher.prompt).toBe("You are a knowledge architect")
		expect(config.agent.researcher.tools.bash).toBe(true)
		expect(config.agent.researcher.tools.edit).toBe(false)
	})

	it("should configure permissions", async () => {
		await updateOpencodeJsonConfig(testDir, {
			permission: {
				bash: "allow",
				edit: { "*.md": "allow", "*.ts": "ask" },
				mcp: { "dangerous-mcp": "deny" },
			},
		})

		const config = parseJsonc(await readFile(join(testDir, ".opencode", "opencode.jsonc"), "utf-8"))
		expect(config.permission.bash).toBe("allow")
		expect(config.permission.edit["*.md"]).toBe("allow")
		expect(config.permission.edit["*.ts"]).toBe("ask")
		expect(config.permission.mcp["dangerous-mcp"]).toBe("deny")
	})

	it("should return changed=false when no opencode config provided", async () => {
		const result = await updateOpencodeJsonConfig(testDir, {})

		expect(result.changed).toBe(false)
	})
})

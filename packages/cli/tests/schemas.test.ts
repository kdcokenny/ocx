/**
 * Tests for the schemas module
 * Tests regex validation patterns, normalization logic, and parseQualifiedComponent
 */

import { describe, expect, it } from "bun:test"
import {
	agentConfigSchema,
	createQualifiedComponent,
	dependencyRefSchema,
	inferTargetPath,
	namespaceSchema,
	normalizeFile,
	normalizeMcpServer,
	openCodeNameSchema,
	parseQualifiedComponent,
	permissionConfigSchema,
	qualifiedComponentSchema,
	targetPathSchema,
} from "../src/schemas/registry"

describe("schemas", () => {
	describe("openCodeNameSchema", () => {
		it("should accept valid lowercase names", () => {
			expect(() => openCodeNameSchema.parse("researcher")).not.toThrow()
			expect(() => openCodeNameSchema.parse("my-component")).not.toThrow()
			expect(() => openCodeNameSchema.parse("a")).not.toThrow()
			expect(() => openCodeNameSchema.parse("a1")).not.toThrow()
			expect(() => openCodeNameSchema.parse("test123")).not.toThrow()
		})

		it("should accept hyphenated names", () => {
			expect(() => openCodeNameSchema.parse("my-component")).not.toThrow()
			expect(() => openCodeNameSchema.parse("a-b-c")).not.toThrow()
			expect(() => openCodeNameSchema.parse("one-two-three")).not.toThrow()
		})

		it("should reject empty string", () => {
			expect(() => openCodeNameSchema.parse("")).toThrow("Name cannot be empty")
		})

		it("should reject names exceeding 64 characters", () => {
			const longName = "a".repeat(65)
			expect(() => openCodeNameSchema.parse(longName)).toThrow("cannot exceed 64 characters")
		})

		it("should reject uppercase letters", () => {
			expect(() => openCodeNameSchema.parse("MyComponent")).toThrow()
			expect(() => openCodeNameSchema.parse("UPPERCASE")).toThrow()
		})

		it("should reject names starting with hyphen", () => {
			expect(() => openCodeNameSchema.parse("-invalid")).toThrow()
		})

		it("should reject names ending with hyphen", () => {
			expect(() => openCodeNameSchema.parse("invalid-")).toThrow()
		})

		it("should reject consecutive hyphens", () => {
			expect(() => openCodeNameSchema.parse("my--component")).toThrow()
		})

		it("should reject special characters", () => {
			expect(() => openCodeNameSchema.parse("my_component")).toThrow()
			expect(() => openCodeNameSchema.parse("my.component")).toThrow()
			expect(() => openCodeNameSchema.parse("my@component")).toThrow()
			expect(() => openCodeNameSchema.parse("my component")).toThrow()
		})

		it("should accept names exactly at 64 characters", () => {
			const maxName = "a".repeat(64)
			expect(() => openCodeNameSchema.parse(maxName)).not.toThrow()
		})
	})

	describe("namespaceSchema", () => {
		it("should follow same rules as openCodeNameSchema", () => {
			expect(() => namespaceSchema.parse("kdco")).not.toThrow()
			expect(() => namespaceSchema.parse("my-namespace")).not.toThrow()
			expect(() => namespaceSchema.parse("-invalid")).toThrow()
		})
	})

	describe("qualifiedComponentSchema", () => {
		it("should accept valid namespace/component format", () => {
			expect(() => qualifiedComponentSchema.parse("kdco/researcher")).not.toThrow()
			expect(() => qualifiedComponentSchema.parse("my-ns/my-comp")).not.toThrow()
		})

		it("should reject bare component names", () => {
			expect(() => qualifiedComponentSchema.parse("researcher")).toThrow()
		})

		it("should reject invalid namespace part", () => {
			expect(() => qualifiedComponentSchema.parse("Invalid/component")).toThrow()
			expect(() => qualifiedComponentSchema.parse("-ns/component")).toThrow()
		})

		it("should reject invalid component part", () => {
			expect(() => qualifiedComponentSchema.parse("namespace/Invalid")).toThrow()
			expect(() => qualifiedComponentSchema.parse("namespace/-comp")).toThrow()
		})

		it("should reject empty parts", () => {
			expect(() => qualifiedComponentSchema.parse("/component")).toThrow()
			expect(() => qualifiedComponentSchema.parse("namespace/")).toThrow()
			expect(() => qualifiedComponentSchema.parse("/")).toThrow()
		})
	})

	describe("dependencyRefSchema", () => {
		it("should accept bare component names", () => {
			expect(() => dependencyRefSchema.parse("utils")).not.toThrow()
			expect(() => dependencyRefSchema.parse("my-util")).not.toThrow()
		})

		it("should accept qualified references", () => {
			expect(() => dependencyRefSchema.parse("acme/utils")).not.toThrow()
			expect(() => dependencyRefSchema.parse("my-ns/my-comp")).not.toThrow()
		})

		it("should reject invalid formats", () => {
			expect(() => dependencyRefSchema.parse("Invalid")).toThrow()
			expect(() => dependencyRefSchema.parse("acme/Invalid")).toThrow()
			expect(() => dependencyRefSchema.parse("-invalid")).toThrow()
		})
	})

	describe("targetPathSchema", () => {
		it("should accept valid .opencode paths", () => {
			expect(() => targetPathSchema.parse(".opencode/agent/test.md")).not.toThrow()
			expect(() => targetPathSchema.parse(".opencode/plugin/my-plugin.ts")).not.toThrow()
			expect(() => targetPathSchema.parse(".opencode/skills/test/SKILL.md")).not.toThrow()
		})

		it("should accept all valid directories", () => {
			const validDirs = ["agent", "skills", "plugin", "command", "tool", "philosophy"]
			for (const dir of validDirs) {
				expect(() => targetPathSchema.parse(`.opencode/${dir}/file.md`)).not.toThrow()
			}
		})

		it("should reject paths not starting with .opencode/", () => {
			expect(() => targetPathSchema.parse("opencode/agent/test.md")).toThrow()
			expect(() => targetPathSchema.parse("src/file.ts")).toThrow()
		})

		it("should reject invalid directory names", () => {
			expect(() => targetPathSchema.parse(".opencode/invalid/file.md")).toThrow("valid directory")
			expect(() => targetPathSchema.parse(".opencode/src/file.md")).toThrow()
		})
	})

	describe("parseQualifiedComponent", () => {
		it("should parse valid qualified reference", () => {
			const result = parseQualifiedComponent("kdco/researcher")
			expect(result).toEqual({ namespace: "kdco", component: "researcher" })
		})

		it("should parse hyphenated names", () => {
			const result = parseQualifiedComponent("my-namespace/my-component")
			expect(result).toEqual({ namespace: "my-namespace", component: "my-component" })
		})

		it("should throw for bare component name", () => {
			expect(() => parseQualifiedComponent("researcher")).toThrow(
				'Invalid component reference: "researcher"',
			)
		})

		it("should throw for empty namespace", () => {
			expect(() => parseQualifiedComponent("/component")).toThrow(
				"Both namespace and component are required",
			)
		})

		it("should throw for empty component", () => {
			expect(() => parseQualifiedComponent("namespace/")).toThrow(
				"Both namespace and component are required",
			)
		})

		it("should throw for just a slash", () => {
			expect(() => parseQualifiedComponent("/")).toThrow(
				"Both namespace and component are required",
			)
		})
	})

	describe("createQualifiedComponent", () => {
		it("should create qualified reference from parts", () => {
			expect(createQualifiedComponent("kdco", "researcher")).toBe("kdco/researcher")
		})

		it("should handle hyphenated names", () => {
			expect(createQualifiedComponent("my-ns", "my-comp")).toBe("my-ns/my-comp")
		})
	})

	describe("inferTargetPath", () => {
		it("should prepend .opencode/ to path", () => {
			expect(inferTargetPath("plugin/foo.ts")).toBe(".opencode/plugin/foo.ts")
		})

		it("should handle nested paths", () => {
			expect(inferTargetPath("skills/test/SKILL.md")).toBe(".opencode/skills/test/SKILL.md")
		})

		it("should handle single file", () => {
			expect(inferTargetPath("agent/test.md")).toBe(".opencode/agent/test.md")
		})
	})

	describe("normalizeFile", () => {
		it("should convert string path to object", () => {
			const result = normalizeFile("plugin/foo.ts")
			expect(result).toEqual({
				path: "plugin/foo.ts",
				target: ".opencode/plugin/foo.ts",
			})
		})

		it("should pass through object unchanged", () => {
			const input = { path: "src/custom.ts", target: ".opencode/plugin/custom.ts" }
			const result = normalizeFile(input)
			expect(result).toEqual(input)
		})

		it("should handle skill directory paths", () => {
			const result = normalizeFile("skills/my-skill/SKILL.md")
			expect(result).toEqual({
				path: "skills/my-skill/SKILL.md",
				target: ".opencode/skills/my-skill/SKILL.md",
			})
		})
	})

	describe("normalizeMcpServer", () => {
		it("should convert URL string to remote server object", () => {
			const result = normalizeMcpServer("https://mcp.example.com")
			expect(result).toEqual({
				type: "remote",
				url: "https://mcp.example.com",
				enabled: true,
			})
		})

		it("should pass through full object unchanged", () => {
			const input = {
				type: "remote" as const,
				url: "https://mcp.example.com",
				enabled: false,
				headers: { Authorization: "Bearer token" },
			}
			const result = normalizeMcpServer(input)
			expect(result).toEqual(input)
		})

		it("should pass through local server object", () => {
			const input = {
				type: "local" as const,
				command: ["npx", "mcp-server"],
				enabled: true,
			}
			const result = normalizeMcpServer(input)
			expect(result).toEqual(input)
		})

		it("should handle local server with string command", () => {
			const input = {
				type: "local" as const,
				command: "npx some-mcp-server --port 3000",
				enabled: true,
			}
			const result = normalizeMcpServer(input)
			expect(result).toEqual(input)
			expect(result.command).toBe("npx some-mcp-server --port 3000")
		})
	})

	describe("agentConfigSchema", () => {
		it("should accept valid agent config with all fields", () => {
			const config = {
				model: "anthropic/claude-sonnet-4-5",
				description: "A custom agent",
				steps: 100,
				mode: "subagent" as const,
				tools: { bash: true, edit: false },
				temperature: 0.7,
				top_p: 0.9,
				prompt: "You are helpful",
				color: "#ff0000",
				disable: false,
			}
			expect(() => agentConfigSchema.parse(config)).not.toThrow()
		})

		it("should accept agent with permission matrix", () => {
			const config = {
				description: "Read-only agent",
				permission: {
					bash: { "*": "deny" as const },
					edit: "deny" as const,
				},
			}
			const result = agentConfigSchema.parse(config)
			expect(result.permission?.bash).toEqual({ "*": "deny" })
			expect(result.permission?.edit).toBe("deny")
		})

		it("should reject invalid mode values", () => {
			const config = { mode: "invalid" }
			expect(() => agentConfigSchema.parse(config)).toThrow()
		})

		it("should accept any temperature value (provider-specific limits)", () => {
			// Temperature has no bounds - providers have varying limits
			expect(() => agentConfigSchema.parse({ temperature: -1 })).not.toThrow()
			expect(() => agentConfigSchema.parse({ temperature: 0 })).not.toThrow()
			expect(() => agentConfigSchema.parse({ temperature: 2 })).not.toThrow()
			expect(() => agentConfigSchema.parse({ temperature: 5 })).not.toThrow()
		})

		it("should accept deprecated maxSteps field", () => {
			const config = { maxSteps: 50 }
			expect(() => agentConfigSchema.parse(config)).not.toThrow()
		})

		it("should require steps to be positive integer", () => {
			// Valid: positive integers
			expect(() => agentConfigSchema.parse({ steps: 1 })).not.toThrow()
			expect(() => agentConfigSchema.parse({ steps: 100 })).not.toThrow()
			// Invalid: zero, negative, decimals
			expect(() => agentConfigSchema.parse({ steps: 0 })).toThrow()
			expect(() => agentConfigSchema.parse({ steps: -1 })).toThrow()
			expect(() => agentConfigSchema.parse({ steps: 1.5 })).toThrow()
		})

		it("should require maxSteps to be positive integer", () => {
			// Valid: positive integers
			expect(() => agentConfigSchema.parse({ maxSteps: 1 })).not.toThrow()
			// Invalid: zero, negative, decimals
			expect(() => agentConfigSchema.parse({ maxSteps: 0 })).toThrow()
			expect(() => agentConfigSchema.parse({ maxSteps: -5 })).toThrow()
			expect(() => agentConfigSchema.parse({ maxSteps: 2.5 })).toThrow()
		})
	})

	describe("permissionConfigSchema", () => {
		it("should accept simple permission values", () => {
			const config = {
				bash: "allow" as const,
				edit: "deny" as const,
			}
			expect(() => permissionConfigSchema.parse(config)).not.toThrow()
		})

		it("should accept permission pattern records", () => {
			const config = {
				bash: { "*": "deny" as const, "git *": "allow" as const },
				edit: { "*.md": "allow" as const, "*.ts": "ask" as const },
			}
			const result = permissionConfigSchema.parse(config)
			expect(result.bash).toEqual({ "*": "deny", "git *": "allow" })
			expect(result.edit).toEqual({ "*.md": "allow", "*.ts": "ask" })
		})

		it("should accept MCP permissions", () => {
			const config = {
				mcp: { "dangerous-mcp": "deny" as const, "safe-mcp": "allow" as const },
			}
			expect(() => permissionConfigSchema.parse(config)).not.toThrow()
		})

		it("should reject invalid permission values", () => {
			const config = { bash: "invalid" }
			expect(() => permissionConfigSchema.parse(config)).toThrow()
		})

		it("should accept mixed simple and pattern permissions", () => {
			const config = {
				bash: "allow" as const,
				edit: { "*.config.*": "deny" as const },
			}
			const result = permissionConfigSchema.parse(config)
			expect(result.bash).toBe("allow")
			expect(result.edit).toEqual({ "*.config.*": "deny" })
		})
	})
})

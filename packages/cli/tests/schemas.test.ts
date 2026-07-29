/**
 * Tests for the schemas module
 * Tests regex validation patterns, normalization logic, and parseQualifiedComponent
 */

import { describe, expect, it } from "bun:test"
import { parseCanonicalId } from "../src/schemas/config"
import { OPENCODE_CONFIG_FIELD_KINDS } from "../src/schemas/opencode-config-fields.generated"
import {
	agentConfigSchema,
	aliasSchema,
	componentManifestSchema,
	createQualifiedComponent,
	dependencyRefSchema,
	inferTargetPath,
	namespaceSchema,
	normalizeFile,
	normalizeMcpServer,
	oauthConfigSchema,
	openCodeNameSchema,
	opencodeConfigSchema,
	parseQualifiedComponent,
	permissionConfigSchema,
	qualifiedComponentSchema,
	registrySchema,
	targetPathSchema,
	validateFileTarget,
} from "../src/schemas/registry"
import { ValidationError } from "../src/utils/errors"

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

	describe("aliasSchema", () => {
		it("should validate registry alias tokens", () => {
			expect(() => aliasSchema.parse("kdco")).not.toThrow()
			expect(() => aliasSchema.parse("my-namespace")).not.toThrow()
			expect(() => aliasSchema.parse("-invalid")).toThrow()
		})
	})

	describe("namespaceSchema (deprecated compat)", () => {
		it("should still work as backward-compatible alias", () => {
			expect(() => namespaceSchema.parse("kdco")).not.toThrow()
			expect(() => namespaceSchema.parse("my-namespace")).not.toThrow()
			expect(() => namespaceSchema.parse("-invalid")).toThrow()
		})
	})

	describe("qualifiedComponentSchema", () => {
		it("should accept valid alias/component format", () => {
			expect(() => qualifiedComponentSchema.parse("kdco/researcher")).not.toThrow()
			expect(() => qualifiedComponentSchema.parse("my-ns/my-comp")).not.toThrow()
		})

		it("should reject bare component names", () => {
			expect(() => qualifiedComponentSchema.parse("researcher")).toThrow()
		})

		it("should reject invalid alias part", () => {
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
		it("should accept standard OpenCode directory paths", () => {
			expect(() => targetPathSchema.parse("agents/test.md")).not.toThrow()
			expect(() => targetPathSchema.parse("plugins/my-plugin.ts")).not.toThrow()
			expect(() => targetPathSchema.parse("skills/test/SKILL.md")).not.toThrow()
			expect(() => targetPathSchema.parse("commands/foo.ts")).not.toThrow()
			expect(() => targetPathSchema.parse("tools/bar.ts")).not.toThrow()
		})

		it("should accept custom directory paths", () => {
			// Blocklist approach - custom paths are now allowed
			expect(() => targetPathSchema.parse("prompts/my-prompt.md")).not.toThrow()
			expect(() => targetPathSchema.parse("templates/foo.ts")).not.toThrow()
			expect(() => targetPathSchema.parse("src/custom.ts")).not.toThrow()
			expect(() => targetPathSchema.parse("docs/README.md")).not.toThrow()
		})

		it("should reject blocked paths in .ocx/", () => {
			expect(() => targetPathSchema.parse(".ocx/receipt.jsonc")).toThrow("protected")
			expect(() => targetPathSchema.parse(".ocx/state.json")).toThrow("protected")
			expect(() => targetPathSchema.parse(".ocx/anything")).toThrow("protected")
		})

		it("should reject ocx.jsonc", () => {
			expect(() => targetPathSchema.parse("ocx.jsonc")).toThrow("protected")
		})

		it("should reject package.json", () => {
			expect(() => targetPathSchema.parse("package.json")).toThrow("protected")
		})

		it("should reject .git/ paths", () => {
			expect(() => targetPathSchema.parse(".git/config")).toThrow("protected")
			expect(() => targetPathSchema.parse(".git/HEAD")).toThrow("protected")
		})

		it("should reject .env", () => {
			expect(() => targetPathSchema.parse(".env")).toThrow("protected")
		})

		it("should reject node_modules/ paths", () => {
			expect(() => targetPathSchema.parse("node_modules/foo")).toThrow("protected")
			expect(() => targetPathSchema.parse("node_modules/package/index.js")).toThrow("protected")
		})

		it("should reject unsafe path patterns", () => {
			// Schema-level checks: absolute paths and null bytes
			expect(() => targetPathSchema.parse("/etc/passwd")).toThrow()
			expect(() => targetPathSchema.parse("C:/Windows/System32")).toThrow()
			expect(() => targetPathSchema.parse("foo\0bar")).toThrow()

			// Traversal detection is deferred to validateFileTarget()
			// Schema allows ".." in filenames (e.g., component..v2.ts)
			expect(targetPathSchema.parse("../etc/passwd")).toBe("../etc/passwd")
			expect(targetPathSchema.parse("foo/../bar")).toBe("foo/../bar")
			expect(targetPathSchema.parse("component..v2.ts")).toBe("component..v2.ts")
		})

		it("should detect path traversal in validateFileTarget", () => {
			// validateFileTarget() uses validatePath() for proper traversal detection
			expect(() => validateFileTarget("../etc/passwd")).toThrow(ValidationError)
			expect(() => validateFileTarget("foo/../../../etc/passwd")).toThrow(ValidationError)

			// Safe paths that normalize within bounds are allowed
			expect(() => validateFileTarget("foo/../bar")).not.toThrow()
			expect(() => validateFileTarget("component..v2.ts")).not.toThrow()
		})

		it("should reject normalized paths that bypass protected prefixes", () => {
			// RED case: normalized paths that land in blocked prefixes
			// These should be rejected even though schema-level checks pass
			expect(() => validateFileTarget("foo/../.git/config")).toThrow(ValidationError)
			expect(() => validateFileTarget("x/../.ocx/receipt.jsonc")).toThrow(ValidationError)
			expect(() => validateFileTarget("x/../node_modules/pkg/index.js")).toThrow(ValidationError)
			expect(() => validateFileTarget("bar/../package.json")).toThrow(ValidationError)

			// GREEN case: safe normalization should still work
			expect(() => validateFileTarget("foo/../bar")).not.toThrow()
			expect(() => validateFileTarget("component..v2.ts")).not.toThrow()
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

		it("should throw for empty alias", () => {
			expect(() => parseQualifiedComponent("/component")).toThrow(
				"Both alias and component are required",
			)
		})

		it("should throw for empty component", () => {
			expect(() => parseQualifiedComponent("namespace/")).toThrow(
				"Both alias and component are required",
			)
		})

		it("should throw for just a slash", () => {
			expect(() => parseQualifiedComponent("/")).toThrow("Both alias and component are required")
		})

		it("should throw for multiple slash separators", () => {
			expect(() => parseQualifiedComponent("a/b/c")).toThrow('Too many "/" separators')
			expect(() => parseQualifiedComponent("ns/comp/extra")).toThrow('Too many "/" separators')
			expect(() => parseQualifiedComponent("a/b/c/d")).toThrow('Too many "/" separators')
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
		it("should return path as-is (root-relative)", () => {
			expect(inferTargetPath("plugins/foo.ts")).toBe("plugins/foo.ts")
		})

		it("should handle nested paths", () => {
			expect(inferTargetPath("skills/test/SKILL.md")).toBe("skills/test/SKILL.md")
		})

		it("should handle single file", () => {
			expect(inferTargetPath("agents/test.md")).toBe("agents/test.md")
		})
	})

	describe("normalizeFile", () => {
		it("should convert string path to object", () => {
			const result = normalizeFile("plugins/foo.ts")
			expect(result).toEqual({
				path: "plugins/foo.ts",
				target: "plugins/foo.ts",
			})
		})

		it("should pass through object with target validation", () => {
			const input = { path: "src/custom.ts", target: "plugins/custom.ts" }
			const result = normalizeFile(input)
			expect(result).toEqual(input)
		})

		it("should handle skill directory paths", () => {
			const result = normalizeFile("skills/my-skill/SKILL.md")
			expect(result).toEqual({
				path: "skills/my-skill/SKILL.md",
				target: "skills/my-skill/SKILL.md",
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

	describe("oauthConfigSchema", () => {
		it("rejects legacy v1 fields in current manifests", () => {
			const result = oauthConfigSchema.safeParse({
				scopes: ["files:read"],
				authUrl: "https://auth.example.com",
				tokenUrl: "https://token.example.com",
			})

			expect(result.success).toBe(false)
			if (!result.success) {
				expect(result.error.issues[0]?.code).toBe("unrecognized_keys")
				expect(result.error.issues[0]?.message).toContain("scopes")
			}
		})

		it("rejects unknown fields instead of silently stripping them", () => {
			const result = oauthConfigSchema.safeParse({ unexpected: true })

			expect(result.success).toBe(false)
			if (!result.success) {
				expect(result.error.issues[0]?.code).toBe("unrecognized_keys")
				expect(result.error.issues[0]?.message).toContain("unexpected")
			}
		})

		it("enforces the callback port range from OpenCode's schema", () => {
			expect(oauthConfigSchema.safeParse({ callbackPort: 1 }).success).toBe(true)
			expect(oauthConfigSchema.safeParse({ callbackPort: 65535 }).success).toBe(true)
			expect(oauthConfigSchema.safeParse({ callbackPort: 0 }).success).toBe(false)
			expect(oauthConfigSchema.safeParse({ callbackPort: 65536 }).success).toBe(false)
			expect(oauthConfigSchema.safeParse({ callbackPort: 1.5 }).success).toBe(false)
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

	describe("registrySchema", () => {
		const validRegistry = {
			name: "Test Registry",
			version: "1.0.0",
			author: "Test Author",
			components: [],
		}

		it("should accept a valid registry with all required fields", () => {
			expect(() => registrySchema.parse(validRegistry)).not.toThrow()
		})

		it("should require name (intentional — registries must be identifiable)", () => {
			const { name: _, ...registryWithoutName } = validRegistry
			const result = registrySchema.safeParse(registryWithoutName)
			expect(result.success).toBe(false)
			if (!result.success) {
				const paths = result.error.issues.map((i) => i.path.join("."))
				expect(paths).toContain("name")
			}
		})

		it("should require version (intentional — enables deterministic resolution)", () => {
			const { version: _, ...registryWithoutVersion } = validRegistry
			const result = registrySchema.safeParse(registryWithoutVersion)
			expect(result.success).toBe(false)
			if (!result.success) {
				const paths = result.error.issues.map((i) => i.path.join("."))
				expect(paths).toContain("version")
			}
		})

		it("should require author", () => {
			const { author: _, ...registryWithoutAuthor } = validRegistry
			const result = registrySchema.safeParse(registryWithoutAuthor)
			expect(result.success).toBe(false)
			if (!result.success) {
				const paths = result.error.issues.map((i) => i.path.join("."))
				expect(paths).toContain("author")
			}
		})

		it("should reject empty name string", () => {
			const result = registrySchema.safeParse({ ...validRegistry, name: "" })
			expect(result.success).toBe(false)
		})

		it("should reject invalid semver version", () => {
			const result = registrySchema.safeParse({ ...validRegistry, version: "not-semver" })
			expect(result.success).toBe(false)
		})

		it("should accept optional fields like opencode and ocx versions", () => {
			const registry = {
				...validRegistry,
				opencode: "1.0.0",
				ocx: "2.0.0",
			}
			expect(() => registrySchema.parse(registry)).not.toThrow()
		})

		it("should not require namespace field", () => {
			// namespace was removed; ensure it doesn't cause validation failure as extra key
			// registrySchema uses .object() which strips unknown keys by default
			const registryWithNamespace = { ...validRegistry, namespace: "kdco" }
			expect(() => registrySchema.parse(registryWithNamespace)).not.toThrow()
		})
	})

	describe("parseCanonicalId", () => {
		it("should parse valid canonical ID", () => {
			const id = "https://registry.example.com::kdco/component@1.0.0"
			const result = parseCanonicalId(id)
			expect(result.registryUrl).toBe("https://registry.example.com")
			expect(result.registryName).toBe("kdco")
			expect(result.name).toBe("component")
			expect(result.revision).toBe("1.0.0")
		})

		it("should parse canonical ID with @ in revision", () => {
			const id = "https://registry.example.com::kdco/component@user@branch"
			const result = parseCanonicalId(id)
			expect(result.registryUrl).toBe("https://registry.example.com")
			expect(result.registryName).toBe("kdco")
			expect(result.name).toBe("component")
			expect(result.revision).toBe("user@branch")
		})

		it("should parse canonical ID with multiple @ in revision", () => {
			const id = "https://registry.example.com::kdco/component@feature@user@domain"
			const result = parseCanonicalId(id)
			expect(result.revision).toBe("feature@user@domain")
		})

		it("should throw for missing revision separator", () => {
			const id = "https://registry.example.com::kdco/component"
			expect(() => parseCanonicalId(id)).toThrow("Expected format")
		})

		it("should throw for missing namespace separator", () => {
			const id = "https://registry.example.com::component@1.0.0"
			expect(() => parseCanonicalId(id)).toThrow("qualified")
		})
	})

	describe("opencodeConfigSchema (synced field set)", () => {
		it("accepts and retains a valid opencode field ocx does not model precisely", () => {
			const result = opencodeConfigSchema.safeParse({
				enabled_providers: ["acme"],
				disabled_providers: ["legacy"],
				plugin: ["./p.ts"],
			})
			expect(result.success).toBe(true)
			if (result.success) {
				// passed through unchanged (not stripped)
				expect((result.data as Record<string, unknown>).enabled_providers).toEqual(["acme"])
				expect((result.data as Record<string, unknown>).disabled_providers).toEqual(["legacy"])
			}
		})

		it("retains synced fields through the component manifest boundary", () => {
			const result = componentManifestSchema.safeParse({
				name: "x",
				type: "plugin",
				description: "d",
				files: [],
				dependencies: [],
				opencode: { enabled_providers: ["acme"] },
			})

			expect(result.success).toBe(true)
			if (result.success) {
				expect(
					(result.data.opencode as Record<string, unknown> | undefined)?.enabled_providers,
				).toEqual(["acme"])
			}
		})

		it("still accepts ocx-managed fields, including the mcp string shorthand", () => {
			const result = opencodeConfigSchema.safeParse({
				mcp: { local: "npx some-server" },
				permission: { bash: "ask" },
				plugin: ["a"],
				instructions: ["x.md"],
			})
			expect(result.success).toBe(true)
		})

		it("accepts and retains plugin option tuples", () => {
			const plugin = [
				"./plugins/demo/index.ts",
				{ someConfig: { use: { data: true } }, retries: 2 },
			]
			const result = opencodeConfigSchema.safeParse({
				plugin: ["plain-plugin", plugin],
			})

			expect(result.success).toBe(true)
			if (result.success) {
				expect(result.data.plugin).toEqual(["plain-plugin", plugin])
			}
		})

		it("rejects malformed plugin option tuples", () => {
			expect(opencodeConfigSchema.safeParse({ plugin: [["plugin-only"]] }).success).toBe(false)
			expect(
				opencodeConfigSchema.safeParse({ plugin: [["plugin", { enabled: true }, "extra"]] })
					.success,
			).toBe(false)
			expect(opencodeConfigSchema.safeParse({ plugin: [["plugin", true]] }).success).toBe(false)
		})

		it("retains plugin option tuples through the component manifest boundary", () => {
			const plugin = ["./plugins/demo/index.ts", { enabled: true }]
			const result = componentManifestSchema.safeParse({
				name: "x",
				type: "plugin",
				description: "d",
				files: [],
				dependencies: [],
				opencode: { plugin: [plugin] },
			})

			expect(result.success).toBe(true)
			if (result.success) {
				expect(result.data.opencode?.plugin).toEqual([plugin])
			}
		})

		it("accepts a top-level tui block with plugin entries", () => {
			const result = componentManifestSchema.safeParse({
				name: "my-plugin",
				type: "plugin",
				description: "d",
				files: ["plugins/my-plugin/status.tui.tsx"],
				dependencies: [],
				tui: { plugin: ["./plugins/my-plugin/status.tui.tsx"] },
			})

			expect(result.success).toBe(true)
			if (result.success) {
				expect(result.data.tui?.plugin).toEqual(["./plugins/my-plugin/status.tui.tsx"])
			}
		})

		it("rejects a top-level key that is not in opencode's field set", () => {
			const result = opencodeConfigSchema.safeParse({ bogus_key: 1 })
			expect(result.success).toBe(false)
			if (!result.success) {
				expect(result.error.issues[0]?.message).toContain("bogus_key")
				expect(result.error.issues[0]?.message).toContain("sync-opencode-schema")
			}
		})

		it("rejects stale/renamed keys opencode no longer defines at top level", () => {
			for (const stale of ["theme", "tui", "keybind", "auto_update", "auto_compact"]) {
				expect(opencodeConfigSchema.safeParse({ [stale]: true }).success).toBe(false)
			}
		})

		it("rejection propagates through componentManifestSchema (ocx validate / add)", () => {
			const manifest = {
				name: "x",
				type: "plugin",
				description: "d",
				files: [],
				dependencies: [],
				opencode: { enabled_providers: ["acme"], not_a_real_key: true },
			}
			const result = componentManifestSchema.safeParse(manifest)
			expect(result.success).toBe(false)
		})

		it("the generated field set is current with opencode (has new fields, not stale ones)", () => {
			const fields = Object.keys(OPENCODE_CONFIG_FIELD_KINDS)
			// Fields opencode has that ocx used to drop:
			expect(fields).toContain("enabled_providers")
			expect(fields).toContain("disabled_providers")
			// Core managed fields:
			expect(fields).toContain("plugin")
			expect(fields).toContain("mcp")
			expect(fields).toContain("permission")
			// Stale/renamed ocx-only fields must NOT be present:
			expect(fields).not.toContain("theme")
			expect(fields).not.toContain("tui")
			expect(fields).not.toContain("auto_update")
		})
	})
})

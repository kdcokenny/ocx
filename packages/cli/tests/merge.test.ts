/**
 * Unit tests for OpenCode config merging behavior.
 *
 * These tests verify that mergeOpencodeConfig correctly handles:
 * - MCP server merging (regression test for the undefined overwrite bug)
 * - Plugin array concatenation and canonical-name deduplication
 * - Instructions array concatenation and deduplication
 * - Tools object merging
 * - Non-special array replacement (OpenCode parity)
 */

import { describe, expect, it } from "bun:test"
import {
	dedupePluginsByCanonicalName,
	extractCanonicalPluginName,
	mergeOpencodeConfig,
} from "../src/registry/merge"
import type { NormalizedOpencodeConfig } from "../src/schemas/registry"

// =============================================================================
// extractCanonicalPluginName
// =============================================================================

describe("extractCanonicalPluginName", () => {
	it("returns bare name unchanged", () => {
		expect(extractCanonicalPluginName("chalk")).toBe("chalk")
	})

	it("strips version from unscoped package", () => {
		expect(extractCanonicalPluginName("chalk@5.0.0")).toBe("chalk")
	})

	it("strips version from npm: unscoped", () => {
		expect(extractCanonicalPluginName("npm:chalk@5.0.0")).toBe("npm:chalk")
	})

	it("returns npm: bare name unchanged", () => {
		expect(extractCanonicalPluginName("npm:chalk")).toBe("npm:chalk")
	})

	it("strips version from scoped package", () => {
		expect(extractCanonicalPluginName("@scope/pkg@1.0.0")).toBe("@scope/pkg")
	})

	it("returns scoped package without version unchanged", () => {
		expect(extractCanonicalPluginName("@scope/pkg")).toBe("@scope/pkg")
	})

	it("strips version from npm: scoped package", () => {
		expect(extractCanonicalPluginName("npm:@scope/pkg@1.0.0")).toBe("npm:@scope/pkg")
	})

	it("returns npm: scoped package without version unchanged", () => {
		expect(extractCanonicalPluginName("npm:@scope/pkg")).toBe("npm:@scope/pkg")
	})

	it("handles prerelease version suffix", () => {
		expect(extractCanonicalPluginName("npm:@scope/pkg@1.0.0-beta.1")).toBe("npm:@scope/pkg")
	})

	it("handles malformed scope without slash", () => {
		// Edge case: @scope without /pkg — returned as-is
		expect(extractCanonicalPluginName("@scope")).toBe("@scope")
	})

	it("handles empty string", () => {
		expect(extractCanonicalPluginName("")).toBe("")
	})

	it("handles npm: with empty remainder", () => {
		expect(extractCanonicalPluginName("npm:")).toBe("npm:")
	})

	it("extracts the canonical name from a plugin option tuple", () => {
		expect(extractCanonicalPluginName(["npm:@scope/pkg@2.0.0", { mode: "strict" }])).toBe(
			"npm:@scope/pkg",
		)
	})
})

// =============================================================================
// dedupePluginsByCanonicalName
// =============================================================================

describe("dedupePluginsByCanonicalName", () => {
	it("removes earlier entry when same canonical name appears later", () => {
		const result = dedupePluginsByCanonicalName(["npm:pkg@1.0", "other", "npm:pkg@2.0"])
		// Last "npm:pkg" (version 2.0) wins
		expect(result).toEqual(["other", "npm:pkg@2.0"])
	})

	it("preserves order of non-duplicate entries", () => {
		const result = dedupePluginsByCanonicalName(["npm:a", "npm:b", "npm:c"])
		expect(result).toEqual(["npm:a", "npm:b", "npm:c"])
	})

	it("deduplicates scoped packages by canonical name", () => {
		const result = dedupePluginsByCanonicalName([
			"npm:@scope/foo@1.0",
			"npm:@scope/bar",
			"npm:@scope/foo@2.0",
		])
		expect(result).toEqual(["npm:@scope/bar", "npm:@scope/foo@2.0"])
	})

	it("deduplicates exact string duplicates", () => {
		const result = dedupePluginsByCanonicalName(["npm:a", "npm:b", "npm:a"])
		expect(result).toEqual(["npm:b", "npm:a"])
	})

	it("handles empty array", () => {
		expect(dedupePluginsByCanonicalName([])).toEqual([])
	})

	it("handles single entry", () => {
		expect(dedupePluginsByCanonicalName(["npm:a"])).toEqual(["npm:a"])
	})

	it("higher-priority source wins over lower-priority target for same package", () => {
		// Real-world: profile has pkg@1.0, local overlay has pkg@2.0
		const combined = ["npm:@franlol/formatter@0.0.2", "npm:@franlol/formatter@0.0.3"]
		const result = dedupePluginsByCanonicalName(combined)
		expect(result).toEqual(["npm:@franlol/formatter@0.0.3"])
	})

	it("deduplicates strings and tuples while retaining the winning options", () => {
		const result = dedupePluginsByCanonicalName([
			["npm:pkg@1.0.0", { source: "profile" }],
			"npm:other",
			["npm:pkg@2.0.0", { source: "local" }],
		])

		expect(result).toEqual(["npm:other", ["npm:pkg@2.0.0", { source: "local" }]])
	})
})

// =============================================================================
// mergeOpencodeConfig
// =============================================================================

describe("mergeOpencodeConfig", () => {
	describe("mcp", () => {
		it("preserves mcp when later component has none", () => {
			const target: NormalizedOpencodeConfig = {
				mcp: {
					server1: { type: "remote", enabled: true, url: "https://example.com/mcp" },
				},
			}
			const source: NormalizedOpencodeConfig = {
				agent: {
					myagent: { temperature: 0.5 },
				},
			}

			const result = mergeOpencodeConfig(target, source)

			expect(result.mcp).toBeDefined()
			expect(result.mcp?.server1).toEqual({
				type: "remote",
				enabled: true,
				url: "https://example.com/mcp",
			})
			expect(result.agent?.myagent).toBeDefined()
		})

		it("merges mcp servers from multiple components", () => {
			const target: NormalizedOpencodeConfig = {
				mcp: {
					server1: { type: "remote", enabled: true, url: "https://example1.com/mcp" },
				},
			}
			const source: NormalizedOpencodeConfig = {
				mcp: {
					server2: { type: "remote", enabled: true, url: "https://example2.com/mcp" },
				},
			}

			const result = mergeOpencodeConfig(target, source)

			expect(result.mcp?.server1).toBeDefined()
			expect(result.mcp?.server2).toBeDefined()
		})

		it("later component overwrites same-named mcp server", () => {
			const target: NormalizedOpencodeConfig = {
				mcp: {
					server1: { type: "remote", enabled: true, url: "https://old.com/mcp" },
				},
			}
			const source: NormalizedOpencodeConfig = {
				mcp: {
					server1: { type: "remote", enabled: false, url: "https://new.com/mcp" },
				},
			}

			const result = mergeOpencodeConfig(target, source)

			expect(result.mcp?.server1?.url).toBe("https://new.com/mcp")
			expect(result.mcp?.server1?.enabled).toBe(false)
		})
	})

	describe("plugin array — canonical dedupe", () => {
		it("concatenates plugins from multiple components", () => {
			const target: NormalizedOpencodeConfig = {
				plugin: ["plugin-a", "plugin-b"],
			}
			const source: NormalizedOpencodeConfig = {
				plugin: ["plugin-c", "plugin-d"],
			}

			const result = mergeOpencodeConfig(target, source)

			expect(result.plugin).toEqual(["plugin-a", "plugin-b", "plugin-c", "plugin-d"])
		})

		it("deduplicates identical plugin entries", () => {
			const target: NormalizedOpencodeConfig = {
				plugin: ["plugin-a", "plugin-b"],
			}
			const source: NormalizedOpencodeConfig = {
				plugin: ["plugin-b", "plugin-c"],
			}

			const result = mergeOpencodeConfig(target, source)

			expect(result.plugin).toEqual(["plugin-a", "plugin-b", "plugin-c"])
		})

		it("deduplicates by canonical name — later version wins", () => {
			const target: NormalizedOpencodeConfig = {
				plugin: ["npm:@scope/pkg@1.0.0", "npm:other"],
			}
			const source: NormalizedOpencodeConfig = {
				plugin: ["npm:@scope/pkg@2.0.0"],
			}

			const result = mergeOpencodeConfig(target, source)

			// npm:@scope/pkg@2.0.0 replaces npm:@scope/pkg@1.0.0 (same canonical name)
			expect(result.plugin).toEqual(["npm:other", "npm:@scope/pkg@2.0.0"])
		})

		it("deduplicates unscoped versioned plugins — later wins", () => {
			const target: NormalizedOpencodeConfig = {
				plugin: ["npm:chalk@4.0.0"],
			}
			const source: NormalizedOpencodeConfig = {
				plugin: ["npm:chalk@5.0.0"],
			}

			const result = mergeOpencodeConfig(target, source)

			expect(result.plugin).toEqual(["npm:chalk@5.0.0"])
		})

		it("merges plugin option tuples by canonical specifier without dropping options", () => {
			const target: NormalizedOpencodeConfig = {
				plugin: [
					["npm:formatter@1.0.0", { source: "profile" }],
					["npm:keep", { setting: true }],
				],
			}
			const source: NormalizedOpencodeConfig = {
				plugin: [["npm:formatter@2.0.0", { source: "local" }], "npm:new"],
			}

			const result = mergeOpencodeConfig(target, source)

			expect(result.plugin).toEqual([
				["npm:keep", { setting: true }],
				["npm:formatter@2.0.0", { source: "local" }],
				"npm:new",
			])
		})

		it("preserves plugins when later component has none", () => {
			const target: NormalizedOpencodeConfig = {
				plugin: ["plugin-a", "plugin-b"],
			}
			const source: NormalizedOpencodeConfig = {
				agent: { myagent: { temperature: 0.5 } },
			}

			const result = mergeOpencodeConfig(target, source)

			expect(result.plugin).toEqual(["plugin-a", "plugin-b"])
		})
	})

	describe("instructions array", () => {
		it("concatenates instructions from multiple components", () => {
			const target: NormalizedOpencodeConfig = {
				instructions: ["CONTRIBUTING.md", "docs/style.md"],
			}
			const source: NormalizedOpencodeConfig = {
				instructions: ["docs/api.md"],
			}

			const result = mergeOpencodeConfig(target, source)

			expect(result.instructions).toEqual(["CONTRIBUTING.md", "docs/style.md", "docs/api.md"])
		})

		it("deduplicates identical instruction entries", () => {
			const target: NormalizedOpencodeConfig = {
				instructions: ["CONTRIBUTING.md", "docs/style.md"],
			}
			const source: NormalizedOpencodeConfig = {
				instructions: ["docs/style.md", "docs/api.md"],
			}

			const result = mergeOpencodeConfig(target, source)

			expect(result.instructions).toEqual(["CONTRIBUTING.md", "docs/style.md", "docs/api.md"])
		})

		it("preserves instructions when later component has none", () => {
			const target: NormalizedOpencodeConfig = {
				instructions: ["CONTRIBUTING.md"],
			}
			const source: NormalizedOpencodeConfig = {
				agent: { myagent: { temperature: 0.5 } },
			}

			const result = mergeOpencodeConfig(target, source)

			expect(result.instructions).toEqual(["CONTRIBUTING.md"])
		})
	})

	describe("non-special arrays — replacement behavior (OpenCode parity)", () => {
		it("source replaces target for non-special arrays via mergeDeep", () => {
			// Cast to bypass strict typing — OpenCode configs are passthrough
			const target = { customArray: ["a", "b"] } as unknown as NormalizedOpencodeConfig
			const source = { customArray: ["c"] } as unknown as NormalizedOpencodeConfig

			const result = mergeOpencodeConfig(target, source) as Record<string, unknown>

			// mergeDeep replaces arrays (source wins), no concatenation
			expect(result.customArray).toEqual(["c"])
		})

		it("agent object merges deeply but agent-level arrays would be replaced", () => {
			// The agent object is deep-merged, but any array values within follow mergeDeep default
			const target: NormalizedOpencodeConfig = {
				agent: {
					myagent: { temperature: 0.3, prompt: "old" },
				},
			}
			const source: NormalizedOpencodeConfig = {
				agent: {
					myagent: { temperature: 0.5 },
				},
			}

			const result = mergeOpencodeConfig(target, source)

			// Deep merge: temperature overwritten, prompt preserved
			expect(result.agent?.myagent?.temperature).toBe(0.5)
			expect(result.agent?.myagent?.prompt).toBe("old")
		})
	})

	describe("tools", () => {
		it("merges tools from multiple components", () => {
			const target: NormalizedOpencodeConfig = {
				tools: { write: true, bash: false },
			}
			const source: NormalizedOpencodeConfig = {
				tools: { edit: true, "mcp_*": false },
			}

			const result = mergeOpencodeConfig(target, source)

			expect(result.tools).toEqual({
				write: true,
				bash: false,
				edit: true,
				"mcp_*": false,
			})
		})

		it("later component can override specific tool setting", () => {
			const target: NormalizedOpencodeConfig = {
				tools: { write: true, bash: false },
			}
			const source: NormalizedOpencodeConfig = {
				tools: { bash: true },
			}

			const result = mergeOpencodeConfig(target, source)

			expect(result.tools?.write).toBe(true)
			expect(result.tools?.bash).toBe(true)
		})

		it("preserves tools when later component has none", () => {
			const target: NormalizedOpencodeConfig = {
				tools: { write: true, bash: false },
			}
			const source: NormalizedOpencodeConfig = {
				agent: { myagent: { temperature: 0.5 } },
			}

			const result = mergeOpencodeConfig(target, source)

			expect(result.tools).toEqual({ write: true, bash: false })
		})

		it("handles non-array plugin gracefully", () => {
			const target: NormalizedOpencodeConfig = {
				plugin: ["npm:a"],
			}
			const source = {
				plugin: "invalid" as unknown,
			}

			const result = mergeOpencodeConfig(target, source as NormalizedOpencodeConfig)

			// Should preserve target array when source is invalid
			expect(result.plugin).toEqual(["npm:a"])
		})

		it("handles non-array instructions gracefully", () => {
			const target: NormalizedOpencodeConfig = {
				instructions: ["file.md"],
			}
			const source = {
				instructions: "invalid" as unknown,
			}

			const result = mergeOpencodeConfig(target, source as NormalizedOpencodeConfig)

			// Should preserve target array when source is invalid
			expect(result.instructions).toEqual(["file.md"])
		})

		it("handles empty plugin arrays", () => {
			const target: NormalizedOpencodeConfig = {
				plugin: [],
			}
			const source: NormalizedOpencodeConfig = {
				plugin: ["npm:a"],
			}

			const result = mergeOpencodeConfig(target, source)

			expect(result.plugin).toEqual(["npm:a"])
		})

		it("handles null/undefined plugin arrays", () => {
			const target: NormalizedOpencodeConfig = {}
			const source: NormalizedOpencodeConfig = {
				plugin: ["npm:a"],
			}

			const result = mergeOpencodeConfig(target, source)

			expect(result.plugin).toEqual(["npm:a"])
		})

		it("uses source value when both sides are non-array (edge case)", () => {
			const target = { plugin: "invalid1" as unknown }
			const source = { plugin: "invalid2" as unknown }
			const result = mergeOpencodeConfig(
				target as NormalizedOpencodeConfig,
				source as NormalizedOpencodeConfig,
			)
			// When neither is an array, mergeDeep's result is used (source wins)
			// This is an edge case that shouldn't occur with validated configs
			expect(result.plugin as unknown).toBe("invalid2")
		})
	})

	describe("agent", () => {
		it("merges agents from multiple components", () => {
			const target: NormalizedOpencodeConfig = {
				agent: {
					agent1: { temperature: 0.3 },
				},
			}
			const source: NormalizedOpencodeConfig = {
				agent: {
					agent2: { temperature: 0.7 },
				},
			}

			const result = mergeOpencodeConfig(target, source)

			expect(result.agent?.agent1).toBeDefined()
			expect(result.agent?.agent2).toBeDefined()
		})

		it("later component can override same-named agent config", () => {
			const target: NormalizedOpencodeConfig = {
				agent: {
					myagent: { temperature: 0.3, prompt: "original prompt" },
				},
			}
			const source: NormalizedOpencodeConfig = {
				agent: {
					myagent: { temperature: 0.5, tools: { write: false } },
				},
			}

			const result = mergeOpencodeConfig(target, source)

			expect(result.agent?.myagent?.temperature).toBe(0.5)
			expect(result.agent?.myagent?.prompt).toBe("original prompt")
			expect(result.agent?.myagent?.tools?.write).toBe(false)
		})
	})
})

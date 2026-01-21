/**
 * Unit tests for OpenCode config merging behavior.
 *
 * These tests verify that mergeOpencodeConfig correctly handles:
 * - MCP server merging (regression test for the undefined overwrite bug)
 * - Plugin array concatenation and deduplication
 * - Instructions array concatenation and deduplication
 * - Tools object merging
 */

import { describe, expect, it } from "bun:test"
import { mergeOpencodeConfig } from "../src/registry/merge"
import type { NormalizedOpencodeConfig } from "../src/schemas/registry"

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

	describe("plugin array", () => {
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

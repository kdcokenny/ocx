/**
 * Instruction Discovery Unit Tests
 *
 * Tests for instruction file discovery with "bait" files to prove boundaries.
 * Instruction discovery walks up from project directory to git root and
 * filters by exclude/include patterns.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ConfigResolver } from "../../src/config/resolver"
import { readOpencodeJsonConfig } from "../../src/updaters/update-opencode-config"
import { tmpdir } from "../fixture"

describe("instruction discovery", () => {
	let originalXdgConfigHome: string | undefined
	let originalOcxProfile: string | undefined
	let originalDisableClaudeCode: string | undefined
	let xdgDir: string

	beforeEach(async () => {
		// Create isolated XDG directory
		xdgDir = path.join(os.tmpdir(), `ocx-test-xdg-${Math.random().toString(36).slice(2)}`)
		await fs.mkdir(xdgDir, { recursive: true })

		// Save and override environment
		originalXdgConfigHome = process.env.XDG_CONFIG_HOME
		originalOcxProfile = process.env.OCX_PROFILE
		originalDisableClaudeCode = process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT
		process.env.XDG_CONFIG_HOME = xdgDir
		delete process.env.OCX_PROFILE
		// Disable Claude Code fallback for isolated testing
		process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT = "1"
	})

	afterEach(async () => {
		// Restore environment
		if (originalXdgConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME
		} else {
			process.env.XDG_CONFIG_HOME = originalXdgConfigHome
		}
		if (originalOcxProfile === undefined) {
			delete process.env.OCX_PROFILE
		} else {
			process.env.OCX_PROFILE = originalOcxProfile
		}
		if (originalDisableClaudeCode === undefined) {
			delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT
		} else {
			process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT = originalDisableClaudeCode
		}
		// Cleanup XDG directory
		await fs.rm(xdgDir, { recursive: true, force: true })
	})

	it("discovers instruction files walking up to git root", async () => {
		await using tmp = await tmpdir({
			gitInit: true, // Real git init for proper root detection
			profile: { name: "default", ocxConfig: { registries: {}, exclude: [], include: [] } },
		})

		// Create nested structure with instruction files at multiple levels
		const nestedDir = path.join(tmp.path, "workspace", "project")
		await fs.mkdir(nestedDir, { recursive: true })

		await Bun.write(path.join(tmp.path, "AGENTS.md"), "# Root level")
		await Bun.write(path.join(tmp.path, "workspace", "AGENTS.md"), "# Workspace level")
		await Bun.write(path.join(nestedDir, "AGENTS.md"), "# Project level")

		const resolver = await ConfigResolver.create(nestedDir)
		const config = resolver.resolve()

		// Should find all three
		expect(config.instructions.length).toBeGreaterThanOrEqual(3)

		// Verify all three paths are present
		const instructionPaths = config.instructions.map((p) => path.relative(tmp.path, p))
		expect(instructionPaths).toContain("workspace/project/AGENTS.md")
		expect(instructionPaths).toContain("workspace/AGENTS.md")
		expect(instructionPaths).toContain("AGENTS.md")

		// Verify ordering: deepest first (project before workspace before root)
		const projectIdx = instructionPaths.indexOf("workspace/project/AGENTS.md")
		const workspaceIdx = instructionPaths.indexOf("workspace/AGENTS.md")
		const rootIdx = instructionPaths.indexOf("AGENTS.md")

		expect(projectIdx).toBeLessThan(workspaceIdx)
		expect(workspaceIdx).toBeLessThan(rootIdx)
	})

	it("stops at git root (does NOT discover files above it)", async () => {
		await using tmp = await tmpdir({
			gitInit: true,
			profile: { name: "default", ocxConfig: { registries: {}, exclude: [], include: [] } },
		})

		// Create a BAIT file ABOVE the git root (in the parent temp directory)
		// Must use an exact instruction filename (AGENTS.md, CLAUDE.md, or CONTEXT.md)
		// to prove the boundary - ConfigResolver only looks for these exact names
		const parentDir = path.dirname(tmp.path)
		const baitFile = path.join(parentDir, "AGENTS.md")
		await Bun.write(baitFile, "# BAIT - should NOT be discovered")

		// Create a file INSIDE git root
		await Bun.write(path.join(tmp.path, "AGENTS.md"), "# Inside git root")

		try {
			const resolver = await ConfigResolver.create(tmp.path)
			const config = resolver.resolve()

			// Should find the one inside git root
			const insideFile = path.join(tmp.path, "AGENTS.md")
			const hasInsideFile = config.instructions.some((p) => p === insideFile)
			expect(hasInsideFile).toBe(true)

			// Should NOT find the bait file (it's above git root)
			const hasBaitFile = config.instructions.some((p) => p === baitFile)
			expect(hasBaitFile).toBe(false)
		} finally {
			// Clean up bait file (CRITICAL: must clean up as it's outside temp directory)
			await fs.rm(baitFile, { force: true })
		}
	})

	it("filters instructions by exclude pattern", async () => {
		await using tmp = await tmpdir({
			gitInit: true,
			profile: {
				name: "default",
				ocxConfig: {
					registries: {},
					exclude: ["**/CLAUDE.md"], // Exclude CLAUDE.md
					include: [],
				},
			},
		})

		await Bun.write(path.join(tmp.path, "AGENTS.md"), "# Agents")
		await Bun.write(path.join(tmp.path, "CLAUDE.md"), "# Claude - should be excluded")

		const resolver = await ConfigResolver.create(tmp.path)
		const config = resolver.resolve()

		// Should find AGENTS.md
		const hasAgents = config.instructions.some((p) => p.endsWith("AGENTS.md"))
		expect(hasAgents).toBe(true)

		// Should NOT find CLAUDE.md (excluded)
		const hasClaude = config.instructions.some((p) => p.endsWith("CLAUDE.md"))
		expect(hasClaude).toBe(false)
	})

	it("include pattern overrides exclude pattern", async () => {
		await using tmp = await tmpdir({
			gitInit: true,
			profile: {
				name: "default",
				ocxConfig: {
					registries: {},
					exclude: ["**/*.md"], // Exclude all markdown
					include: ["**/AGENTS.md"], // But include AGENTS.md
				},
			},
		})

		await Bun.write(path.join(tmp.path, "AGENTS.md"), "# Agents - should be included")
		await Bun.write(path.join(tmp.path, "CLAUDE.md"), "# Claude - should be excluded")

		const resolver = await ConfigResolver.create(tmp.path)
		const config = resolver.resolve()

		// Should find AGENTS.md (included despite exclude)
		const hasAgents = config.instructions.some((p) => p.endsWith("AGENTS.md"))
		expect(hasAgents).toBe(true)

		// Should NOT find CLAUDE.md (excluded, not in include)
		const hasClaude = config.instructions.some((p) => p.endsWith("CLAUDE.md"))
		expect(hasClaude).toBe(false)
	})

	it("discovers CONTEXT.md as instruction file", async () => {
		await using tmp = await tmpdir({
			gitInit: true,
			profile: { name: "default", ocxConfig: { registries: {}, exclude: [], include: [] } },
		})

		await Bun.write(path.join(tmp.path, "CONTEXT.md"), "# Context info")

		const resolver = await ConfigResolver.create(tmp.path)
		const config = resolver.resolve()

		const hasContext = config.instructions.some((p) => p.endsWith("CONTEXT.md"))
		expect(hasContext).toBe(true)
	})

	it("returns empty instructions when all excluded by default profile", async () => {
		await using tmp = await tmpdir({
			gitInit: true,
			profile: {
				name: "default",
				ocxConfig: {
					registries: {},
					// Default profile excludes everything
					exclude: ["**/AGENTS.md", "**/CLAUDE.md", "**/CONTEXT.md"],
					include: [],
				},
			},
		})

		await Bun.write(path.join(tmp.path, "AGENTS.md"), "# Agents")
		await Bun.write(path.join(tmp.path, "CLAUDE.md"), "# Claude")

		const resolver = await ConfigResolver.create(tmp.path)
		const config = resolver.resolve()

		// All instruction files should be excluded
		const projectInstructions = config.instructions.filter(
			(p) => p.endsWith("AGENTS.md") || p.endsWith("CLAUDE.md") || p.endsWith("CONTEXT.md"),
		)
		expect(projectInstructions.length).toBe(0)
	})

	it("includes profile AGENTS.md when profile is active", async () => {
		await using tmp = await tmpdir({
			gitInit: true,
			profile: {
				name: "test-profile",
				ocxConfig: {
					registries: {},
					exclude: [],
					include: [],
				},
				agentsMd: "# Profile instructions",
			},
		})

		// Create project AGENTS.md
		await Bun.write(path.join(tmp.path, "AGENTS.md"), "# Project instructions")

		// Pass profile explicitly to ensure it's resolved
		const resolver = await ConfigResolver.create(tmp.path, { profile: "test-profile" })
		const config = resolver.resolve()

		// Verify profile was resolved
		expect(config.profileName).toBe("test-profile")

		// Should include both profile and project AGENTS.md
		const profileDir = path.join(xdgDir, "opencode", "profiles", "test-profile")
		const profileAgentsPath = path.join(profileDir, "AGENTS.md")
		const projectAgentsPath = path.join(tmp.path, "AGENTS.md")

		expect(config.instructions).toContain(profileAgentsPath)
		expect(config.instructions).toContain(projectAgentsPath)

		// Profile AGENTS should come BEFORE project AGENTS (lower priority)
		const profileIdx = config.instructions.indexOf(profileAgentsPath)
		const projectIdx = config.instructions.indexOf(projectAgentsPath)
		expect(profileIdx).toBeLessThan(projectIdx)
	})

	it("skips directory targets during optional config discovery (no Bun.file(...).text() on dirs)", async () => {
		await using tmp = await tmpdir({
			gitInit: true,
		})

		const localConfigDir = path.join(tmp.path, ".opencode")
		await fs.mkdir(path.join(localConfigDir, "opencode.jsonc"), { recursive: true })

		await expect(readOpencodeJsonConfig(tmp.path)).resolves.toBeNull()
	})
})

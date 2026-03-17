/**
 * Tests for the Terminal Module (worktree-terminal.ts)
 * Tests shell escaping functions, temp script cleanup, and security hardening.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { escapeAppleScript, escapeBash, escapeBatch } from "../files/plugins/kdco-primitives/shell"
import {
	buildCmuxCommandSequence,
	canUseCmuxWorkflow,
	detectCmuxContext,
	detectTerminalType,
	openCmuxTerminal,
	openCmuxTerminalWithState,
	openTerminal,
	withTempScript,
} from "../files/plugins/worktree/terminal"

describe("worktree-terminal", () => {
	describe("Shell Escape Functions", () => {
		describe("escapeBash", () => {
			it("throws on null bytes", () => {
				expect(() => escapeBash("hello\x00world")).toThrow(/null bytes/)
			})

			it("allows normal strings", () => {
				expect(() => escapeBash("hello world")).not.toThrow()
			})

			it("allows special characters that can be escaped", () => {
				expect(() => escapeBash('$PATH `command` "quoted"')).not.toThrow()
			})

			it("escapes carriage returns", () => {
				const result = escapeBash("line1\rline2")
				expect(result).not.toContain("\r")
				expect(result).toContain(" ") // CR replaced with space
			})

			it("escapes newlines", () => {
				const result = escapeBash("line1\nline2")
				expect(result).not.toContain("\n")
				expect(result).toContain(" ") // LF replaced with space
			})

			it("escapes dollar signs", () => {
				const result = escapeBash("$HOME")
				expect(result).toContain("\\$")
			})

			it("escapes backticks", () => {
				const result = escapeBash("`command`")
				expect(result).toContain("\\`")
			})

			it("escapes double quotes", () => {
				const result = escapeBash('"quoted"')
				expect(result).toContain('\\"')
			})

			it("escapes backslashes", () => {
				const result = escapeBash("path\\to\\file")
				expect(result).toContain("\\\\")
			})

			it("escapes exclamation marks", () => {
				const result = escapeBash("hello!")
				expect(result).toContain("\\!")
			})

			it("handles empty strings", () => {
				expect(escapeBash("")).toBe("")
			})

			it("handles strings with multiple special characters", () => {
				const result = escapeBash('$HOME/path `cmd` "text" \\n')
				expect(result).not.toContain("\n")
				expect(result).toContain("\\$")
				expect(result).toContain("\\`")
				expect(result).toContain('\\"')
			})
		})

		describe("escapeAppleScript", () => {
			it("throws on null bytes", () => {
				expect(() => escapeAppleScript("hello\x00world")).toThrow(/null bytes/)
			})

			it("allows normal strings", () => {
				expect(() => escapeAppleScript("hello world")).not.toThrow()
			})

			it("escapes double quotes", () => {
				const result = escapeAppleScript('"quoted"')
				expect(result).toContain('\\"')
			})

			it("escapes backslashes", () => {
				const result = escapeAppleScript("path\\to\\file")
				expect(result).toContain("\\\\")
			})

			it("preserves dollar signs (not special in AppleScript)", () => {
				const result = escapeAppleScript("$variable")
				expect(result).toBe("$variable")
			})

			it("handles empty strings", () => {
				expect(escapeAppleScript("")).toBe("")
			})
		})

		describe("escapeBatch", () => {
			it("throws on null bytes", () => {
				expect(() => escapeBatch("hello\x00world")).toThrow(/null bytes/)
			})

			it("allows normal strings", () => {
				expect(() => escapeBatch("hello world")).not.toThrow()
			})

			it("escapes percent signs", () => {
				const result = escapeBatch("%PATH%")
				expect(result).toContain("%%")
			})

			it("escapes caret characters", () => {
				const result = escapeBatch("a^b")
				expect(result).toContain("^^")
			})

			it("escapes ampersand characters", () => {
				const result = escapeBatch("cmd1 & cmd2")
				expect(result).toContain("^&")
			})

			it("escapes less-than characters", () => {
				const result = escapeBatch("a < b")
				expect(result).toContain("^<")
			})

			it("escapes greater-than characters", () => {
				const result = escapeBatch("a > b")
				expect(result).toContain("^>")
			})

			it("escapes pipe characters", () => {
				const result = escapeBatch("cmd1 | cmd2")
				expect(result).toContain("^|")
			})

			it("handles empty strings", () => {
				expect(escapeBatch("")).toBe("")
			})

			it("handles strings with multiple special characters", () => {
				const result = escapeBatch("%PATH% & echo < > | ^")
				expect(result).toContain("%%")
				expect(result).toContain("^&")
				expect(result).toContain("^<")
				expect(result).toContain("^>")
				expect(result).toContain("^|")
				expect(result).toContain("^^")
			})
		})
	})

	describe("withTempScript", () => {
		let testDir: string

		beforeEach(() => {
			testDir = path.join(os.tmpdir(), `worktree-terminal-test-${Date.now()}-${Math.random()}`)
			fs.mkdirSync(testDir, { recursive: true })
		})

		afterEach(() => {
			try {
				fs.rmSync(testDir, { recursive: true, force: true })
			} catch {
				// Ignore cleanup errors
			}
		})

		it("cleans up script after successful execution", async () => {
			let capturedPath: string | null = null

			const result = await withTempScript("echo test", async (scriptPath) => {
				capturedPath = scriptPath
				expect(fs.existsSync(scriptPath)).toBe(true)
				return "success"
			})

			expect(result).toBe("success")
			expect(capturedPath).not.toBeNull()
			if (capturedPath === null) throw new Error("Expected capturedPath to be set")
			expect(fs.existsSync(capturedPath)).toBe(false)
		})

		it("cleans up script after failed execution", async () => {
			let capturedPath: string | null = null

			try {
				await withTempScript("echo test", async (scriptPath) => {
					capturedPath = scriptPath
					expect(fs.existsSync(scriptPath)).toBe(true)
					throw new Error("intentional failure")
				})
			} catch (error) {
				expect((error as Error).message).toBe("intentional failure")
			}

			expect(capturedPath).not.toBeNull()
			if (capturedPath === null) throw new Error("Expected capturedPath to be set")
			expect(fs.existsSync(capturedPath)).toBe(false)
		})

		it("uses .sh extension by default", async () => {
			await withTempScript("echo test", async (scriptPath) => {
				expect(scriptPath).toMatch(/\.sh$/)
			})
		})

		it("uses custom extension when provided", async () => {
			await withTempScript(
				"@echo off",
				async (scriptPath) => {
					expect(scriptPath).toMatch(/\.bat$/)
				},
				".bat",
			)
		})

		it("writes script content correctly", async () => {
			const content = "#!/bin/bash\necho 'hello world'"

			await withTempScript(content, async (scriptPath) => {
				const fileContent = fs.readFileSync(scriptPath, "utf-8")
				expect(fileContent).toBe(content)
			})
		})

		it("makes script executable", async () => {
			await withTempScript("echo test", async (scriptPath) => {
				const stats = fs.statSync(scriptPath)
				// Check if owner has execute permission (0o100)
				expect(stats.mode & 0o100).toBe(0o100)
			})
		})

		it("returns value from callback function", async () => {
			const result = await withTempScript("echo test", async () => {
				return { status: "completed", count: 42 }
			})

			expect(result).toEqual({ status: "completed", count: 42 })
		})

		it("propagates errors from callback function", async () => {
			await expect(
				withTempScript("echo test", async () => {
					throw new Error("callback error")
				}),
			).rejects.toThrow("callback error")
		})
	})

	describe("cmux integration", () => {
		const originalEnv = { ...process.env }

		afterEach(() => {
			process.env = { ...originalEnv }
		})

		it("detects cmux context values from environment", () => {
			const context = detectCmuxContext({
				CMUX_WORKSPACE_ID: " workspace-123 ",
				CMUX_SURFACE_ID: " surface-456 ",
				CMUX_SOCKET_PATH: " /tmp/cmux.sock ",
				CMUX_SOCKET_MODE: " allowAll ",
			})

			expect(context).toEqual({
				workspaceID: "workspace-123",
				surfaceID: "surface-456",
				socketPath: "/tmp/cmux.sock",
				socketMode: "allowAll",
			})
		})

		it("returns false when cmux executable is unavailable", () => {
			const canUse = canUseCmuxWorkflow({ CMUX_WORKSPACE_ID: "workspace-123" }, () => undefined)
			expect(canUse).toBe(false)
		})

		it("returns true when workspace context and cmux executable exist", () => {
			const canUse = canUseCmuxWorkflow(
				{ CMUX_WORKSPACE_ID: "workspace-123" },
				() => "/usr/bin/cmux",
			)
			expect(canUse).toBe(true)
		})

		it("returns false when only surface context is present", () => {
			const canUse = canUseCmuxWorkflow({ CMUX_SURFACE_ID: "surface-123" }, () => "/usr/bin/cmux")
			expect(canUse).toBe(false)
		})

		it("returns true when socket allowAll mode is configured", () => {
			const canUse = canUseCmuxWorkflow(
				{
					CMUX_SOCKET_PATH: "/tmp/cmux.sock",
					CMUX_SOCKET_MODE: "allowAll",
				},
				() => "/usr/bin/cmux",
			)
			expect(canUse).toBe(true)
		})

		it("returns false when socket mode does not allow external control", () => {
			const canUse = canUseCmuxWorkflow(
				{
					CMUX_SOCKET_PATH: "/tmp/cmux.sock",
					CMUX_SOCKET_MODE: "restricted",
				},
				() => "/usr/bin/cmux",
			)
			expect(canUse).toBe(false)
		})

		it("builds workspace-targeted cmux command sequence", () => {
			const commands = buildCmuxCommandSequence(
				{ workspaceID: "workspace-123" },
				'cd "/tmp/worktree" && opencode --session abc\n',
			)

			expect(commands).toEqual([
				["select-workspace", "--workspace", "workspace-123"],
				["new-split", "right"],
				["send", 'cd "/tmp/worktree" && opencode --session abc\n'],
			])
		})

		it("builds fallback cmux command sequence without workspace context", () => {
			const commands = buildCmuxCommandSequence({}, 'cd "/tmp/worktree"\n')

			expect(commands).toEqual([["new-workspace"], ["send", 'cd "/tmp/worktree"\n']])
		})

		it("executes cmux command sequence when workspace context is available", async () => {
			const executed: string[][] = []

			const result = await openCmuxTerminal("/tmp/worktree", "opencode --session abc", {
				env: { CMUX_WORKSPACE_ID: "workspace-123" },
				resolveExecutable: () => "/usr/bin/cmux",
				runCmuxCommand: (args) => {
					executed.push(args)
					return { exitCode: 0, stderr: "" }
				},
			})

			expect(result).toEqual({ success: true })
			expect(executed).toEqual([
				["select-workspace", "--workspace", "workspace-123"],
				["new-split", "right"],
				["send", 'cd "/tmp/worktree" && opencode --session abc\n'],
			])
		})

		it("returns failure when cmux command exits non-zero", async () => {
			const result = await openCmuxTerminal("/tmp/worktree", "opencode --session abc", {
				env: { CMUX_WORKSPACE_ID: "workspace-123" },
				resolveExecutable: () => "/usr/bin/cmux",
				runCmuxCommand: (args) => {
					if (args[0] === "new-split") {
						return { exitCode: 1, stderr: "split failed" }
					}
					return { exitCode: 0, stderr: "" }
				},
			})

			expect(result).toEqual({ success: false, error: "cmux new-split failed: split failed" })
		})

		it("marks state mutation when send fails after cmux split creation", async () => {
			const result = await openCmuxTerminalWithState("/tmp/worktree", "opencode --session abc", {
				env: { CMUX_WORKSPACE_ID: "workspace-123" },
				resolveExecutable: () => "/usr/bin/cmux",
				runCmuxCommand: (args) => {
					if (args[0] === "send") {
						return { exitCode: 1, stderr: "send failed" }
					}
					return { exitCode: 0, stderr: "" }
				},
			})

			expect(result).toEqual({
				terminalResult: { success: false, error: "cmux send failed: send failed" },
				hasStateMutation: true,
			})
		})

		it("openTerminal falls back when cmux fails before mutation", async () => {
			let platformCalled = false

			const result = await openTerminal("/tmp/worktree", "opencode --session abc", undefined, {
				detectTerminalType: () => "cmux",
				openCmuxTerminalWithState: async () => ({
					terminalResult: { success: false, error: "cmux unavailable" },
					hasStateMutation: false,
				}),
				openPlatformTerminal: async () => {
					platformCalled = true
					return { success: true }
				},
			})

			expect(platformCalled).toBe(true)
			expect(result).toEqual({ success: true })
		})

		it("openTerminal does not fallback after mutated cmux failure", async () => {
			let platformCalled = false

			const result = await openTerminal("/tmp/worktree", "opencode --session abc", undefined, {
				detectTerminalType: () => "cmux",
				openCmuxTerminalWithState: async () => ({
					terminalResult: { success: false, error: "cmux send failed: send failed" },
					hasStateMutation: true,
				}),
				openPlatformTerminal: async () => {
					platformCalled = true
					return { success: true }
				},
			})

			expect(platformCalled).toBe(false)
			expect(result).toEqual({ success: false, error: "cmux send failed: send failed" })
		})

		it("keeps tmux priority when both tmux and cmux env are present", () => {
			process.env = {
				...originalEnv,
				TMUX: "/tmp/tmux-1000/default,123,0",
				CMUX_WORKSPACE_ID: "workspace-123",
			}

			expect(detectTerminalType()).toBe("tmux")
		})
	})
})

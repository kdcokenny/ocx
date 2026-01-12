/**
 * Tests for the Terminal Module (worktree-terminal.ts)
 * Tests shell escaping functions, temp script cleanup, and security hardening.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { escapeAppleScript, escapeBash, escapeBatch } from "../files/plugin/kdco-primitives/shell"
import { withTempScript } from "../files/plugin/worktree/terminal"

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
})

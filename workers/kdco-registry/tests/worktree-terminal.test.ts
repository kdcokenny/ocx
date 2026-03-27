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
	buildBashCommandFromArgv,
	buildBatchCommandFromArgv,
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

		describe("argv command builders", () => {
			it("treats empty argv as no command", () => {
				expect(buildBashCommandFromArgv([])).toBeUndefined()
				expect(buildBatchCommandFromArgv([])).toBeUndefined()
			})

			it("escapes embedded double quotes in batch arguments", () => {
				const command = buildBatchCommandFromArgv(["ocx", "--message", 'say "hello"'])
				expect(command).toBe('"ocx" "--message" "say ""hello"""')
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

		const createHangingCmuxExecutable = () => {
			const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-cmux-timeout-"))
			const cmuxPath =
				process.platform === "win32"
					? path.join(fakeBinDir, "cmux.cmd")
					: path.join(fakeBinDir, "cmux")
			const markerPath = path.join(fakeBinDir, "terminated.txt")
			const pidPath = path.join(fakeBinDir, "cmux.pid")
			const workerScriptPath = path.join(fakeBinDir, "cmux-hang.js")
			const bunExecutable = JSON.stringify(process.execPath)

			const workerScript = `import { writeFileSync } from "node:fs"
const [markerPath, pidPath] = process.argv.slice(2)

writeFileSync(pidPath, String(process.pid))

const terminate = () => {
	writeFileSync(markerPath, "terminated")
	process.exit(0)
}

process.on("SIGTERM", terminate)
process.on("SIGINT", terminate)

setInterval(() => {}, 1000)
`

			fs.writeFileSync(workerScriptPath, workerScript)

			const launcherScript =
				process.platform === "win32"
					? `@echo off\r\n${bunExecutable} ${JSON.stringify(workerScriptPath)} ${JSON.stringify(markerPath)} ${JSON.stringify(pidPath)}\r\n`
					: `#!/bin/sh\nexec ${bunExecutable} ${JSON.stringify(workerScriptPath)} ${JSON.stringify(markerPath)} ${JSON.stringify(pidPath)}\n`

			fs.writeFileSync(cmuxPath, launcherScript)
			fs.chmodSync(cmuxPath, 0o755)

			const cleanup = () => {
				try {
					if (fs.existsSync(pidPath)) {
						const pid = Number.parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10)
						if (Number.isFinite(pid)) {
							try {
								process.kill(pid, "SIGKILL")
							} catch {
								// Best-effort cleanup
							}
						}
					}
				} catch {
					// Best-effort cleanup
				}

				try {
					fs.rmSync(fakeBinDir, { recursive: true, force: true })
				} catch {
					// Best-effort cleanup
				}
			}

			return { cmuxPath, markerPath, pidPath, cleanup }
		}

		const isProcessAlive = (pid: number): boolean => {
			try {
				process.kill(pid, 0)
				return true
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code
				if (code === "EPERM") {
					return true
				}
				return false
			}
		}

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

		it("uses the configured cmux executable for preflight checks", () => {
			const canUse = canUseCmuxWorkflow(
				{ CMUX_WORKSPACE_ID: "workspace-123" },
				(command) => (command === "/custom/cmux" ? "/custom/cmux" : undefined),
				"/custom/cmux",
			)

			expect(canUse).toBe(true)
		})

		it("returns true when workspace context and cmux executable exist", () => {
			const canUse = canUseCmuxWorkflow(
				{ CMUX_WORKSPACE_ID: "workspace-123" },
				() => "/usr/bin/cmux",
			)
			expect(canUse).toBe(true)
		})

		it("openCmuxTerminalWithState honors cmuxCommand preflight", async () => {
			let commandCount = 0
			const result = await openCmuxTerminalWithState(
				"/tmp/worktree",
				["opencode", "--session", "abc"],
				{
					env: { CMUX_WORKSPACE_ID: "workspace-123" },
					cmuxCommand: "/custom/cmux",
					resolveExecutable: (command) => (command === "/custom/cmux" ? "/custom/cmux" : undefined),
					runCmuxCommand: () => {
						commandCount += 1
						return { exitCode: 0, stderr: "" }
					},
				},
			)

			expect(result.terminalResult).toEqual({ success: true })
			expect(commandCount).toBe(1)
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

		it("always builds new-workspace cmux command even with workspace context", () => {
			const commands = buildCmuxCommandSequence({ workspaceID: "workspace-123" }, "/tmp/worktree", [
				"opencode",
				"--session",
				"abc",
			])

			expect(commands).toEqual([
				["new-workspace", "--cwd", "/tmp/worktree", "--command", '"opencode" "--session" "abc"'],
			])
			expect(commands.some((args) => args[0] === "select-workspace")).toBe(false)
		})

		it("builds fallback cmux command sequence without workspace context", () => {
			const commands = buildCmuxCommandSequence({}, "/tmp/worktree")

			expect(commands).toEqual([["new-workspace", "--cwd", "/tmp/worktree"]])
		})

		it("executes new-workspace cmux command when workspace context is available", async () => {
			const executed: string[][] = []

			const result = await openCmuxTerminal("/tmp/worktree", ["opencode", "--session", "abc"], {
				env: { CMUX_WORKSPACE_ID: "workspace-123" },
				resolveExecutable: () => "/usr/bin/cmux",
				runCmuxCommand: (args) => {
					executed.push(args)
					return { exitCode: 0, stderr: "" }
				},
			})

			expect(result).toEqual({ success: true })
			expect(executed).toEqual([
				["new-workspace", "--cwd", "/tmp/worktree", "--command", '"opencode" "--session" "abc"'],
			])
			expect(executed.some((args) => args[0] === "select-workspace")).toBe(false)
		})

		it("returns failure when cmux command exits non-zero", async () => {
			const result = await openCmuxTerminal("/tmp/worktree", ["opencode", "--session", "abc"], {
				env: { CMUX_WORKSPACE_ID: "workspace-123" },
				resolveExecutable: () => "/usr/bin/cmux",
				runCmuxCommand: (args) => {
					if (args[0] === "new-workspace") {
						return { exitCode: 1, stderr: "split failed" }
					}
					return { exitCode: 0, stderr: "" }
				},
			})

			expect(result).toEqual({ success: false, error: "cmux new-workspace failed: split failed" })
		})

		it("handles async cmux runner rejection without falling through", async () => {
			const result = await openCmuxTerminalWithState(
				"/tmp/worktree",
				["opencode", "--session", "abc"],
				{
					env: { CMUX_WORKSPACE_ID: "workspace-123" },
					resolveExecutable: () => "/usr/bin/cmux",
					runCmuxCommand: async (args) => {
						if (args[0] === "new-workspace") {
							throw new Error("timed out")
						}
						return { exitCode: 0, stderr: "" }
					},
				},
			)

			expect(result).toEqual({
				terminalResult: { success: false, error: "cmux new-workspace failed: timed out" },
				hasStateMutation: false,
			})
		})

		it("marks timeout from real cmux runner as unsafe for fallback and sends termination", async () => {
			const { cmuxPath, markerPath, pidPath, cleanup } = createHangingCmuxExecutable()

			try {
				const result = await openCmuxTerminalWithState(
					"/tmp/worktree",
					["opencode", "--session", "abc"],
					{
						env: { CMUX_WORKSPACE_ID: "workspace-123" },
						resolveExecutable: () => cmuxPath,
						cmuxCommand: cmuxPath,
					},
				)

				expect(result.terminalResult.success).toBe(false)
				expect(result.terminalResult.error).toContain("timed out")
				expect(result.hasStateMutation).toBe(true)

				let spawnedPid: number | undefined
				for (let i = 0; i < 20; i++) {
					if (fs.existsSync(pidPath)) {
						spawnedPid = Number.parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10)
						if (Number.isFinite(spawnedPid)) {
							break
						}
					}
					await Bun.sleep(50)
				}

				expect(Number.isFinite(spawnedPid)).toBe(true)
				if (typeof spawnedPid !== "number" || !Number.isFinite(spawnedPid)) {
					throw new Error("Failed to capture spawned cmux test process PID")
				}
				const spawnedProcessID: number = spawnedPid

				let terminatedByPid = false
				for (let i = 0; i < 20; i++) {
					if (!isProcessAlive(spawnedProcessID)) {
						terminatedByPid = true
						break
					}
					await Bun.sleep(50)
				}

				expect(terminatedByPid).toBe(true)

				if (process.platform !== "win32") {
					let terminated = false
					for (let i = 0; i < 20; i++) {
						if (fs.existsSync(markerPath)) {
							terminated = true
							break
						}
						await Bun.sleep(50)
					}

					expect(terminated).toBe(true)
				}
			} finally {
				cleanup()
			}
		})

		it("keeps pre-mutation status when new-workspace command exits non-zero", async () => {
			const result = await openCmuxTerminalWithState(
				"/tmp/worktree",
				["opencode", "--session", "abc"],
				{
					env: { CMUX_WORKSPACE_ID: "workspace-123" },
					resolveExecutable: () => "/usr/bin/cmux",
					runCmuxCommand: (args) => {
						if (args[0] === "new-workspace") {
							return { exitCode: 1, stderr: "send failed" }
						}
						return { exitCode: 0, stderr: "" }
					},
				},
			)

			expect(result).toEqual({
				terminalResult: { success: false, error: "cmux new-workspace failed: send failed" },
				hasStateMutation: false,
			})
		})

		it("openTerminal falls back when cmux fails before mutation", async () => {
			let platformCalled = false

			const result = await openTerminal(
				"/tmp/worktree",
				["opencode", "--session", "abc"],
				undefined,
				{
					detectTerminalType: () => "cmux",
					openCmuxTerminalWithState: async () => ({
						terminalResult: { success: false, error: "cmux unavailable" },
						hasStateMutation: false,
					}),
					openPlatformTerminal: async () => {
						platformCalled = true
						return { success: true }
					},
				},
			)

			expect(platformCalled).toBe(true)
			expect(result).toEqual({ success: true })
		})

		it("openTerminal does not fallback after mutated cmux failure", async () => {
			let platformCalled = false

			const result = await openTerminal(
				"/tmp/worktree",
				["opencode", "--session", "abc"],
				undefined,
				{
					detectTerminalType: () => "cmux",
					openCmuxTerminalWithState: async () => ({
						terminalResult: { success: false, error: "cmux send failed: send failed" },
						hasStateMutation: true,
					}),
					openPlatformTerminal: async () => {
						platformCalled = true
						return { success: true }
					},
				},
			)

			expect(platformCalled).toBe(false)
			expect(result).toEqual({ success: false, error: "cmux send failed: send failed" })
		})

		it("openTerminal avoids fallback when real cmux timeout is indeterminate", async () => {
			const { cmuxPath, cleanup } = createHangingCmuxExecutable()
			let platformCalled = false

			try {
				const result = await openTerminal(
					"/tmp/worktree",
					["opencode", "--session", "abc"],
					undefined,
					{
						detectTerminalType: () => "cmux",
						openCmuxTerminalWithState: (cwd, argv) =>
							openCmuxTerminalWithState(cwd, argv, {
								env: { CMUX_WORKSPACE_ID: "workspace-123" },
								resolveExecutable: () => cmuxPath,
								cmuxCommand: cmuxPath,
							}),
						openPlatformTerminal: async () => {
							platformCalled = true
							return { success: true }
						},
					},
				)

				expect(platformCalled).toBe(false)
				expect(result.success).toBe(false)
				expect(result.error).toContain("timed out")
			} finally {
				cleanup()
			}
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

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import {
	formatTerminalName,
	isInsideTmux,
	sanitizeOscTerminalTitle,
	setTerminalName,
	setTerminalTitle,
	setTmuxWindowName,
} from "../src/utils/terminal-title"

describe("terminal-title", () => {
	describe("isInsideTmux", () => {
		let originalTmuxEnv: string | undefined

		beforeEach(() => {
			originalTmuxEnv = process.env.TMUX
		})

		afterEach(() => {
			// Restore original TMUX env
			if (originalTmuxEnv !== undefined) {
				process.env.TMUX = originalTmuxEnv
			} else {
				delete process.env.TMUX
			}
		})

		it("returns a boolean", () => {
			const result = isInsideTmux()

			expect(typeof result).toBe("boolean")
		})

		it("returns true when TMUX env is set", () => {
			process.env.TMUX = "/tmp/tmux-1000/default,12345,0"
			const result = isInsideTmux()

			expect(result).toBe(true)
		})

		it("returns false when TMUX env is not set", () => {
			delete process.env.TMUX
			const result = isInsideTmux()

			expect(result).toBe(false)
		})

		it("returns false when TMUX env is empty string", () => {
			process.env.TMUX = ""
			const result = isInsideTmux()

			expect(result).toBe(false)
		})
	})

	describe("setTerminalName", () => {
		let stdoutWriteSpy: ReturnType<typeof spyOn>
		let bunSpawnSyncSpy: ReturnType<typeof spyOn>
		let originalTmuxEnv: string | undefined
		// Track calls manually for easier assertion
		let spawnSyncCalls: unknown[][]

		beforeEach(() => {
			// Capture original state
			originalTmuxEnv = process.env.TMUX
			spawnSyncCalls = []
			// Spy on stdout.write to observe escape sequence writes
			stdoutWriteSpy = spyOn(process.stdout, "write").mockImplementation(() => true)
			// Spy on Bun.spawnSync to observe tmux calls
			bunSpawnSyncSpy = spyOn(Bun, "spawnSync").mockImplementation((cmd: unknown) => {
				spawnSyncCalls.push(cmd as unknown[])
				// Return minimal valid mock - use type assertion
				return { exitCode: 0, success: true } as ReturnType<typeof Bun.spawnSync>
			})
		})

		afterEach(() => {
			// Restore spies and env
			stdoutWriteSpy.mockRestore()
			bunSpawnSyncSpy.mockRestore()
			if (originalTmuxEnv !== undefined) {
				process.env.TMUX = originalTmuxEnv
			} else {
				delete process.env.TMUX
			}
		})

		it("calls Bun.spawnSync with tmux commands when inside tmux", () => {
			process.env.TMUX = "/tmp/tmux-1000/default,12345,0"

			setTerminalName("test-name")

			// Should have called tmux commands
			expect(spawnSyncCalls.length).toBeGreaterThanOrEqual(2)
			// Check rename-window call
			expect(spawnSyncCalls[0]).toEqual(["tmux", "rename-window", "test-name"])
			// Check set-window-option call
			expect(spawnSyncCalls[1]).toEqual(["tmux", "set-window-option", "automatic-rename", "off"])
		})

		it("does not call Bun.spawnSync when not inside tmux", () => {
			delete process.env.TMUX

			setTerminalName("test-name")

			// Should not call tmux commands
			expect(spawnSyncCalls.length).toBe(0)
		})

		// Smoke tests: verify no exceptions thrown for various inputs
		const inputs = [
			{ name: "valid name", value: "test-terminal-name" },
			{ name: "special characters", value: "ocx[work]: my-project@main" },
			{ name: "empty string", value: "" },
			{ name: "unicode characters", value: "🚀 project-name" },
		]

		for (const { name, value } of inputs) {
			it(`handles ${name} without throwing`, () => {
				expect(() => setTerminalName(value)).not.toThrow()
			})
		}
	})

	describe("setTerminalTitle", () => {
		let stdoutWriteSpy: ReturnType<typeof spyOn>

		beforeEach(() => {
			// Spy on stdout.write to observe escape sequence writes
			stdoutWriteSpy = spyOn(process.stdout, "write").mockImplementation(() => true)
		})

		afterEach(() => {
			stdoutWriteSpy.mockRestore()
		})

		// Note: setTerminalTitle checks isTTY which is a const evaluated at module load.
		// In CI/test environments, isTTY is typically false, so stdout.write is not called.
		// These tests verify the function doesn't throw and document expected behavior.
		const inputs = ["test-title", ""]

		for (const value of inputs) {
			it(`handles "${value || "(empty string)"}" without throwing`, () => {
				expect(() => setTerminalTitle(value)).not.toThrow()
			})
		}
	})

	describe("sanitizeOscTerminalTitle", () => {
		it("removes control characters before OSC writes", () => {
			const input = "\u0000ocx\u0007 title\u001b"

			expect(sanitizeOscTerminalTitle(input)).toBe("ocx  title")
		})

		it("removes C1 control characters including ST and OSC introducer", () => {
			const input = "title\u009cwith\u009dcontrols"

			expect(sanitizeOscTerminalTitle(input)).toBe("title with controls")
		})

		it("removes adjacent DEL/C1 boundary characters", () => {
			const input = "a\u007fb\u0080c\u009fd"

			expect(sanitizeOscTerminalTitle(input)).toBe("a b c d")
		})

		it("returns empty string when sanitization removes all content", () => {
			expect(sanitizeOscTerminalTitle("\u0007\u001b\u009b\u009c\u009d\u0000")).toBe("")
		})
	})

	describe("setTmuxWindowName", () => {
		let originalTmuxEnv: string | undefined
		let bunSpawnSyncSpy: ReturnType<typeof spyOn>
		// Track calls manually for easier assertion
		let spawnSyncCalls: unknown[][]

		beforeEach(() => {
			originalTmuxEnv = process.env.TMUX
			spawnSyncCalls = []
			// Spy on Bun.spawnSync to observe tmux calls
			bunSpawnSyncSpy = spyOn(Bun, "spawnSync").mockImplementation((cmd: unknown) => {
				spawnSyncCalls.push(cmd as unknown[])
				return { exitCode: 0, success: true } as ReturnType<typeof Bun.spawnSync>
			})
		})

		afterEach(() => {
			bunSpawnSyncSpy.mockRestore()
			if (originalTmuxEnv !== undefined) {
				process.env.TMUX = originalTmuxEnv
			} else {
				delete process.env.TMUX
			}
		})

		it("does not call Bun.spawnSync when not inside tmux", () => {
			delete process.env.TMUX
			setTmuxWindowName("test-window")

			// Should not call any tmux commands
			expect(spawnSyncCalls.length).toBe(0)
		})

		it("calls Bun.spawnSync with correct tmux commands when inside tmux", () => {
			process.env.TMUX = "/tmp/tmux-1000/default,12345,0"
			setTmuxWindowName("test-window-name")

			// Should have called tmux commands
			expect(spawnSyncCalls.length).toBeGreaterThanOrEqual(2)
			// Should call tmux rename-window with the name
			expect(spawnSyncCalls[0]).toEqual(["tmux", "rename-window", "test-window-name"])
			// Should also disable automatic-rename
			expect(spawnSyncCalls[1]).toEqual(["tmux", "set-window-option", "automatic-rename", "off"])
		})
	})

	describe("formatTerminalName", () => {
		const testCases = [
			// Basic cases
			{
				cwd: "/path/to/project",
				profile: "default",
				git: { repoName: "ocx", branch: "main" },
				expected: "ocx[default]:ocx/main",
			},
			{
				cwd: "/path/to/project",
				profile: "work",
				git: { repoName: "app", branch: "feature/auth" },
				expected: "ocx[work]:app/feature/auth",
			},

			// Fallback to dirname when no repo
			{
				cwd: "/path/to/my-project",
				profile: "default",
				git: { repoName: null, branch: null },
				expected: "ocx[default]:my-project",
			},

			// Branch omitted when null
			{
				cwd: "/path/to/ocx",
				profile: "default",
				git: { repoName: "ocx", branch: null },
				expected: "ocx[default]:ocx",
			},

			// Truncation boundary tests
			{
				cwd: "/x",
				profile: "p",
				git: { repoName: "r", branch: "12345678901234567890" },
				expected: "ocx[p]:r/12345678901234567890",
			}, // exactly 20 - no truncate
			{
				cwd: "/x",
				profile: "p",
				git: { repoName: "r", branch: "123456789012345678901" },
				expected: "ocx[p]:r/12345678901234567...",
			}, // 21 chars - truncate

			// Edge cases
			{
				cwd: "/path/to/repo",
				profile: "test",
				git: { repoName: "repo", branch: "feat/add-🚀-emoji" },
				expected: "ocx[test]:repo/feat/add-🚀-emoji",
			}, // unicode
		]

		for (const { cwd, profile, git, expected } of testCases) {
			it(`formats ${profile}:${git.repoName}/${git.branch} correctly`, () => {
				expect(formatTerminalName(cwd, profile, git)).toBe(expected)
			})
		}
	})
})

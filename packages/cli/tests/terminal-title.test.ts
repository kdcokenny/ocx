import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
	formatTerminalName,
	isInsideTmux,
	setTerminalName,
	setTerminalTitle,
	setTmuxWindowName,
} from "../src/utils/terminal-title.js"

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
		it("does not throw when called with a valid name", () => {
			// Smoke test: should not throw regardless of terminal environment
			expect(() => {
				setTerminalName("test-terminal-name")
			}).not.toThrow()
		})

		it("does not throw with special characters in name", () => {
			expect(() => {
				setTerminalName("ghost: my-project@main")
			}).not.toThrow()
		})

		it("does not throw with empty string", () => {
			expect(() => {
				setTerminalName("")
			}).not.toThrow()
		})

		it("does not throw with unicode characters", () => {
			expect(() => {
				setTerminalName("🚀 project-name")
			}).not.toThrow()
		})
	})

	describe("setTerminalTitle", () => {
		it("does not throw when called with a valid title", () => {
			// Smoke test: should not throw regardless of TTY status
			expect(() => {
				setTerminalTitle("test-title")
			}).not.toThrow()
		})

		it("does not throw with empty string", () => {
			expect(() => {
				setTerminalTitle("")
			}).not.toThrow()
		})
	})

	describe("setTmuxWindowName", () => {
		let originalTmuxEnv: string | undefined

		beforeEach(() => {
			originalTmuxEnv = process.env.TMUX
		})

		afterEach(() => {
			if (originalTmuxEnv !== undefined) {
				process.env.TMUX = originalTmuxEnv
			} else {
				delete process.env.TMUX
			}
		})

		it("does not throw when not inside tmux", () => {
			delete process.env.TMUX
			expect(() => {
				setTmuxWindowName("test-window")
			}).not.toThrow()
		})

		it("does not throw when called with a valid name", () => {
			// Smoke test: should not throw regardless of tmux status
			expect(() => {
				setTmuxWindowName("test-window-name")
			}).not.toThrow()
		})
	})

	describe("formatTerminalName", () => {
		const testCases = [
			// Basic cases
			{
				cwd: "/path/to/project",
				profile: "default",
				git: { repoName: "ocx", branch: "main" },
				expected: "ghost[default]:ocx/main",
			},
			{
				cwd: "/path/to/project",
				profile: "work",
				git: { repoName: "app", branch: "feature/auth" },
				expected: "ghost[work]:app/feature/auth",
			},

			// Fallback to dirname when no repo
			{
				cwd: "/path/to/my-project",
				profile: "default",
				git: { repoName: null, branch: null },
				expected: "ghost[default]:my-project",
			},

			// Branch omitted when null
			{
				cwd: "/path/to/ocx",
				profile: "default",
				git: { repoName: "ocx", branch: null },
				expected: "ghost[default]:ocx",
			},

			// Truncation boundary tests
			{
				cwd: "/x",
				profile: "p",
				git: { repoName: "r", branch: "12345678901234567890" },
				expected: "ghost[p]:r/12345678901234567890",
			}, // exactly 20 - no truncate
			{
				cwd: "/x",
				profile: "p",
				git: { repoName: "r", branch: "123456789012345678901" },
				expected: "ghost[p]:r/12345678901234567...",
			}, // 21 chars - truncate

			// Edge cases
			{
				cwd: "/path/to/repo",
				profile: "test",
				git: { repoName: "repo", branch: "feat/add-🚀-emoji" },
				expected: "ghost[test]:repo/feat/add-🚀-emoji",
			}, // unicode
		]

		for (const { cwd, profile, git, expected } of testCases) {
			it(`formats ${profile}:${git.repoName}/${git.branch} correctly`, () => {
				expect(formatTerminalName(cwd, profile, git)).toBe(expected)
			})
		}
	})
})

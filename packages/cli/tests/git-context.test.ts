import { beforeAll, describe, expect, it } from "bun:test"
import { tmpdir } from "node:os"
import { basename } from "node:path"
import { detectGitRepo, getBranch, getGitInfo, getRepoName } from "../src/utils/git-context.js"

describe("git-context", () => {
	// Use the current repository for testing real git operations
	const repoRoot = process.cwd()
	// Git toplevel may differ from cwd (e.g., when running tests from packages/cli)
	// getRepoName returns basename of git toplevel, not cwd
	let expectedRepoName: string

	beforeAll(async () => {
		// Get the actual git toplevel to compute expected repo name
		const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
		})
		await proc.exited
		const output = await new Response(proc.stdout).text()
		expectedRepoName = basename(output.trim())
	})

	describe("getBranch", () => {
		it("returns a string for a valid git repository", async () => {
			const branch = await getBranch(repoRoot)

			expect(branch).not.toBeNull()
			expect(typeof branch).toBe("string")
			if (branch) {
				expect(branch.length).toBeGreaterThan(0)
			}
		})

		it("returns null for a non-git directory", async () => {
			// Use system temp directory which is not a git repo
			const nonGitDir = tmpdir()
			const branch = await getBranch(nonGitDir)

			expect(branch).toBeNull()
		})
	})

	describe("getRepoName", () => {
		it("returns the repository name for a valid git repository", async () => {
			const repoName = await getRepoName(repoRoot)

			expect(repoName).not.toBeNull()
			expect(typeof repoName).toBe("string")
			// The repo name is the basename of the git root (works in worktrees too)
			expect(repoName).toBe(expectedRepoName)
		})

		it("returns null for a non-git directory", async () => {
			const nonGitDir = tmpdir()
			const repoName = await getRepoName(nonGitDir)

			expect(repoName).toBeNull()
		})
	})

	describe("getGitInfo", () => {
		it("returns both repoName and branch for a valid git repository", async () => {
			const info = await getGitInfo(repoRoot)

			expect(info).toBeDefined()
			expect(info.repoName).toBe(expectedRepoName)
			expect(info.branch).not.toBeNull()
			expect(typeof info.branch).toBe("string")
		})

		it("returns null values for both fields in a non-git directory", async () => {
			const nonGitDir = tmpdir()
			const info = await getGitInfo(nonGitDir)

			expect(info).toBeDefined()
			expect(info.repoName).toBeNull()
			expect(info.branch).toBeNull()
		})
	})

	describe("detectGitRepo", () => {
		it("returns GitContext for a valid git repository", async () => {
			const context = await detectGitRepo(repoRoot)

			expect(context).not.toBeNull()
			if (context) {
				expect(context.gitDir).toBeDefined()
				expect(context.workTree).toBeDefined()
				expect(typeof context.gitDir).toBe("string")
				expect(typeof context.workTree).toBe("string")
				// gitDir should end with .git or be a .git path
				expect(context.gitDir).toContain(".git")
			}
		})

		it("returns null for a non-git directory", async () => {
			const nonGitDir = tmpdir()
			const context = await detectGitRepo(nonGitDir)

			expect(context).toBeNull()
		})

		it("returns absolute paths", async () => {
			const context = await detectGitRepo(repoRoot)

			expect(context).not.toBeNull()
			if (context) {
				// Both paths should be absolute (start with /)
				expect(context.gitDir.startsWith("/")).toBe(true)
				expect(context.workTree.startsWith("/")).toBe(true)
			}
		})
	})

	describe("environment isolation", () => {
		it("does not leak inherited GIT_DIR environment variable", async () => {
			// This tests that the functions properly clear inherited env vars
			// The functions should work even if GIT_DIR is set incorrectly
			const originalGitDir = process.env.GIT_DIR
			const originalWorkTree = process.env.GIT_WORK_TREE

			try {
				// Set incorrect git environment variables
				process.env.GIT_DIR = "/nonexistent/path/.git"
				process.env.GIT_WORK_TREE = "/nonexistent/path"

				// Functions should still detect the actual repo correctly
				const branch = await getBranch(repoRoot)
				const repoName = await getRepoName(repoRoot)

				expect(branch).not.toBeNull()
				expect(repoName).toBe(expectedRepoName)
			} finally {
				// Restore original env
				if (originalGitDir) {
					process.env.GIT_DIR = originalGitDir
				} else {
					delete process.env.GIT_DIR
				}
				if (originalWorkTree) {
					process.env.GIT_WORK_TREE = originalWorkTree
				} else {
					delete process.env.GIT_WORK_TREE
				}
			}
		})
	})
})

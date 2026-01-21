import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { detectGitRepo, getBranch, getGitInfo, getRepoName } from "../src/utils/git-context"

/**
 * Create a clean environment for git commands.
 * Removes all git-related env vars to prevent interference from parent processes.
 */
function getCleanGitEnv(): NodeJS.ProcessEnv {
	const {
		GIT_DIR: _1,
		GIT_WORK_TREE: _2,
		GIT_INDEX_FILE: _3,
		GIT_OBJECT_DIRECTORY: _4,
		GIT_ALTERNATE_OBJECT_DIRECTORIES: _5,
		GIT_CEILING_DIRECTORIES: _6,
		...cleanEnv
	} = process.env

	// Prevent git from looking outside the test directory
	return {
		...cleanEnv,
		GIT_CEILING_DIRECTORIES: tmpdir(), // Stop searching at tmpdir
	}
}

describe("git-context", () => {
	// Create a temp git repo for testing real git operations
	let testRepoRoot: string
	const testBranchName = "test-branch"

	beforeAll(async () => {
		// Create a unique temporary git repository for testing
		// Use a unique ID to avoid conflicts
		const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
		testRepoRoot = join(tmpdir(), `ocx-git-test-${uniqueId}`)
		await mkdir(testRepoRoot, { recursive: true })

		const gitEnv = getCleanGitEnv()

		// Initialize git repo using sequential commands
		const gitInit = Bun.spawn(["git", "init"], {
			cwd: testRepoRoot,
			env: gitEnv,
			stdout: "pipe",
			stderr: "pipe",
		})
		await gitInit.exited

		// Configure git user
		await Bun.spawn(["git", "config", "user.email", "test@example.com"], {
			cwd: testRepoRoot,
			env: gitEnv,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		await Bun.spawn(["git", "config", "user.name", "Test User"], {
			cwd: testRepoRoot,
			env: gitEnv,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		// Create an initial commit (needed for branch operations)
		await writeFile(join(testRepoRoot, "README.md"), "# Test Repo")

		await Bun.spawn(["git", "add", "README.md"], {
			cwd: testRepoRoot,
			env: gitEnv,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		await Bun.spawn(["git", "commit", "-m", "Initial commit"], {
			cwd: testRepoRoot,
			env: gitEnv,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		// Create and checkout a test branch
		await Bun.spawn(["git", "checkout", "-b", testBranchName], {
			cwd: testRepoRoot,
			env: gitEnv,
			stdout: "pipe",
			stderr: "pipe",
		}).exited
	})

	afterAll(async () => {
		// Cleanup the test repository
		if (testRepoRoot) {
			await rm(testRepoRoot, { recursive: true, force: true })
		}
	})

	afterAll(async () => {
		// Cleanup the test repository
		await rm(testRepoRoot, { recursive: true, force: true })
	})

	describe("getBranch", () => {
		it("returns a string for a valid git repository", async () => {
			const branch = await getBranch(testRepoRoot)

			expect(branch).not.toBeNull()
			expect(typeof branch).toBe("string")
			expect(branch).toBe(testBranchName)
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
			const repoName = await getRepoName(testRepoRoot)

			expect(repoName).not.toBeNull()
			expect(typeof repoName).toBe("string")
			// The repo name is the basename of the git root
			expect(repoName).toBe(basename(testRepoRoot))
		})

		it("returns null for a non-git directory", async () => {
			const nonGitDir = tmpdir()
			const repoName = await getRepoName(nonGitDir)

			expect(repoName).toBeNull()
		})
	})

	describe("getGitInfo", () => {
		it("returns both repoName and branch for a valid git repository", async () => {
			const info = await getGitInfo(testRepoRoot)

			expect(info).toBeDefined()
			expect(info.repoName).toBe(basename(testRepoRoot))
			expect(info.branch).toBe(testBranchName)
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
			const context = await detectGitRepo(testRepoRoot)

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
			const context = await detectGitRepo(testRepoRoot)

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
				const branch = await getBranch(testRepoRoot)
				const repoName = await getRepoName(testRepoRoot)

				expect(branch).toBe(testBranchName)
				expect(repoName).toBe(basename(testRepoRoot))
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

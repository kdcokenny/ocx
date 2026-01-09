/**
 * Git repository context detection utilities.
 *
 * Provides typed detection of git repository context while avoiding
 * pollution from inherited GIT_DIR/GIT_WORK_TREE environment variables.
 */

import { basename, resolve } from "node:path"

/**
 * Creates a clean environment without inherited git directory overrides.
 * Prevents git commands from using wrong repository context.
 * @returns A copy of process.env without GIT_DIR and GIT_WORK_TREE
 */
export function getGitEnv(): NodeJS.ProcessEnv {
	const { GIT_DIR: _, GIT_WORK_TREE: __, ...cleanEnv } = process.env
	return cleanEnv
}

/**
 * Represents a valid git repository context with resolved paths.
 */
export interface GitContext {
	/** Absolute path to the .git directory */
	gitDir: string
	/** Absolute path to the working tree root */
	workTree: string
}

/**
 * Detects if cwd is inside a git repository.
 * Clears inherited GIT_DIR/GIT_WORK_TREE to avoid pollution from parent processes.
 *
 * @param cwd - Directory to check for git repository
 * @returns GitContext if in a repo, null otherwise
 *
 * @example
 * ```ts
 * const gitContext = await detectGitRepo(process.cwd())
 * if (!gitContext) {
 *   console.log("Not in a git repository")
 *   return
 * }
 * console.log(`Git dir: ${gitContext.gitDir}`)
 * ```
 */
export async function detectGitRepo(cwd: string): Promise<GitContext | null> {
	// Detect git directory
	const gitDirProc = Bun.spawn(["git", "rev-parse", "--git-dir"], {
		cwd,
		env: getGitEnv(),
		stdout: "pipe",
		stderr: "pipe",
	})

	const gitDirExitCode = await gitDirProc.exited

	// Early exit: not a git repository
	if (gitDirExitCode !== 0) {
		return null
	}

	const gitDirOutput = await new Response(gitDirProc.stdout).text()
	const gitDirRaw = gitDirOutput.trim()

	// Early exit: empty output means something went wrong
	if (!gitDirRaw) {
		return null
	}

	// Detect work tree root
	const workTreeProc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
		cwd,
		env: getGitEnv(),
		stdout: "pipe",
		stderr: "pipe",
	})

	const workTreeExitCode = await workTreeProc.exited

	// Early exit: could not determine work tree (bare repo or error)
	if (workTreeExitCode !== 0) {
		return null
	}

	const workTreeOutput = await new Response(workTreeProc.stdout).text()
	const workTree = workTreeOutput.trim()

	// Early exit: empty work tree
	if (!workTree) {
		return null
	}

	// Resolve gitDir to absolute path (it may be relative like ".git")
	const gitDir = resolve(cwd, gitDirRaw)

	return { gitDir, workTree }
}

/**
 * Gets the current git branch name.
 *
 * Resolution order:
 * 1. symbolic-ref (normal branch)
 * 2. describe --tags --exact-match (tagged commit)
 * 3. rev-parse --short (detached HEAD - short commit hash)
 *
 * @param cwd - Directory to check
 * @returns Branch name, tag, or short commit hash; null if not a git repo
 *
 * @example
 * ```ts
 * const branch = await getBranch(process.cwd())
 * if (branch) {
 *   console.log(`Current branch: ${branch}`)
 * }
 * ```
 */
export async function getBranch(cwd: string): Promise<string | null> {
	// Try symbolic-ref first (normal branch)
	const symbolicProc = Bun.spawn(["git", "symbolic-ref", "--short", "HEAD"], {
		cwd,
		env: getGitEnv(),
		stdout: "pipe",
		stderr: "pipe",
	})

	const symbolicExitCode = await symbolicProc.exited

	if (symbolicExitCode === 0) {
		const output = await new Response(symbolicProc.stdout).text()
		const branch = output.trim()
		if (branch) {
			return branch
		}
	}

	// Fallback: try exact tag match
	const tagProc = Bun.spawn(["git", "describe", "--tags", "--exact-match", "HEAD"], {
		cwd,
		env: getGitEnv(),
		stdout: "pipe",
		stderr: "pipe",
	})

	const tagExitCode = await tagProc.exited

	if (tagExitCode === 0) {
		const output = await new Response(tagProc.stdout).text()
		const tag = output.trim()
		if (tag) {
			return tag
		}
	}

	// Fallback: short commit hash (detached HEAD)
	const hashProc = Bun.spawn(["git", "rev-parse", "--short", "HEAD"], {
		cwd,
		env: getGitEnv(),
		stdout: "pipe",
		stderr: "pipe",
	})

	const hashExitCode = await hashProc.exited

	if (hashExitCode === 0) {
		const output = await new Response(hashProc.stdout).text()
		const hash = output.trim()
		if (hash) {
			return hash
		}
	}

	// Not a git repo or all methods failed
	return null
}

/**
 * Gets the repository name from the git root directory.
 *
 * @param cwd - Directory to check
 * @returns Repository name (basename of root), null if not a git repo
 *
 * @example
 * ```ts
 * const repoName = await getRepoName(process.cwd())
 * if (repoName) {
 *   console.log(`Repository: ${repoName}`)
 * }
 * ```
 */
export async function getRepoName(cwd: string): Promise<string | null> {
	const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
		cwd,
		env: getGitEnv(),
		stdout: "pipe",
		stderr: "pipe",
	})

	const exitCode = await proc.exited

	// Early exit: not a git repository
	if (exitCode !== 0) {
		return null
	}

	const output = await new Response(proc.stdout).text()
	const rootPath = output.trim()

	// Early exit: empty output
	if (!rootPath) {
		return null
	}

	return basename(rootPath)
}

/**
 * Combined git information for repository context.
 */
export interface GitInfo {
	/** Repository name (basename of git root) */
	repoName: string | null
	/** Current branch, tag, or short commit hash */
	branch: string | null
}

/**
 * Gets combined git repository information.
 *
 * @param cwd - Directory to check
 * @returns Object with repoName and branch (both null if not a git repo)
 *
 * @example
 * ```ts
 * const info = await getGitInfo(process.cwd())
 * console.log(`${info.repoName}@${info.branch}`)
 * ```
 */
export async function getGitInfo(cwd: string): Promise<GitInfo> {
	const [repoName, branch] = await Promise.all([getRepoName(cwd), getBranch(cwd)])

	return { repoName, branch }
}

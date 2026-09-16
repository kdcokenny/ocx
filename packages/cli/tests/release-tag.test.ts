import { afterEach, describe, expect, it } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { executeReleaseTag } from "../scripts/release-tag"
import { getGitEnv } from "../src/utils/git-context"
import type { ExactNpmVersionState } from "../src/utils/npm-registry"

interface GitResult {
	exitCode: number
	stdout: string
	stderr: string
}

interface TestRepo {
	rootDir: string
	remoteDir: string
	workDir: string
}

const cleanupDirs = new Set<string>()

afterEach(async () => {
	for (const dir of cleanupDirs) {
		await rm(dir, { recursive: true, force: true })
	}
	cleanupDirs.clear()
})

async function git(cwd: string, args: string[]): Promise<GitResult> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		env: getGitEnv(),
		stdout: "pipe",
		stderr: "pipe",
	})

	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	])

	return {
		exitCode,
		stdout: stdout.trim(),
		stderr: stderr.trim(),
	}
}

async function gitOrThrow(cwd: string, args: string[]): Promise<string> {
	const result = await git(cwd, args)
	if (result.exitCode !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed (exit=${result.exitCode})\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
		)
	}

	return result.stdout
}

async function setupRepo(version = "1.2.3"): Promise<TestRepo> {
	const rootDir = await mkdtemp(join(tmpdir(), "ocx-release-tag-"))
	const remoteDir = join(rootDir, "remote.git")
	const workDir = join(rootDir, "work")

	cleanupDirs.add(rootDir)

	await mkdir(workDir, { recursive: true })
	await gitOrThrow(rootDir, ["init", "--bare", remoteDir])
	await gitOrThrow(workDir, ["init", "-b", "main"])
	await gitOrThrow(workDir, ["config", "user.email", "test@example.com"])
	await gitOrThrow(workDir, ["config", "user.name", "Test User"])

	const packageJsonPath = join(workDir, "packages", "cli", "package.json")
	await mkdir(join(workDir, "packages", "cli"), { recursive: true })
	await writeFile(
		packageJsonPath,
		JSON.stringify(
			{
				name: "ocx",
				version,
			},
			null,
			2,
		),
	)

	await gitOrThrow(workDir, ["add", "packages/cli/package.json"])
	await gitOrThrow(workDir, ["commit", "-m", "chore: seed release test repo"])

	await gitOrThrow(workDir, ["remote", "add", "origin", remoteDir])
	await gitOrThrow(workDir, ["push", "-u", "origin", "main"])

	await gitOrThrow(remoteDir, ["symbolic-ref", "HEAD", "refs/heads/main"])
	await gitOrThrow(workDir, ["fetch", "origin", "--prune", "--tags"])

	return { rootDir, remoteDir, workDir }
}

function parseRemoteTagSha(tag: string, stdout: string): string | null {
	const lines = stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)

	if (lines.length === 0) {
		return null
	}

	let directSha: string | null = null
	let peeledSha: string | null = null

	for (const line of lines) {
		const [sha, ref] = line.split(/\s+/, 2)
		if (!sha || !ref) {
			continue
		}

		if (ref === `refs/tags/${tag}`) {
			directSha = sha
			continue
		}

		if (ref === `refs/tags/${tag}^{}`) {
			peeledSha = sha
		}
	}

	return peeledSha ?? directSha
}

async function getHeadSha(repo: TestRepo): Promise<string> {
	return gitOrThrow(repo.workDir, ["rev-parse", "HEAD"])
}

async function getLocalTagSha(repo: TestRepo, tag: string): Promise<string | null> {
	const result = await git(repo.workDir, [
		"rev-parse",
		"--verify",
		"--quiet",
		`refs/tags/${tag}^{commit}`,
	])
	if (result.exitCode !== 0 || !result.stdout) {
		return null
	}

	return result.stdout
}

async function getRemoteTagSha(repo: TestRepo, tag: string): Promise<string | null> {
	const result = await git(repo.workDir, [
		"ls-remote",
		"--tags",
		"origin",
		`refs/tags/${tag}`,
		`refs/tags/${tag}^{}`,
	])

	if (result.exitCode !== 0) {
		throw new Error(`ls-remote failed: ${result.stderr}`)
	}

	return parseRemoteTagSha(tag, result.stdout)
}

async function createCommit(repo: TestRepo, fileName: string, contents: string): Promise<string> {
	await writeFile(join(repo.workDir, fileName), contents)
	await gitOrThrow(repo.workDir, ["add", fileName])
	await gitOrThrow(repo.workDir, ["commit", "-m", `chore: ${fileName}`])
	return gitOrThrow(repo.workDir, ["rev-parse", "HEAD"])
}

async function advanceRemoteMainWithoutMovingHead(repo: TestRepo): Promise<string> {
	const parentSha = await getHeadSha(repo)
	const treeSha = await gitOrThrow(repo.workDir, ["rev-parse", "HEAD^{tree}"])
	const commitSha = await gitOrThrow(repo.workDir, [
		"commit-tree",
		treeSha,
		"-p",
		parentSha,
		"-m",
		"chore: advance remote main",
	])
	await gitOrThrow(repo.workDir, ["push", "origin", `${commitSha}:refs/heads/main`])
	return commitSha
}

async function installRejectTagHook(repo: TestRepo, tag: string): Promise<string> {
	const hookPath = join(repo.remoteDir, "hooks", "pre-receive")
	await writeFile(
		hookPath,
		[
			"#!/bin/sh",
			"while read old_sha new_sha ref_name; do",
			`  if [ "$ref_name" = "refs/tags/${tag}" ]; then`,
			"    echo 'rejecting tag push for test' >&2",
			"    exit 1",
			"  fi",
			"done",
			"exit 0",
			"",
		].join("\n"),
	)
	await chmod(hookPath, 0o755)
	return hookPath
}

function missingLookup(): Promise<ExactNpmVersionState> {
	return Promise.resolve({ state: "missing" })
}

const failClosedGitScenarios: Array<{
	name: string
	intercept: (args: string[]) => boolean
	result: GitResult
	expectedMessage: string
}> = [
	{
		name: "the remote manifest cannot be read",
		intercept: (args) => args[0] === "show",
		result: { exitCode: 1, stdout: "", stderr: "show failed" },
		expectedMessage:
			"Could not verify packages/cli/package.json on origin/main; aborting without tag changes.",
	},
	{
		name: "the remote manifest is malformed",
		intercept: (args) => args[0] === "show",
		result: { exitCode: 0, stdout: "{not-json", stderr: "" },
		expectedMessage:
			"Could not verify packages/cli/package.json on origin/main; aborting without tag changes.",
	},
	{
		name: "working-tree status cannot be inspected",
		intercept: (args) => args[0] === "status",
		result: { exitCode: 1, stdout: "", stderr: "status failed" },
		expectedMessage: "Could not inspect working tree status; aborting without tag changes.",
	},
	{
		name: "the live default-branch lookup fails",
		intercept: (args) => args[0] === "ls-remote" && args[1] === "--heads",
		result: { exitCode: 1, stdout: "", stderr: "ls-remote failed" },
		expectedMessage: "Could not verify current origin/main; aborting without tag changes.",
	},
	{
		name: "the live default branch is missing",
		intercept: (args) => args[0] === "ls-remote" && args[1] === "--heads",
		result: { exitCode: 0, stdout: "", stderr: "" },
		expectedMessage: "Could not verify current origin/main; aborting without tag changes.",
	},
]

describe("release-tag helper", () => {
	it.each([
		"1.2.3",
		"3.0.0-alpha.1",
	])("creates and pushes a fresh %s tag when npm is missing", async (version) => {
		const repo = await setupRepo(version)
		const tag = `v${version}`

		const result = await executeReleaseTag(
			{ force: false },
			{
				cwd: repo.workDir,
				lookupNpmVersionState: missingLookup,
			},
		)

		expect(result.exitCode).toBe(0)
		expect(result.message).toBe(`Created and pushed release tag ${tag}.`)

		const headSha = await getHeadSha(repo)
		expect(await getLocalTagSha(repo, tag)).toBe(headSha)
		expect(await getRemoteTagSha(repo, tag)).toBe(headSha)
	})

	it("refuses when the working-tree manifest is newer than origin/<defaultBranch>", async () => {
		const repo = await setupRepo("1.2.3")
		const tag = "v1.2.4"
		const packageJsonPath = join(repo.workDir, "packages", "cli", "package.json")

		await writeFile(
			packageJsonPath,
			JSON.stringify(
				{
					name: "ocx",
					version: "1.2.4",
				},
				null,
				2,
			),
		)

		const result = await executeReleaseTag(
			{ force: false },
			{
				cwd: repo.workDir,
				lookupNpmVersionState: missingLookup,
			},
		)

		expect(result.exitCode).toBe(1)
		expect(result.message).toBe(
			"CLI package manifest must match origin/main (origin: ocx@1.2.3, working tree: ocx@1.2.4); aborting without tag changes.",
		)
		expect(await getLocalTagSha(repo, tag)).toBeNull()
		expect(await getRemoteTagSha(repo, tag)).toBeNull()
	})

	it("refuses when the working tree has unrelated changes", async () => {
		const repo = await setupRepo("1.2.3")
		const tag = "v1.2.3"

		await writeFile(join(repo.workDir, "untracked.txt"), "not committed")

		const result = await executeReleaseTag(
			{ force: false },
			{
				cwd: repo.workDir,
				lookupNpmVersionState: missingLookup,
			},
		)

		expect(result.exitCode).toBe(1)
		expect(result.message).toBe(
			"Working tree must be clean to create a release tag; aborting without tag changes.",
		)
		expect(await getLocalTagSha(repo, tag)).toBeNull()
		expect(await getRemoteTagSha(repo, tag)).toBeNull()
	})

	for (const scenario of failClosedGitScenarios) {
		it(`fails closed when ${scenario.name}`, async () => {
			const repo = await setupRepo("1.2.3")
			const tag = "v1.2.3"

			const result = await executeReleaseTag(
				{ force: false },
				{
					cwd: repo.workDir,
					lookupNpmVersionState: missingLookup,
					runGit: (args, cwd) =>
						scenario.intercept(args) ? Promise.resolve(scenario.result) : git(cwd, args),
				},
			)

			expect(result.exitCode).toBe(1)
			expect(result.message).toBe(scenario.expectedMessage)
			expect(await getLocalTagSha(repo, tag)).toBeNull()
			expect(await getRemoteTagSha(repo, tag)).toBeNull()
		})
	}

	it("keeps local tag after push failure and reports deterministic recovery message", async () => {
		const repo = await setupRepo("1.2.3")
		const tag = "v1.2.3"

		await installRejectTagHook(repo, tag)

		const result = await executeReleaseTag(
			{ force: false },
			{
				cwd: repo.workDir,
				lookupNpmVersionState: missingLookup,
			},
		)

		expect(result.exitCode).toBe(1)
		expect(result.message).toBe(
			"Created local tag v1.2.3 but the guarded push failed; inspect origin/main and rerun with --force only if the local tag is still correct.",
		)

		const headSha = await getHeadSha(repo)
		expect(await getLocalTagSha(repo, tag)).toBe(headSha)
		expect(await getRemoteTagSha(repo, tag)).toBeNull()
	})

	it("refuses when origin/<defaultBranch> advances during npm validation", async () => {
		const repo = await setupRepo("1.2.3")
		const tag = "v1.2.3"
		const originalHead = await getHeadSha(repo)
		let advancedSha: string | null = null

		const result = await executeReleaseTag(
			{ force: false },
			{
				cwd: repo.workDir,
				lookupNpmVersionState: async () => {
					advancedSha = await advanceRemoteMainWithoutMovingHead(repo)
					return { state: "missing" }
				},
			},
		)

		expect(result.exitCode).toBe(1)
		expect(result.message).toBe(
			"origin/main changed during release validation; aborting without tag changes.",
		)
		expect(advancedSha).not.toBe(originalHead)
		expect(await getHeadSha(repo)).toBe(originalHead)
		expect(await getLocalTagSha(repo, tag)).toBeNull()
		expect(await getRemoteTagSha(repo, tag)).toBeNull()
	})

	it("refuses the remote tag when origin/<defaultBranch> moves before the guarded push", async () => {
		const repo = await setupRepo("1.2.3")
		const tag = "v1.2.3"
		const originalHead = await getHeadSha(repo)
		let advancedSha: string | null = null

		const result = await executeReleaseTag(
			{ force: false },
			{
				cwd: repo.workDir,
				lookupNpmVersionState: missingLookup,
				runGit: async (args, cwd) => {
					if (!advancedSha && args[0] === "push" && args.includes("--atomic")) {
						advancedSha = await advanceRemoteMainWithoutMovingHead(repo)
					}
					return git(cwd, args)
				},
			},
		)

		expect(result.exitCode).toBe(1)
		expect(result.message).toBe(
			"Created local tag v1.2.3 but the guarded push failed; inspect origin/main and rerun with --force only if the local tag is still correct.",
		)
		expect(advancedSha).not.toBe(originalHead)
		expect(await getHeadSha(repo)).toBe(originalHead)
		expect(await getLocalTagSha(repo, tag)).toBe(originalHead)
		expect(await getRemoteTagSha(repo, tag)).toBeNull()
	})

	it("retries pushing existing local tag with --force after partial failure", async () => {
		const repo = await setupRepo("1.2.3")
		const tag = "v1.2.3"
		const hookPath = await installRejectTagHook(repo, tag)

		const firstAttempt = await executeReleaseTag(
			{ force: false },
			{
				cwd: repo.workDir,
				lookupNpmVersionState: missingLookup,
			},
		)
		expect(firstAttempt.exitCode).toBe(1)

		const localTagShaBeforeRetry = await getLocalTagSha(repo, tag)
		expect(localTagShaBeforeRetry).toBeTruthy()
		expect(await getRemoteTagSha(repo, tag)).toBeNull()

		await rm(hookPath, { force: true })

		const retry = await executeReleaseTag(
			{ force: true },
			{
				cwd: repo.workDir,
				lookupNpmVersionState: missingLookup,
			},
		)

		expect(retry.exitCode).toBe(0)
		expect(retry.message).toBe("Pushed existing local release tag v1.2.3.")

		const localTagShaAfterRetry = await getLocalTagSha(repo, tag)
		expect(localTagShaAfterRetry).toBe(localTagShaBeforeRetry)
		expect(await getRemoteTagSha(repo, tag)).toBe(localTagShaBeforeRetry)
	})

	it("refuses to push an existing local tag without --force", async () => {
		const repo = await setupRepo("1.2.3")
		const tag = "v1.2.3"

		await gitOrThrow(repo.workDir, ["tag", tag])

		const localBefore = await getLocalTagSha(repo, tag)
		const remoteBefore = await getRemoteTagSha(repo, tag)

		const result = await executeReleaseTag(
			{ force: false },
			{
				cwd: repo.workDir,
				lookupNpmVersionState: missingLookup,
			},
		)

		expect(result.exitCode).toBe(1)
		expect(result.message).toBe(
			"Local tag v1.2.3 already exists; rerun with --force to push the existing tag.",
		)

		expect(await getLocalTagSha(repo, tag)).toBe(localBefore)
		expect(await getRemoteTagSha(repo, tag)).toBe(remoteBefore)
	})

	it("exits cleanly when npm already has the version", async () => {
		const repo = await setupRepo("1.2.3")
		const tag = "v1.2.3"

		const localBefore = await getLocalTagSha(repo, tag)
		const remoteBefore = await getRemoteTagSha(repo, tag)

		const result = await executeReleaseTag(
			{ force: false },
			{
				cwd: repo.workDir,
				lookupNpmVersionState: () => Promise.resolve({ state: "published" }),
			},
		)

		expect(result.exitCode).toBe(0)
		expect(result.message).toBe("Version already published to npm; no tag changes made.")

		expect(await getLocalTagSha(repo, tag)).toBe(localBefore)
		expect(await getRemoteTagSha(repo, tag)).toBe(remoteBefore)
	})

	for (const version of ["1.2.3-beta.1", "not-semver", "3.0.0", "4.0.0"]) {
		it(`refuses non-stable CLI version ${version}`, async () => {
			const repo = await setupRepo(version)
			const tag = `v${version}`

			const result = await executeReleaseTag(
				{ force: false },
				{
					cwd: repo.workDir,
					lookupNpmVersionState: missingLookup,
				},
			)

			expect(result.exitCode).toBe(1)
			expect(result.message).toBe(
				"CLI version must be a legacy stable release or an OCX 3 preview; aborting without tag changes.",
			)

			expect(await getLocalTagSha(repo, tag)).toBeNull()
			expect(await getRemoteTagSha(repo, tag)).toBeNull()
		})
	}

	it("refuses when origin/HEAD cannot be resolved after refresh", async () => {
		const repo = await setupRepo("1.2.3")
		const tag = "v1.2.3"

		await gitOrThrow(repo.remoteDir, ["symbolic-ref", "HEAD", "refs/heads/does-not-exist"])
		await git(repo.workDir, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"])
		await git(repo.workDir, ["update-ref", "-d", "refs/remotes/origin/HEAD"])

		const result = await executeReleaseTag(
			{ force: false },
			{
				cwd: repo.workDir,
				lookupNpmVersionState: missingLookup,
			},
		)

		expect(result.exitCode).toBe(1)
		expect(result.message).toBe(
			"Could not resolve origin/HEAD after refreshing refs; aborting without tag changes.",
		)

		expect(await getLocalTagSha(repo, tag)).toBeNull()
		expect(await getRemoteTagSha(repo, tag)).toBeNull()
	})

	it("fails closed when refreshing origin/HEAD fails even if local origin/HEAD is stale but resolvable", async () => {
		const repo = await setupRepo("1.2.3")
		const tag = "v1.2.3"

		const staleOriginHeadBeforeRun = await gitOrThrow(repo.workDir, [
			"symbolic-ref",
			"--short",
			"refs/remotes/origin/HEAD",
		])
		expect(staleOriginHeadBeforeRun).toBe("origin/main")

		await gitOrThrow(repo.remoteDir, ["symbolic-ref", "HEAD", "refs/heads/does-not-exist"])

		const result = await executeReleaseTag(
			{ force: false },
			{
				cwd: repo.workDir,
				lookupNpmVersionState: missingLookup,
			},
		)

		expect(result.exitCode).toBe(1)
		expect(result.message).toBe(
			"Could not resolve origin/HEAD after refreshing refs; aborting without tag changes.",
		)

		expect(await getLocalTagSha(repo, tag)).toBeNull()
		expect(await getRemoteTagSha(repo, tag)).toBeNull()
	})

	it("refuses when HEAD does not exactly match origin/<defaultBranch>", async () => {
		const repo = await setupRepo("1.2.3")
		const tag = "v1.2.3"

		await createCommit(repo, "local-only.txt", "not pushed")

		const result = await executeReleaseTag(
			{ force: false },
			{
				cwd: repo.workDir,
				lookupNpmVersionState: missingLookup,
			},
		)

		expect(result.exitCode).toBe(1)
		expect(result.message).toBe(
			"HEAD must exactly match origin/main to create a release tag; aborting without tag changes.",
		)

		expect(await getLocalTagSha(repo, tag)).toBeNull()
		expect(await getRemoteTagSha(repo, tag)).toBeNull()
	})

	it("refreshes stale origin/HEAD before default-branch gate", async () => {
		const repo = await setupRepo("1.2.3")
		const tag = "v1.2.3"

		await gitOrThrow(repo.workDir, ["checkout", "-b", "stable"])
		await createCommit(repo, "stable.txt", "stable branch commit")
		await gitOrThrow(repo.workDir, ["push", "-u", "origin", "stable"])
		await gitOrThrow(repo.remoteDir, ["symbolic-ref", "HEAD", "refs/heads/stable"])
		await gitOrThrow(repo.workDir, ["checkout", "main"])

		const staleOriginHeadBeforeRun = await gitOrThrow(repo.workDir, [
			"symbolic-ref",
			"--short",
			"refs/remotes/origin/HEAD",
		])
		expect(staleOriginHeadBeforeRun).toBe("origin/main")

		const result = await executeReleaseTag(
			{ force: false },
			{
				cwd: repo.workDir,
				lookupNpmVersionState: missingLookup,
			},
		)

		expect(result.exitCode).toBe(1)
		expect(result.message).toBe(
			"HEAD must exactly match origin/stable to create a release tag; aborting without tag changes.",
		)

		expect(await getLocalTagSha(repo, tag)).toBeNull()
		expect(await getRemoteTagSha(repo, tag)).toBeNull()
	})

	for (const reason of [
		"timeout",
		"network:socket hang up",
		"http-500",
		"malformed-response:invalid-json",
	]) {
		it(`refuses on npm registry ambiguity (${reason})`, async () => {
			const repo = await setupRepo("1.2.3")
			const tag = "v1.2.3"

			const localBefore = await getLocalTagSha(repo, tag)
			const remoteBefore = await getRemoteTagSha(repo, tag)

			const result = await executeReleaseTag(
				{ force: false },
				{
					cwd: repo.workDir,
					lookupNpmVersionState: () => Promise.resolve({ state: "indeterminate-error", reason }),
				},
			)

			expect(result.exitCode).toBe(1)
			expect(result.message).toBe("npm registry check failed; aborting without tag changes.")

			expect(await getLocalTagSha(repo, tag)).toBe(localBefore)
			expect(await getRemoteTagSha(repo, tag)).toBe(remoteBefore)
		})
	}

	it("refuses when an existing release tag points to a different commit", async () => {
		const repo = await setupRepo("1.2.3")
		const tag = "v1.2.3"

		const previousHead = await getHeadSha(repo)
		await createCommit(repo, "second.txt", "second commit")
		await gitOrThrow(repo.workDir, ["push", "origin", "main"])

		await gitOrThrow(repo.workDir, ["tag", tag, previousHead])
		await gitOrThrow(repo.workDir, ["push", "origin", `refs/tags/${tag}`])

		const localBefore = await getLocalTagSha(repo, tag)
		const remoteBefore = await getRemoteTagSha(repo, tag)

		const result = await executeReleaseTag(
			{ force: false },
			{
				cwd: repo.workDir,
				lookupNpmVersionState: missingLookup,
			},
		)

		expect(result.exitCode).toBe(1)
		expect(result.message).toBe(
			"Release tag v1.2.3 points to a different commit; aborting without tag changes.",
		)

		expect(await getLocalTagSha(repo, tag)).toBe(localBefore)
		expect(await getRemoteTagSha(repo, tag)).toBe(remoteBefore)
	})

	it("refuses when remote tag already exists while npm still lacks the version", async () => {
		const repo = await setupRepo("1.2.3")
		const tag = "v1.2.3"

		await gitOrThrow(repo.workDir, ["tag", tag])
		await gitOrThrow(repo.workDir, ["push", "origin", `refs/tags/${tag}`])

		const localBefore = await getLocalTagSha(repo, tag)
		const remoteBefore = await getRemoteTagSha(repo, tag)

		const result = await executeReleaseTag(
			{ force: false },
			{
				cwd: repo.workDir,
				lookupNpmVersionState: missingLookup,
			},
		)

		expect(result.exitCode).toBe(1)
		expect(result.message).toBe(
			"Remote tag v1.2.3 already exists on origin while npm is missing this version; rerun the release workflow. Aborting without tag changes.",
		)

		expect(await getLocalTagSha(repo, tag)).toBe(localBefore)
		expect(await getRemoteTagSha(repo, tag)).toBe(remoteBefore)
	})

	it("refuses with force-specific message when remote tag already exists and npm still lacks the version", async () => {
		const repo = await setupRepo("1.2.3")
		const tag = "v1.2.3"

		await gitOrThrow(repo.workDir, ["tag", tag])
		await gitOrThrow(repo.workDir, ["push", "origin", `refs/tags/${tag}`])

		const localBefore = await getLocalTagSha(repo, tag)
		const remoteBefore = await getRemoteTagSha(repo, tag)

		const result = await executeReleaseTag(
			{ force: true },
			{
				cwd: repo.workDir,
				lookupNpmVersionState: missingLookup,
			},
		)

		expect(result.exitCode).toBe(1)
		expect(result.message).toBe(
			"Remote tag v1.2.3 already exists on origin while npm is missing this version; --force only retries pushing an existing local tag after a failed push. Rerun the release workflow. Aborting without tag changes.",
		)

		expect(await getLocalTagSha(repo, tag)).toBe(localBefore)
		expect(await getRemoteTagSha(repo, tag)).toBe(remoteBefore)
	})

	it("returns the required not-a-git-repository message", async () => {
		const nonRepoDir = await mkdtemp(join(tmpdir(), "ocx-release-tag-non-repo-"))
		cleanupDirs.add(nonRepoDir)

		const result = await executeReleaseTag(
			{ force: false },
			{
				cwd: nonRepoDir,
				lookupNpmVersionState: missingLookup,
			},
		)

		expect(result.exitCode).toBe(1)
		expect(result.message).toBe("Not a git repository; aborting without tag changes.")
	})
})

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

describe("release-tag helper", () => {
	it("creates and pushes a fresh tag when npm is missing and no tags exist", async () => {
		const repo = await setupRepo("1.2.3")
		const tag = "v1.2.3"

		const result = await executeReleaseTag(
			{ force: false },
			{
				cwd: repo.workDir,
				lookupNpmVersionState: missingLookup,
			},
		)

		expect(result.exitCode).toBe(0)
		expect(result.message).toBe("Created and pushed release tag v1.2.3.")

		const headSha = await getHeadSha(repo)
		expect(await getLocalTagSha(repo, tag)).toBe(headSha)
		expect(await getRemoteTagSha(repo, tag)).toBe(headSha)
	})

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
			"Created local tag v1.2.3 but failed to push to origin; rerun with --force after fixing the push problem.",
		)

		const headSha = await getHeadSha(repo)
		expect(await getLocalTagSha(repo, tag)).toBe(headSha)
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

	for (const version of ["1.2.3-beta.1", "not-semver"]) {
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
				"CLI version must be a stable semver release; aborting without tag changes.",
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

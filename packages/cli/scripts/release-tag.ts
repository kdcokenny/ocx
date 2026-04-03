/**
 * Release tag helper for the publish workflow.
 *
 * Safety contract:
 * - Reads version from packages/cli/package.json only
 * - Requires HEAD to exactly match origin/<defaultBranch>
 * - Uses exact npm name@version lookup as source of truth
 * - Never rewrites existing semver tags
 * - `--force` only retries pushing an already-correct local tag
 */

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { detectGitRepo, getGitEnv } from "../src/utils/git-context"
import {
	type ExactNpmVersionLookup,
	type ExactNpmVersionState,
	lookupExactNpmVersionState,
} from "../src/utils/npm-registry"

const STABLE_SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const STABLE_RELEASE_TAG_REGEX = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

const USAGE_TEXT = [
	"Usage: bun run scripts/release-tag.ts [--force]",
	"",
	"Creates and pushes a release tag for packages/cli/package.json.",
	"",
	"Safety:",
	"- Requires HEAD to equal origin/<defaultBranch> after refresh.",
	"- Requires exact npm name@version to be definitively missing.",
	"- Never rewrites semver tags or overrides immutable npm releases.",
	"",
	"--force:",
	"- Only retries pushing an existing local tag when local tag is already on HEAD,",
	"  npm is still missing the version, and the remote tag is still absent.",
].join("\n")

const MESSAGE_NOT_GIT_REPO = "Not a git repository; aborting without tag changes."
const MESSAGE_ORIGIN_HEAD_UNRESOLVED =
	"Could not resolve origin/HEAD after refreshing refs; aborting without tag changes."
const MESSAGE_INVALID_VERSION =
	"CLI version must be a stable semver release; aborting without tag changes."
const MESSAGE_INVALID_TAG = "Derived tag is not a stable release tag; aborting without tag changes."
const MESSAGE_NPM_PUBLISHED = "Version already published to npm; no tag changes made."
const MESSAGE_NPM_CHECK_FAILED = "npm registry check failed; aborting without tag changes."

function getRemoteTagExistsMessage(tag: string, force: boolean): string {
	if (force) {
		return (
			`Remote tag ${tag} already exists on origin while npm is missing this version; ` +
			"--force only retries pushing an existing local tag after a failed push. " +
			"Rerun the release workflow. Aborting without tag changes."
		)
	}

	return (
		`Remote tag ${tag} already exists on origin while npm is missing this version; ` +
		"rerun the release workflow. Aborting without tag changes."
	)
}

interface ParsedArgs {
	force: boolean
	help: boolean
	unknownArg: string | null
}

interface GitCommandResult {
	exitCode: number
	stdout: string
	stderr: string
}

interface ReleaseTagDependencies {
	lookupNpmVersionState: ExactNpmVersionLookup
	runGit: (args: string[], cwd: string) => Promise<GitCommandResult>
	detectRepo: (cwd: string) => ReturnType<typeof detectGitRepo>
	readPackageManifest: (repoRoot: string) => Promise<{ name: string; version: string }>
	stdout: (message: string) => void
	stderr: (message: string) => void
	cwd: string
}

export interface ReleaseTagExecutionResult {
	exitCode: 0 | 1
	message: string
	stream: "stdout" | "stderr"
}

function parseArgs(argv: string[]): ParsedArgs {
	let force = false
	let help = false

	for (const arg of argv) {
		if (arg === "--force") {
			force = true
			continue
		}

		if (arg === "--help" || arg === "-h") {
			help = true
			continue
		}

		return { force, help, unknownArg: arg }
	}

	return { force, help, unknownArg: null }
}

async function runGitCommand(args: string[], cwd: string): Promise<GitCommandResult> {
	const gitProcess = Bun.spawn(["git", ...args], {
		cwd,
		env: getGitEnv(),
		stdout: "pipe",
		stderr: "pipe",
	})

	const [exitCode, stdout, stderr] = await Promise.all([
		gitProcess.exited,
		new Response(gitProcess.stdout).text(),
		new Response(gitProcess.stderr).text(),
	])

	return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() }
}

async function readCliPackageManifest(
	repoRoot: string,
): Promise<{ name: string; version: string }> {
	const packagePath = resolve(repoRoot, "packages", "cli", "package.json")
	const rawManifest = await readFile(packagePath, "utf-8")
	const parsed = JSON.parse(rawManifest) as { name?: unknown; version?: unknown }

	if (typeof parsed.name !== "string" || typeof parsed.version !== "string") {
		throw new Error("packages/cli/package.json must include string name and version fields")
	}

	return {
		name: parsed.name,
		version: parsed.version,
	}
}

interface TagState {
	sha: string | null
	error: boolean
}

async function getLocalTagState(
	runGit: ReleaseTagDependencies["runGit"],
	cwd: string,
	tag: string,
): Promise<TagState> {
	const result = await runGit(
		["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`],
		cwd,
	)

	if (result.exitCode !== 0) {
		return { sha: null, error: false }
	}

	if (!result.stdout) {
		return { sha: null, error: true }
	}

	return { sha: result.stdout, error: false }
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

async function getRemoteTagState(
	runGit: ReleaseTagDependencies["runGit"],
	cwd: string,
	tag: string,
): Promise<TagState> {
	const result = await runGit(
		["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
		cwd,
	)

	if (result.exitCode !== 0) {
		return { sha: null, error: true }
	}

	return { sha: parseRemoteTagSha(tag, result.stdout), error: false }
}

function success(message: string): ReleaseTagExecutionResult {
	return { exitCode: 0, message, stream: "stdout" }
}

function failure(message: string): ReleaseTagExecutionResult {
	return { exitCode: 1, message, stream: "stderr" }
}

function isStableSemver(version: string): boolean {
	return STABLE_SEMVER_REGEX.test(version)
}

function isStableReleaseTag(tag: string): boolean {
	return STABLE_RELEASE_TAG_REGEX.test(tag)
}

async function ensureMissingNpmVersion(
	lookupNpmVersionState: ExactNpmVersionLookup,
	packageName: string,
	version: string,
): Promise<ExactNpmVersionState> {
	return lookupNpmVersionState(packageName, version)
}

export async function executeReleaseTag(
	options: { force: boolean },
	partialDeps: Partial<ReleaseTagDependencies> = {},
): Promise<ReleaseTagExecutionResult> {
	const deps: ReleaseTagDependencies = {
		lookupNpmVersionState: lookupExactNpmVersionState,
		runGit: runGitCommand,
		detectRepo: detectGitRepo,
		readPackageManifest: readCliPackageManifest,
		stdout: (message: string) => console.log(message),
		stderr: (message: string) => console.error(message),
		cwd: process.cwd(),
		...partialDeps,
	}

	const gitContext = await deps.detectRepo(deps.cwd)
	if (!gitContext) {
		return failure(MESSAGE_NOT_GIT_REPO)
	}

	let manifest: { name: string; version: string }
	try {
		manifest = await deps.readPackageManifest(gitContext.workTree)
	} catch {
		return failure("Could not read packages/cli/package.json; aborting without tag changes.")
	}

	if (!isStableSemver(manifest.version)) {
		return failure(MESSAGE_INVALID_VERSION)
	}

	const releaseTag = `v${manifest.version}`
	if (!isStableReleaseTag(releaseTag)) {
		return failure(MESSAGE_INVALID_TAG)
	}

	const fetchResult = await deps.runGit(["fetch", "origin", "--prune", "--tags"], deps.cwd)
	if (fetchResult.exitCode !== 0) {
		return failure("Failed to refresh refs from origin; aborting without tag changes.")
	}

	// Refresh local refs/remotes/origin/HEAD to avoid trusting stale symbolic refs.
	// We still validate via symbolic-ref below and fail with the contract message
	// if origin/HEAD remains unresolved after refresh.
	const refreshOriginHeadResult = await deps.runGit(
		["remote", "set-head", "origin", "--auto"],
		deps.cwd,
	)
	if (refreshOriginHeadResult.exitCode !== 0) {
		return failure(MESSAGE_ORIGIN_HEAD_UNRESOLVED)
	}

	const originHeadResult = await deps.runGit(
		["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
		deps.cwd,
	)
	if (originHeadResult.exitCode !== 0 || !originHeadResult.stdout.startsWith("origin/")) {
		return failure(MESSAGE_ORIGIN_HEAD_UNRESOLVED)
	}

	const defaultBranch = originHeadResult.stdout.slice("origin/".length)
	if (!defaultBranch) {
		return failure(MESSAGE_ORIGIN_HEAD_UNRESOLVED)
	}

	const headResult = await deps.runGit(["rev-parse", "HEAD"], deps.cwd)
	const defaultHeadResult = await deps.runGit(
		["rev-parse", `refs/remotes/origin/${defaultBranch}`],
		deps.cwd,
	)
	if (headResult.exitCode !== 0 || defaultHeadResult.exitCode !== 0) {
		return failure(MESSAGE_ORIGIN_HEAD_UNRESOLVED)
	}

	const headSha = headResult.stdout
	if (headSha !== defaultHeadResult.stdout) {
		return failure(
			`HEAD must exactly match origin/${defaultBranch} to create a release tag; aborting without tag changes.`,
		)
	}

	const npmState = await ensureMissingNpmVersion(
		deps.lookupNpmVersionState,
		manifest.name,
		manifest.version,
	)
	if (npmState.state === "published") {
		return success(MESSAGE_NPM_PUBLISHED)
	}
	if (npmState.state === "indeterminate-error") {
		return failure(MESSAGE_NPM_CHECK_FAILED)
	}

	const [localTagState, remoteTagState] = await Promise.all([
		getLocalTagState(deps.runGit, deps.cwd, releaseTag),
		getRemoteTagState(deps.runGit, deps.cwd, releaseTag),
	])

	if (localTagState.error || remoteTagState.error) {
		return failure(`Could not inspect tag state for ${releaseTag}; aborting without tag changes.`)
	}

	if (
		(localTagState.sha && localTagState.sha !== headSha) ||
		(remoteTagState.sha && remoteTagState.sha !== headSha)
	) {
		return failure(
			`Release tag ${releaseTag} points to a different commit; aborting without tag changes.`,
		)
	}

	if (remoteTagState.sha) {
		return failure(getRemoteTagExistsMessage(releaseTag, options.force))
	}

	if (localTagState.sha) {
		if (!options.force) {
			return failure(
				`Local tag ${releaseTag} already exists; rerun with --force to push the existing tag.`,
			)
		}

		const retryNpmState = await ensureMissingNpmVersion(
			deps.lookupNpmVersionState,
			manifest.name,
			manifest.version,
		)
		if (retryNpmState.state === "published") {
			return success(MESSAGE_NPM_PUBLISHED)
		}
		if (retryNpmState.state === "indeterminate-error") {
			return failure(MESSAGE_NPM_CHECK_FAILED)
		}

		const retryRemoteTagState = await getRemoteTagState(deps.runGit, deps.cwd, releaseTag)
		if (retryRemoteTagState.error) {
			return failure(`Could not inspect tag state for ${releaseTag}; aborting without tag changes.`)
		}
		if (retryRemoteTagState.sha && retryRemoteTagState.sha !== headSha) {
			return failure(
				`Release tag ${releaseTag} points to a different commit; aborting without tag changes.`,
			)
		}
		if (retryRemoteTagState.sha) {
			return failure(getRemoteTagExistsMessage(releaseTag, true))
		}

		const pushExistingTagResult = await deps.runGit(
			["push", "origin", `refs/tags/${releaseTag}`],
			deps.cwd,
		)
		if (pushExistingTagResult.exitCode !== 0) {
			return failure(
				`Failed to push existing local release tag ${releaseTag}; aborting without tag changes.`,
			)
		}

		return success(`Pushed existing local release tag ${releaseTag}.`)
	}

	const createTagResult = await deps.runGit(["tag", releaseTag], deps.cwd)
	if (createTagResult.exitCode !== 0) {
		return failure(
			`Failed to create local release tag ${releaseTag}; aborting without tag changes.`,
		)
	}

	const pushTagResult = await deps.runGit(["push", "origin", `refs/tags/${releaseTag}`], deps.cwd)
	if (pushTagResult.exitCode !== 0) {
		return failure(
			`Created local tag ${releaseTag} but failed to push to origin; rerun with --force after fixing the push problem.`,
		)
	}

	return success(`Created and pushed release tag ${releaseTag}.`)
}

export async function runReleaseTagCli(
	argv: string[],
	deps: Partial<ReleaseTagDependencies> = {},
): Promise<number> {
	const args = parseArgs(argv)

	if (args.help) {
		const stdout = deps.stdout ?? ((message: string) => console.log(message))
		stdout(USAGE_TEXT)
		return 0
	}

	if (args.unknownArg) {
		const stderr = deps.stderr ?? ((message: string) => console.error(message))
		stderr(`Unknown argument: ${args.unknownArg}`)
		stderr(USAGE_TEXT)
		return 1
	}

	const result = await executeReleaseTag({ force: args.force }, deps)
	if (result.stream === "stdout") {
		;(deps.stdout ?? ((message: string) => console.log(message)))(result.message)
	} else {
		;(deps.stderr ?? ((message: string) => console.error(message)))(result.message)
	}

	return result.exitCode
}

if (import.meta.main) {
	const exitCode = await runReleaseTagCli(process.argv.slice(2))
	process.exit(exitCode)
}

/**
 * Release tag helper for the publish workflow.
 *
 * Safety contract:
 * - Reads version from packages/cli/package.json only
 * - Requires HEAD to exactly match origin/<defaultBranch>
 * - Requires the working-tree manifest to match origin/<defaultBranch>
 * - Requires a clean working tree
 * - Revalidates the live default branch immediately before a guarded tag push
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

const USAGE_TEXT = [
	"Usage: bun run scripts/release-tag.ts [--force]",
	"",
	"Creates and pushes a release tag for packages/cli/package.json.",
	"",
	"Safety:",
	"- Requires HEAD to equal origin/<defaultBranch> after refresh.",
	"- Requires packages/cli/package.json to match origin/<defaultBranch>.",
	"- Requires a clean working tree.",
	"- Revalidates origin/<defaultBranch> immediately before a guarded tag push.",
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
	"CLI version must be a legacy stable release or an OCX 3 preview; aborting without tag changes."
const MESSAGE_INVALID_TAG =
	"Derived tag is not a supported release tag; aborting without tag changes."
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
	return parsePackageManifest(rawManifest)
}

function parsePackageManifest(rawManifest: string): { name: string; version: string } {
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

function parseRemoteBranchSha(branch: string, stdout: string): string | null {
	for (const line of stdout.split("\n")) {
		const [sha, ref] = line.trim().split(/\s+/, 2)
		if (sha && ref === `refs/heads/${branch}`) {
			return sha
		}
	}

	return null
}

async function getRemoteBranchState(
	runGit: ReleaseTagDependencies["runGit"],
	cwd: string,
	branch: string,
): Promise<TagState> {
	const result = await runGit(["ls-remote", "--heads", "origin", `refs/heads/${branch}`], cwd)

	if (result.exitCode !== 0) {
		return { sha: null, error: true }
	}

	return { sha: parseRemoteBranchSha(branch, result.stdout), error: false }
}

function getGuardedTagPushArgs(defaultBranch: string, headSha: string, tag: string): string[] {
	return [
		"push",
		"--atomic",
		`--force-with-lease=refs/heads/${defaultBranch}:${headSha}`,
		"origin",
		`${headSha}:refs/heads/${defaultBranch}`,
		`refs/tags/${tag}`,
	]
}

function success(message: string): ReleaseTagExecutionResult {
	return { exitCode: 0, message, stream: "stdout" }
}

function failure(message: string): ReleaseTagExecutionResult {
	return { exitCode: 1, message, stream: "stderr" }
}

function isPublishableVersion(version: string): boolean {
	return (
		(Number(version.split(".")[0]) < 3 && STABLE_SEMVER_REGEX.test(version)) ||
		/^3\.(0|[1-9]\d*)\.(0|[1-9]\d*)-[a-zA-Z][a-zA-Z0-9-]*(?:\.(0|[1-9]\d*))*$/.test(version)
	)
}

function isPublishableTag(tag: string): boolean {
	return tag.startsWith("v") && isPublishableVersion(tag.slice(1))
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

	if (!isPublishableVersion(manifest.version)) {
		return failure(MESSAGE_INVALID_VERSION)
	}

	const releaseTag = `v${manifest.version}`
	if (!isPublishableTag(releaseTag)) {
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

	const remoteManifestResult = await deps.runGit(
		["show", `refs/remotes/origin/${defaultBranch}:packages/cli/package.json`],
		deps.cwd,
	)
	if (remoteManifestResult.exitCode !== 0) {
		return failure(
			`Could not verify packages/cli/package.json on origin/${defaultBranch}; aborting without tag changes.`,
		)
	}

	let remoteManifest: { name: string; version: string }
	try {
		remoteManifest = parsePackageManifest(remoteManifestResult.stdout)
	} catch {
		return failure(
			`Could not verify packages/cli/package.json on origin/${defaultBranch}; aborting without tag changes.`,
		)
	}

	if (manifest.name !== remoteManifest.name || manifest.version !== remoteManifest.version) {
		return failure(
			`CLI package manifest must match origin/${defaultBranch} ` +
				`(origin: ${remoteManifest.name}@${remoteManifest.version}, ` +
				`working tree: ${manifest.name}@${manifest.version}); aborting without tag changes.`,
		)
	}

	const statusResult = await deps.runGit(["status", "--porcelain=v1"], deps.cwd)
	if (statusResult.exitCode !== 0) {
		return failure("Could not inspect working tree status; aborting without tag changes.")
	}
	if (statusResult.stdout) {
		return failure(
			"Working tree must be clean to create a release tag; aborting without tag changes.",
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

	const liveDefaultBranchState = await getRemoteBranchState(deps.runGit, deps.cwd, defaultBranch)
	if (liveDefaultBranchState.error || !liveDefaultBranchState.sha) {
		return failure(
			`Could not verify current origin/${defaultBranch}; aborting without tag changes.`,
		)
	}
	if (liveDefaultBranchState.sha !== headSha) {
		return failure(
			`origin/${defaultBranch} changed during release validation; aborting without tag changes.`,
		)
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
			getGuardedTagPushArgs(defaultBranch, headSha, releaseTag),
			deps.cwd,
		)
		if (pushExistingTagResult.exitCode !== 0) {
			return failure(
				`Guarded push failed for existing local release tag ${releaseTag}; ` +
					`inspect origin/${defaultBranch} before retrying.`,
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

	// If push advertisement sees the branch move from headSha, its exact lease
	// rejects that refspec and --atomic rejects the tag with it. Git may elide
	// the no-op branch refspec when it is still current, so the live ls-remote
	// check immediately above remains the primary revalidation.
	const pushTagResult = await deps.runGit(
		getGuardedTagPushArgs(defaultBranch, headSha, releaseTag),
		deps.cwd,
	)
	if (pushTagResult.exitCode !== 0) {
		return failure(
			`Created local tag ${releaseTag} but the guarded push failed; ` +
				`inspect origin/${defaultBranch} and rerun with --force only if the local tag is still correct.`,
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

import { execFile } from "node:child_process"
import type { Stats } from "node:fs"
import { lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { type Plugin, tool } from "@opencode-ai/plugin"

const execFileAsync = promisify(execFile)

const TEMP_ROOT_PREFIX = "kdco-flow"
const SAFE_GITHUB_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/
const PRIVATE_MODE_MASK = 0o077
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const GIT_MAX_BUFFER_BYTES = 1024 * 1024 * 10
const GIT_TIMEOUT_MS = 120_000
const GIT_CONFIG_OVERRIDES = [
	"-c",
	"credential.helper=",
	"-c",
	"credential.interactive=false",
	"-c",
	"core.askPass=",
	"-c",
	"http.extraHeader=",
	"-c",
	"http.https://github.com/.extraHeader=",
	"-c",
	"url.ssh://git@github.com/.insteadOf=",
	"-c",
	"url.git@github.com:.insteadOf=",
	"-c",
	"url.https://github.com/.insteadOf=",
	"-c",
	"url.https://github.com/.pushInsteadOf=",
	"-c",
	"protocol.file.allow=always",
	"-c",
	"protocol.https.allow=always",
	"-c",
	"protocol.ssh.allow=never",
	"-c",
	"protocol.git.allow=never",
] as const

interface ParsedRepository {
	readonly owner: string
	readonly repo: string
}

interface ParsedCloneRequest extends ParsedRepository {
	readonly ref?: string
}

interface ResolvedCloneTarget extends ParsedRepository {
	readonly tempRoot: string
	readonly clonePath: string
}

interface SafePathCheck {
	readonly absolutePath: string
	readonly kind: "explorer temp root" | "owner directory" | "clone directory"
}

interface PrivatePathCheck {
	readonly absolutePath: string
	readonly kind: string
	readonly uid?: number
}

interface GitExecutionContext {
	readonly command: "git"
	readonly args: string[]
	readonly options: {
		readonly cwd?: string
		readonly env: Record<string, string>
		readonly maxBuffer: number
		readonly timeout: number
	}
}

function rejectInvalidGitHubName(kind: "owner" | "repo", value: string): void {
	if (!SAFE_GITHUB_NAME.test(value)) {
		throw new Error(
			`${kind} must be a GitHub owner/repo name using only letters, numbers, dot, underscore, or dash.`,
		)
	}

	if (value === "." || value === "..") {
		throw new Error(`${kind} cannot be a dot segment.`)
	}

	if (value.includes("/") || value.includes("\\")) {
		throw new Error(`${kind} cannot contain path separators.`)
	}
}

function parseExplorerRepository(owner: string, repo: string): ParsedRepository {
	const parsedOwner = owner.trim()
	const parsedRepo = repo.trim()

	if (!parsedOwner) {
		throw new Error("owner is required.")
	}

	if (!parsedRepo) {
		throw new Error("repo is required.")
	}

	rejectInvalidGitHubName("owner", parsedOwner)
	rejectInvalidGitHubName("repo", parsedRepo)

	return { owner: parsedOwner, repo: parsedRepo }
}

function parseExplorerRef(ref: string | undefined): string | undefined {
	if (ref === undefined) return undefined

	const parsedRef = ref.trim()
	if (!parsedRef) {
		throw new Error("ref cannot be empty when provided.")
	}

	if (!SAFE_REF.test(parsedRef)) {
		throw new Error("ref contains unsupported characters.")
	}

	if (parsedRef.startsWith("-") || parsedRef.startsWith("/")) {
		throw new Error("ref cannot start with '-' or '/'.")
	}

	if (parsedRef.endsWith("/") || parsedRef.endsWith(".")) {
		throw new Error("ref cannot end with '/' or '.'.")
	}

	if (parsedRef.includes("..") || parsedRef.includes("//") || parsedRef.includes("@{")) {
		throw new Error("ref cannot contain dot-dot, double slash, or reflog syntax.")
	}

	const refSegments = parsedRef.split("/")
	for (const refSegment of refSegments) {
		if (refSegment === "." || refSegment === "..") {
			throw new Error("ref cannot contain dot path segments.")
		}

		if (refSegment.startsWith("-")) {
			throw new Error("ref segments cannot start with '-'.")
		}
	}

	if (parsedRef.endsWith(".lock")) {
		throw new Error("ref cannot end with .lock.")
	}

	return parsedRef
}

function parseExplorerCloneRequest(owner: string, repo: string, ref?: string): ParsedCloneRequest {
	return {
		...parseExplorerRepository(owner, repo),
		ref: parseExplorerRef(ref),
	}
}

function isNotFoundError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT"
}

function getCurrentUid(): number | undefined {
	return typeof process.getuid === "function" ? process.getuid() : undefined
}

function getCurrentUserSegment(uid: number | undefined): string {
	if (uid !== undefined) return String(uid)

	const candidate = os.userInfo().username || process.env.USER || process.env.USERNAME || "unknown"
	const safeCandidate = candidate.replace(/[^A-Za-z0-9._-]/g, "-")
	if (safeCandidate) return safeCandidate

	throw new Error("Unable to derive a safe user-specific explorer temp root name.")
}

async function lstatIfExists(absolutePath: string): Promise<Stats | undefined> {
	try {
		return await lstat(absolutePath)
	} catch (error) {
		if (isNotFoundError(error)) return undefined

		throw error
	}
}

function assertOwnedByCurrentUser(stats: Stats, { kind, uid }: PrivatePathCheck): void {
	if (uid === undefined) return

	if (stats.uid !== uid) {
		throw new Error(`${kind} must be owned by the current user.`)
	}
}

function assertPrivateMode(stats: Stats, kind: string): void {
	if ((stats.mode & PRIVATE_MODE_MASK) !== 0) {
		throw new Error(`${kind} must not be readable, writable, or executable by group or other users.`)
	}
}

async function assertPrivateDirectory(check: PrivatePathCheck): Promise<void> {
	const stats = await lstat(check.absolutePath)

	if (stats.isSymbolicLink()) {
		throw new Error(`${check.kind} cannot be a symbolic link.`)
	}

	if (!stats.isDirectory()) {
		throw new Error(`${check.kind} must be a directory.`)
	}

	const realDirectoryPath = await realpath(check.absolutePath)
	if (realDirectoryPath !== check.absolutePath) {
		throw new Error(`${check.kind} must realpath to its exact scoped path.`)
	}

	assertOwnedByCurrentUser(stats, check)
	assertPrivateMode(stats, check.kind)
}

async function ensurePrivateDirectory(absolutePath: string, kind: string, uid = getCurrentUid()): Promise<void> {
	const existingPath = await lstatIfExists(absolutePath)
	if (!existingPath) {
		await mkdir(absolutePath, { mode: PRIVATE_DIRECTORY_MODE, recursive: false })
	}

	await assertPrivateDirectory({ absolutePath, kind, uid })
}

async function ensurePrivateFile(absolutePath: string, kind: string, uid = getCurrentUid()): Promise<void> {
	const existingPath = await lstatIfExists(absolutePath)
	if (!existingPath) {
		await writeFile(absolutePath, "", { mode: PRIVATE_FILE_MODE })
	}

	const stats = await lstat(absolutePath)
	if (stats.isSymbolicLink()) {
		throw new Error(`${kind} cannot be a symbolic link.`)
	}

	if (!stats.isFile()) {
		throw new Error(`${kind} must be a file.`)
	}

	assertOwnedByCurrentUser(stats, { absolutePath, kind, uid })
	assertPrivateMode(stats, kind)
}

async function assertExistingRealDirectory({ absolutePath, kind }: SafePathCheck): Promise<void> {
	const stats = await lstat(absolutePath)

	if (stats.isSymbolicLink()) {
		throw new Error(`${kind} cannot be a symbolic link.`)
	}

	if (!stats.isDirectory()) {
		throw new Error(`${kind} must be a directory.`)
	}

	const realDirectoryPath = await realpath(absolutePath)
	if (realDirectoryPath !== absolutePath) {
		throw new Error(`${kind} must realpath to its exact scoped path.`)
	}
}

async function assertOptionalRealDirectory({ absolutePath, kind }: SafePathCheck): Promise<void> {
	const stats = await lstatIfExists(absolutePath)
	if (!stats) return

	if (stats.isSymbolicLink()) {
		throw new Error(`${kind} cannot be a symbolic link.`)
	}

	if (!stats.isDirectory()) {
		throw new Error(`${kind} must be a directory.`)
	}

	const realDirectoryPath = await realpath(absolutePath)
	if (realDirectoryPath !== absolutePath) {
		throw new Error(`${kind} must realpath to its exact scoped path.`)
	}
}

async function ensureSafeTempRoot(requestedTempRoot: string): Promise<string> {
	const existingTempRoot = await lstatIfExists(requestedTempRoot)
	if (!existingTempRoot) {
		await mkdir(requestedTempRoot, { mode: PRIVATE_DIRECTORY_MODE, recursive: false })
	}

	await assertPrivateDirectory({
		absolutePath: requestedTempRoot,
		kind: "explorer temp root",
		uid: getCurrentUid(),
	})
	await assertExistingRealDirectory({ absolutePath: requestedTempRoot, kind: "explorer temp root" })
	return requestedTempRoot
}

async function resolveExplorerTempRoot(baseTempDir = os.tmpdir()): Promise<string> {
	const realTempDir = await realpath(baseTempDir)
	const userSegment = getCurrentUserSegment(getCurrentUid())
	return path.join(realTempDir, `${TEMP_ROOT_PREFIX}-${userSegment}`)
}

function ensureExactCloneDepth(tempRoot: string, clonePath: string): void {
	const relativeClonePath = path.relative(tempRoot, clonePath)
	const pathSegments = relativeClonePath.split(path.sep)

	if (relativeClonePath.startsWith("..") || path.isAbsolute(relativeClonePath)) {
		throw new Error("clone path escaped the explorer temp root.")
	}

	if (
		pathSegments.length !== 2 ||
		pathSegments.some((segment) => segment === "" || segment === "." || segment === "..")
	) {
		throw new Error("clone path must resolve to exactly {owner}/{repo} under the explorer temp root.")
	}
}

async function resolveExplorerCloneTarget(owner: string, repo: string): Promise<ResolvedCloneTarget> {
	const parsedRepository = parseExplorerRepository(owner, repo)
	const requestedTempRoot = await resolveExplorerTempRoot()
	const tempRoot = await ensureSafeTempRoot(requestedTempRoot)
	const ownerPath = path.join(tempRoot, parsedRepository.owner)
	const clonePath = path.join(tempRoot, parsedRepository.owner, parsedRepository.repo)
	const normalizedClonePath = path.normalize(clonePath)

	if (normalizedClonePath !== clonePath) {
		throw new Error("clone path did not normalize to the expected exact path.")
	}

	ensureExactCloneDepth(tempRoot, clonePath)
	await assertOptionalRealDirectory({ absolutePath: ownerPath, kind: "owner directory" })
	await assertOptionalRealDirectory({ absolutePath: clonePath, kind: "clone directory" })

	return { ...parsedRepository, tempRoot, clonePath }
}

async function assertSafeCleanupTarget(target: ResolvedCloneTarget): Promise<string> {
	ensureExactCloneDepth(target.tempRoot, target.clonePath)

	const cloneStats = await lstat(target.clonePath)
	if (cloneStats.isSymbolicLink()) {
		throw new Error("refusing to clean up a symbolic link clone path.")
	}

	const realClonePath = await realpath(target.clonePath)
	if (realClonePath !== target.clonePath) {
		throw new Error("refusing to clean up a path that does not realpath to the exact clone directory.")
	}

	return realClonePath
}

async function pathExists(absolutePath: string): Promise<boolean> {
	return (await lstatIfExists(absolutePath)) !== undefined
}

async function prepareIsolatedGitEnvironment(tempRoot: string): Promise<{
	home: string
	xdgConfigHome: string
	globalConfig: string
}> {
	const isolationRoot = path.join(tempRoot, ".git-isolation")
	const home = path.join(isolationRoot, "home")
	const xdgConfigHome = path.join(isolationRoot, "xdg-config")
	const globalConfig = path.join(isolationRoot, "gitconfig")

	await ensurePrivateDirectory(isolationRoot, "isolated git root")
	await ensurePrivateDirectory(home, "isolated git HOME")
	await ensurePrivateDirectory(xdgConfigHome, "isolated git XDG_CONFIG_HOME")
	await ensurePrivateFile(globalConfig, "isolated git global config")

	return { home, xdgConfigHome, globalConfig }
}

function buildIsolatedGitEnv(
	isolation: { home: string; xdgConfigHome: string; globalConfig: string },
	baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
	const env: Record<string, string> = {
		HOME: isolation.home,
		XDG_CONFIG_HOME: isolation.xdgConfigHome,
		GIT_CONFIG_GLOBAL: isolation.globalConfig,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_ASKPASS: "",
		SSH_ASKPASS: "",
		GCM_INTERACTIVE: "Never",
		GIT_ALLOW_PROTOCOL: "https:file",
	}

	for (const key of ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TMP", "TEMP"] as const) {
		const value = baseEnv[key]
		if (value) env[key] = value
	}

	return env
}

function buildSafeGitArgs(args: readonly string[]): string[] {
	return [...GIT_CONFIG_OVERRIDES, ...args]
}

async function prepareGitExecutionContext(
	tempRoot: string,
	args: readonly string[],
	cwd?: string,
	baseEnv?: Record<string, string | undefined>,
): Promise<GitExecutionContext> {
	const isolation = await prepareIsolatedGitEnvironment(tempRoot)
	return {
		command: "git",
		args: buildSafeGitArgs(args),
		options: {
			cwd,
			env: buildIsolatedGitEnv(isolation, baseEnv),
			maxBuffer: GIT_MAX_BUFFER_BYTES,
			timeout: GIT_TIMEOUT_MS,
		},
	}
}

async function runGit(args: readonly string[], tempRoot: string, cwd?: string): Promise<void> {
	const executionContext = await prepareGitExecutionContext(tempRoot, args, cwd)
	await execFileAsync(executionContext.command, executionContext.args, executionContext.options)
}

async function prepareFreshCloneDirectory(target: ResolvedCloneTarget): Promise<void> {
	await assertExistingRealDirectory({ absolutePath: target.tempRoot, kind: "explorer temp root" })

	const ownerPath = path.dirname(target.clonePath)
	await assertOptionalRealDirectory({ absolutePath: ownerPath, kind: "owner directory" })
	await assertOptionalRealDirectory({ absolutePath: target.clonePath, kind: "clone directory" })

	if (!(await pathExists(ownerPath))) {
		await mkdir(ownerPath, { recursive: false })
		await assertExistingRealDirectory({ absolutePath: ownerPath, kind: "owner directory" })
	}

	if (!(await pathExists(target.clonePath))) {
		return
	}

	const cleanupPath = await assertSafeCleanupTarget(target)
	await rm(cleanupPath, { recursive: true, force: false })

	if (await pathExists(target.clonePath)) {
		throw new Error("clone directory still exists after cleanup.")
	}
}

async function cloneRepository(request: ParsedCloneRequest, target: ResolvedCloneTarget): Promise<void> {
	await prepareFreshCloneDirectory(target)

	const githubUrl = `https://github.com/${request.owner}/${request.repo}.git`
	await runGit(["clone", "--", githubUrl, target.clonePath], target.tempRoot)

	await assertExistingRealDirectory({ absolutePath: target.clonePath, kind: "clone directory" })

	if (!request.ref) return

	await runGit(["fetch", "--depth", "1", "origin", request.ref], target.tempRoot, target.clonePath)
	await runGit(["checkout", "--detach", "FETCH_HEAD"], target.tempRoot, target.clonePath)
}

const ExplorerClonePlugin: Plugin = async () => {
	return {
		tool: {
			explorer_clone: tool({
				description:
					"Clone a GitHub repository into the scoped kdco/flow explorer temp directory for read-only inspection.",
				args: {
					owner: tool.schema.string().describe("GitHub repository owner, for example 'opencode-ai'."),
					repo: tool.schema.string().describe("GitHub repository name, for example 'opencode'."),
					ref: tool.schema
						.string()
						.optional()
						.describe("Optional branch, tag, or commit-ish to fetch and check out."),
				},
				async execute(args) {
					try {
						const request = parseExplorerCloneRequest(args.owner, args.repo, args.ref)
						const target = await resolveExplorerCloneTarget(request.owner, request.repo)
						await cloneRepository(request, target)

						return JSON.stringify({
							path: target.clonePath,
							owner: request.owner,
							repo: request.repo,
							ref: request.ref ?? null,
						})
					} catch (error) {
						return `Blocked: ${error instanceof Error ? error.message : String(error)}`
					}
				},
			}),
			explorer_clone_cleanup: tool({
				description:
					"Remove the exact scoped kdco/flow explorer clone directory for a GitHub owner/repo pair.",
				args: {
					owner: tool.schema.string().describe("GitHub repository owner used for explorer_clone."),
					repo: tool.schema.string().describe("GitHub repository name used for explorer_clone."),
				},
				async execute(args) {
					try {
						const target = await resolveExplorerCloneTarget(args.owner, args.repo)
						const cleanupPath = await assertSafeCleanupTarget(target)
						await rm(cleanupPath, { recursive: true, force: false })

						return JSON.stringify({
							path: cleanupPath,
							owner: target.owner,
							repo: target.repo,
						})
					} catch (error) {
						return `Blocked: ${error instanceof Error ? error.message : String(error)}`
					}
				},
			}),
		},
	}
}

const ExplorerClonePluginWithInternals = Object.assign(ExplorerClonePlugin, {
	testInternals: {
		buildIsolatedGitEnv,
		buildSafeGitArgs,
		ensureSafeTempRoot,
		prepareGitExecutionContext,
		prepareIsolatedGitEnvironment,
		resolveExplorerTempRoot,
	},
} as const)

export default ExplorerClonePluginWithInternals

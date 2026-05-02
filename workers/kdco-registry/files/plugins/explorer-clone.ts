import { execFile } from "node:child_process"
import type { Stats } from "node:fs"
import { lstat, mkdir, realpath, rm } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { type Plugin, tool } from "@opencode-ai/plugin"

const execFileAsync = promisify(execFile)

const TEMP_ROOT_NAME = "kdco-flow"
const SAFE_GITHUB_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/

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

async function lstatIfExists(absolutePath: string): Promise<Stats | undefined> {
	try {
		return await lstat(absolutePath)
	} catch (error) {
		if (isNotFoundError(error)) return undefined

		throw error
	}
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
		await mkdir(requestedTempRoot, { recursive: false })
	}

	await assertExistingRealDirectory({ absolutePath: requestedTempRoot, kind: "explorer temp root" })
	return requestedTempRoot
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
	const requestedTempRoot = path.join(await realpath(os.tmpdir()), TEMP_ROOT_NAME)
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

async function runGit(args: readonly string[], cwd?: string): Promise<void> {
	await execFileAsync("git", [...args], {
		cwd,
		maxBuffer: 1024 * 1024 * 10,
		timeout: 120_000,
	})
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
	await runGit(["clone", "--", githubUrl, target.clonePath])

	await assertExistingRealDirectory({ absolutePath: target.clonePath, kind: "clone directory" })

	if (!request.ref) return

	await runGit(["fetch", "--depth", "1", "origin", request.ref], target.clonePath)
	await runGit(["checkout", "--detach", "FETCH_HEAD"], target.clonePath)
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

export default ExplorerClonePlugin

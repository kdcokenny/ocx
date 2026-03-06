import { randomUUID } from "node:crypto"
import {
	copyFile,
	cp,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	unlink,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative } from "node:path"
import { Glob } from "bun"
import { type ParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser"
import { z } from "zod"
import { findLocalConfigDir, OCX_CONFIG_FILE } from "../profile/paths"
import { ConfigError } from "../utils/errors"
import { validatePath } from "../utils/path-security"

export const OPENCODE_OVERLAY_SOURCE_SCOPES = ["agent", "agents", "skill", "skills"] as const
export const OPENCODE_MERGED_DIR_PREFIX = "ocx-oc-merged-"

export type OpencodeOcErrorClass = "read" | "parse" | "validate" | "copy" | "spawn" | "cleanup"

export function createOpencodeOcError(
	errorClass: OpencodeOcErrorClass,
	detail: string,
): ConfigError {
	return new ConfigError(`ocx oc ${errorClass} error: ${detail}`)
}

function formatUnknownError(error: unknown): string {
	if (error instanceof Error) {
		return error.message
	}

	return String(error)
}

function formatJsoncParseError(parseErrors: ParseError[]): string {
	if (parseErrors.length === 0) {
		return "Unknown parse error"
	}

	const firstError = parseErrors[0]
	if (!firstError) {
		return "Unknown parse error"
	}

	return `${printParseErrorCode(firstError.error)} at offset ${firstError.offset}`
}

function toPosixPath(pathValue: string): string {
	return pathValue.replaceAll("\\", "/")
}

function normalizeGlobPattern(pattern: string): string {
	return pattern.startsWith("./") ? pattern.slice(2) : pattern
}

function isPathWithin(parentPath: string, childPath: string): boolean {
	const relativePath = relative(parentPath, childPath)
	if (relativePath.length === 0) {
		return true
	}

	return !relativePath.startsWith("..") && !isAbsolute(relativePath)
}

export interface ProjectOverlayPolicy {
	include: string[]
	exclude: string[]
}

export interface OverlayCandidate {
	sourcePath: string
	overlayRelativePath: string
}

export interface OverlayCopyOperation {
	sourcePath: string
	destinationRelativePath: string
}

async function assertSafeOverlayDestinationPath(
	mergedConfigDir: string,
	destinationPath: string,
	destinationRelativePath: string,
): Promise<void> {
	const relativeDestinationPath = toPosixPath(relative(mergedConfigDir, destinationPath))
	const pathComponents = relativeDestinationPath
		.split("/")
		.filter((component) => component.length > 0)

	let currentPath = mergedConfigDir
	for (const component of pathComponents) {
		currentPath = join(currentPath, component)

		let currentStats: Awaited<ReturnType<typeof lstat>>
		try {
			currentStats = await lstat(currentPath)
		} catch (error) {
			const errorCode = (error as NodeJS.ErrnoException).code
			if (errorCode === "ENOENT") {
				return
			}

			throw createOpencodeOcError(
				"validate",
				`Failed to inspect overlay destination path (${destinationRelativePath}): ${formatUnknownError(error)}`,
			)
		}

		if (currentStats.isSymbolicLink()) {
			throw createOpencodeOcError(
				"validate",
				`Overlay destination path contains existing symlink (${destinationRelativePath})`,
			)
		}
	}
}

const projectOverlayPolicySchema = z
	.object({
		include: z.array(z.string()).optional(),
		exclude: z.array(z.string()).optional(),
	})
	.passthrough()

function validatePolicyPatterns(
	policyPath: string,
	field: "include" | "exclude",
	patterns: string[],
): void {
	for (const pattern of patterns) {
		try {
			new Glob(normalizeGlobPattern(pattern))
		} catch {
			throw createOpencodeOcError(
				"validate",
				`Invalid project overlay policy at ${policyPath}: ${field} contains invalid glob pattern "${pattern}"`,
			)
		}
	}
}

export async function loadProjectOverlayPolicy(
	localConfigDir: string | null,
): Promise<ProjectOverlayPolicy> {
	if (!localConfigDir) {
		return { include: [], exclude: [] }
	}

	const policyPath = join(localConfigDir, OCX_CONFIG_FILE)
	const policyReadPath = await resolveProjectOverlayPolicyReadPath(localConfigDir, policyPath)
	if (!policyReadPath) {
		return { include: [], exclude: [] }
	}

	let policyText: string
	try {
		policyText = await readFile(policyReadPath, "utf8")
	} catch (error) {
		throw createOpencodeOcError(
			"read",
			`Failed to read project overlay policy at ${policyPath}: ${formatUnknownError(error)}`,
		)
	}

	const parseErrors: ParseError[] = []
	const parsedPolicy = parseJsonc(policyText, parseErrors, { allowTrailingComma: true })
	if (parseErrors.length > 0) {
		throw createOpencodeOcError(
			"parse",
			`Failed to parse project overlay policy at ${policyPath}: ${formatJsoncParseError(parseErrors)}`,
		)
	}

	if (!parsedPolicy || typeof parsedPolicy !== "object" || Array.isArray(parsedPolicy)) {
		throw createOpencodeOcError(
			"validate",
			`Invalid project overlay policy at ${policyPath}: root must be an object`,
		)
	}

	const parsedResult = projectOverlayPolicySchema.safeParse(parsedPolicy)
	if (!parsedResult.success) {
		const firstIssue = parsedResult.error.issues[0]
		const issuePath = firstIssue?.path.length ? firstIssue.path.join(".") : "root"
		const issueMessage = firstIssue?.message ?? "Invalid project overlay policy"
		throw createOpencodeOcError(
			"validate",
			`Invalid project overlay policy at ${policyPath}: ${issuePath} ${issueMessage}`,
		)
	}

	const include = parsedResult.data.include ?? []
	const exclude = parsedResult.data.exclude ?? []

	validatePolicyPatterns(policyPath, "include", include)
	validatePolicyPatterns(policyPath, "exclude", exclude)

	return { include, exclude }
}

async function resolveProjectOverlayPolicyReadPath(
	localConfigDir: string,
	policyPath: string,
): Promise<string | null> {
	let policyStats: Awaited<ReturnType<typeof lstat>>
	try {
		policyStats = await lstat(policyPath)
	} catch (error) {
		const errorCode = (error as NodeJS.ErrnoException).code
		if (errorCode === "ENOENT" || errorCode === "ENOTDIR") {
			return null
		}

		throw createOpencodeOcError(
			"read",
			`Failed to inspect project overlay policy at ${policyPath}: ${formatUnknownError(error)}`,
		)
	}

	if (!policyStats.isSymbolicLink()) {
		return policyPath
	}

	let projectConfigRealPath: string
	try {
		projectConfigRealPath = await realpath(localConfigDir)
	} catch (error) {
		throw createOpencodeOcError(
			"validate",
			`Unable to resolve project config directory ${localConfigDir}: ${formatUnknownError(error)}`,
		)
	}

	let policyTargetRealPath: string
	try {
		policyTargetRealPath = await realpath(policyPath)
	} catch (error) {
		const errorCode = (error as NodeJS.ErrnoException).code
		if (errorCode === "ENOENT" || errorCode === "ENOTDIR") {
			throw createOpencodeOcError(
				"validate",
				`Broken symlink in project overlay policy: ${policyPath}`,
			)
		}

		throw createOpencodeOcError(
			"read",
			`Failed to inspect project overlay policy symlink at ${policyPath}: ${formatUnknownError(error)}`,
		)
	}

	if (!isPathWithin(projectConfigRealPath, policyTargetRealPath)) {
		throw createOpencodeOcError(
			"validate",
			`Symlink escapes project overlay policy scope: ${policyPath}`,
		)
	}

	return policyTargetRealPath
}

export function shouldIncludeOverlayPath(pathValue: string, policy: ProjectOverlayPolicy): boolean {
	for (const pattern of policy.include) {
		const glob = new Glob(normalizeGlobPattern(pattern))
		if (glob.match(pathValue)) {
			return true
		}
	}

	for (const pattern of policy.exclude) {
		const glob = new Glob(normalizeGlobPattern(pattern))
		if (glob.match(pathValue)) {
			return false
		}
	}

	return true
}

export function planOverlayCopyOperations(
	candidates: readonly OverlayCandidate[],
	policy: ProjectOverlayPolicy,
): OverlayCopyOperation[] {
	return candidates
		.filter((candidate) => shouldIncludeOverlayPath(candidate.overlayRelativePath, policy))
		.map((candidate) => ({
			sourcePath: candidate.sourcePath,
			destinationRelativePath: candidate.overlayRelativePath,
		}))
}

async function rejectSymlinkEntry(
	projectConfigRealPath: string,
	absolutePath: string,
	overlayRelativePath: string,
): Promise<never> {
	let targetRealPath: string
	try {
		targetRealPath = await realpath(absolutePath)
	} catch (error) {
		const errorCode = (error as NodeJS.ErrnoException).code
		if (errorCode === "ENOENT" || errorCode === "ENOTDIR") {
			throw createOpencodeOcError(
				"validate",
				`Broken symlink in project overlay scope: ${overlayRelativePath}`,
			)
		}

		throw createOpencodeOcError(
			"read",
			`Failed to inspect symlink at ${overlayRelativePath}: ${formatUnknownError(error)}`,
		)
	}

	if (!isPathWithin(projectConfigRealPath, targetRealPath)) {
		throw createOpencodeOcError(
			"validate",
			`Symlink escapes project overlay scope: ${overlayRelativePath}`,
		)
	}

	throw createOpencodeOcError(
		"validate",
		`Symlink entries are not supported in project overlay scope: ${overlayRelativePath}`,
	)
}

async function collectOverlayCandidatesFromPath(
	projectConfigRealPath: string,
	absPath: string,
	overlayRelativePath: string,
	collector: OverlayCandidate[],
): Promise<void> {
	let stats: Awaited<ReturnType<typeof lstat>>
	try {
		stats = await lstat(absPath)
	} catch (error) {
		throw createOpencodeOcError(
			"read",
			`Failed to inspect project overlay path ${overlayRelativePath}: ${formatUnknownError(error)}`,
		)
	}

	if (stats.isSymbolicLink()) {
		await rejectSymlinkEntry(projectConfigRealPath, absPath, overlayRelativePath)
	}

	if (stats.isDirectory()) {
		let children: string[]
		try {
			children = await readdir(absPath)
		} catch (error) {
			throw createOpencodeOcError(
				"read",
				`Failed to read project overlay directory ${overlayRelativePath}: ${formatUnknownError(error)}`,
			)
		}

		children.sort((left, right) => left.localeCompare(right))
		for (const childName of children) {
			const childAbsolutePath = join(absPath, childName)
			const childRelativePath = toPosixPath(join(overlayRelativePath, childName))
			await collectOverlayCandidatesFromPath(
				projectConfigRealPath,
				childAbsolutePath,
				childRelativePath,
				collector,
			)
		}
		return
	}

	if (!stats.isFile()) {
		return
	}

	collector.push({
		sourcePath: absPath,
		overlayRelativePath: toPosixPath(overlayRelativePath),
	})
}

async function collectOverlayCandidates(projectConfigDir: string): Promise<OverlayCandidate[]> {
	let projectConfigRealPath: string
	try {
		projectConfigRealPath = await realpath(projectConfigDir)
	} catch (error) {
		throw createOpencodeOcError(
			"validate",
			`Unable to resolve project config directory ${projectConfigDir}: ${formatUnknownError(error)}`,
		)
	}

	const candidates: OverlayCandidate[] = []
	for (const scope of OPENCODE_OVERLAY_SOURCE_SCOPES) {
		const scopeAbsolutePath = join(projectConfigDir, scope)

		let scopeStats: Awaited<ReturnType<typeof lstat>>
		try {
			scopeStats = await lstat(scopeAbsolutePath)
		} catch (error) {
			const errorCode = (error as NodeJS.ErrnoException).code
			if (errorCode === "ENOENT" || errorCode === "ENOTDIR") {
				continue
			}

			throw createOpencodeOcError(
				"read",
				`Failed to inspect project overlay scope ${scope}: ${formatUnknownError(error)}`,
			)
		}

		if (scopeStats.isSymbolicLink()) {
			await rejectSymlinkEntry(projectConfigRealPath, scopeAbsolutePath, scope)
		}

		await collectOverlayCandidatesFromPath(
			projectConfigRealPath,
			scopeAbsolutePath,
			scope,
			candidates,
		)
	}

	candidates.sort((left, right) =>
		left.overlayRelativePath.localeCompare(right.overlayRelativePath),
	)
	return candidates
}

export type OverlayAtomicPublisher = (sourcePath: string, destinationPath: string) => Promise<void>

export interface OverlayCopyOperationSeams {
	publishAtomically?: OverlayAtomicPublisher
}

function buildOverlayTempPublicationPath(destinationPath: string): string {
	const destinationDirPath = dirname(destinationPath)
	const destinationBaseName = basename(destinationPath)
	const atomicSuffix = `${process.pid}-${randomUUID()}`
	return join(destinationDirPath, `.${destinationBaseName}.ocx-tmp-${atomicSuffix}`)
}

async function publishOverlayFileAtomically(
	sourcePath: string,
	destinationPath: string,
): Promise<void> {
	const tempPublicationPath = buildOverlayTempPublicationPath(destinationPath)

	try {
		await copyFile(sourcePath, tempPublicationPath)
		await rename(tempPublicationPath, destinationPath)
	} catch (error) {
		try {
			await unlink(tempPublicationPath)
		} catch {
			// Ignore temp cleanup failures and preserve primary error.
		}

		throw error
	}
}

export async function applyOverlayCopyOperations(
	operations: readonly OverlayCopyOperation[],
	mergedConfigDir: string,
	seams: OverlayCopyOperationSeams = {},
): Promise<void> {
	const publishAtomically = seams.publishAtomically ?? publishOverlayFileAtomically

	for (const operation of operations) {
		let destinationPath: string
		try {
			destinationPath = validatePath(mergedConfigDir, operation.destinationRelativePath)
		} catch (error) {
			throw createOpencodeOcError(
				"validate",
				`Overlay destination path is invalid (${operation.destinationRelativePath}): ${formatUnknownError(error)}`,
			)
		}

		await assertSafeOverlayDestinationPath(
			mergedConfigDir,
			destinationPath,
			operation.destinationRelativePath,
		)

		try {
			await mkdir(dirname(destinationPath), { recursive: true })
			await publishAtomically(operation.sourcePath, destinationPath)
		} catch (error) {
			throw createOpencodeOcError(
				"copy",
				`Failed to copy overlay file ${operation.destinationRelativePath}: ${formatUnknownError(error)}`,
			)
		}
	}
}

async function copyProfileBaseToMergedDir(
	profileDir: string,
	mergedConfigDir: string,
): Promise<void> {
	let profileEntries: string[]
	try {
		profileEntries = await readdir(profileDir)
	} catch (error) {
		throw createOpencodeOcError(
			"copy",
			`Failed to read profile directory ${profileDir}: ${formatUnknownError(error)}`,
		)
	}

	for (const entryName of profileEntries) {
		const sourcePath = join(profileDir, entryName)
		const destinationPath = join(mergedConfigDir, entryName)

		try {
			await cp(sourcePath, destinationPath, { recursive: true, force: true, errorOnExist: false })
		} catch (error) {
			throw createOpencodeOcError(
				"copy",
				`Failed to copy profile base file ${entryName}: ${formatUnknownError(error)}`,
			)
		}
	}
}

export async function cleanupMergedConfigDir(mergedConfigDir: string): Promise<void> {
	try {
		await rm(mergedConfigDir, { recursive: true, force: true })
	} catch (error) {
		throw createOpencodeOcError(
			"cleanup",
			`Failed to remove temporary merged config directory ${mergedConfigDir}: ${formatUnknownError(error)}`,
		)
	}
}

interface PrepareMergedConfigDirOptions {
	projectDir: string
	profileDir: string
}

async function resolveProjectOverlayConfigDir(localConfigDir: string): Promise<string> {
	const projectRootDir = dirname(localConfigDir)

	let projectRealPath: string
	try {
		projectRealPath = await realpath(projectRootDir)
	} catch (error) {
		throw createOpencodeOcError(
			"validate",
			`Unable to resolve project directory ${projectRootDir}: ${formatUnknownError(error)}`,
		)
	}

	let localConfigRealPath: string
	try {
		localConfigRealPath = await realpath(localConfigDir)
	} catch (error) {
		throw createOpencodeOcError(
			"validate",
			`Unable to resolve project config directory ${localConfigDir}: ${formatUnknownError(error)}`,
		)
	}

	if (!isPathWithin(projectRealPath, localConfigRealPath)) {
		throw createOpencodeOcError(
			"validate",
			`Project .opencode root resolves outside project directory: ${localConfigDir}`,
		)
	}

	return localConfigRealPath
}

export interface PreparedMergedConfigDir {
	path: string
	cleanup: () => Promise<void>
}

function toPrimaryPrepareError(error: unknown): ConfigError {
	if (error instanceof ConfigError) {
		return error
	}

	return createOpencodeOcError(
		"copy",
		`Failed to prepare temporary merged config directory: ${formatUnknownError(error)}`,
	)
}

export async function prepareMergedConfigDirForProfile(
	options: PrepareMergedConfigDirOptions,
): Promise<PreparedMergedConfigDir> {
	const localConfigDir = findLocalConfigDir(options.projectDir)
	let mergedConfigDir: string | null = null

	try {
		mergedConfigDir = await mkdtemp(join(tmpdir(), OPENCODE_MERGED_DIR_PREFIX))

		await copyProfileBaseToMergedDir(options.profileDir, mergedConfigDir)

		if (localConfigDir) {
			const projectOverlayConfigDir = await resolveProjectOverlayConfigDir(localConfigDir)
			const policy = await loadProjectOverlayPolicy(projectOverlayConfigDir)
			const candidates = await collectOverlayCandidates(projectOverlayConfigDir)
			const copyPlan = planOverlayCopyOperations(candidates, policy)
			await applyOverlayCopyOperations(copyPlan, mergedConfigDir)
		}

		const preparedPath = mergedConfigDir
		return {
			path: preparedPath,
			cleanup: () => cleanupMergedConfigDir(preparedPath),
		}
	} catch (error) {
		const primaryError = toPrimaryPrepareError(error)

		if (mergedConfigDir) {
			try {
				await cleanupMergedConfigDir(mergedConfigDir)
			} catch (cleanupError) {
				primaryError.message = `${primaryError.message}\nCleanup warning: ${formatUnknownError(cleanupError)}`
			}
		}

		throw primaryError
	}
}

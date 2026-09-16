import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { atomicWrite } from "../profile/atomic"
import { withProfileLock } from "../profile/lock"
import { getProfilesDir, profileNameSchema } from "../profile/paths"
import { withDirectoryLock } from "./directory-lock"
import { ConflictError, ProfileNotFoundError, ValidationError } from "./errors"
import { logger } from "./logger"
import { validatePath } from "./path-security"
import { hashContent } from "./receipt"

/** Reject symlink traversal, including dangling links, before reading or changing owned files. */
export async function safeFilePath(root: string, path: string): Promise<string> {
	try {
		const info = await lstat(root)
		if (!info.isDirectory() || info.isSymbolicLink())
			throw new ValidationError(`Managed root must be a real directory: ${root}`)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
	const absolute = validatePath(root, path)
	const segments = relative(resolve(root), absolute).split(/[\\/]/)
	if (!path || segments.length === 0 || segments[0] === "")
		throw new ValidationError("A file path cannot name the installation root")
	let current = resolve(root)
	for (let index = 0; index < segments.length; index++) {
		current = join(current, segments[index] as string)
		try {
			const info = await lstat(current)
			if (info.isSymbolicLink())
				throw new ValidationError(`Refusing symlink in managed path: ${current}`)
			if (index < segments.length - 1 && !info.isDirectory())
				throw new ValidationError(`Expected a directory: ${current}`)
			if (index === segments.length - 1 && !info.isFile())
				throw new ValidationError(`Expected a regular file: ${current}`)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") break
			throw error
		}
	}
	return absolute
}

export async function readManagedFile(root: string, path: string): Promise<Buffer | null> {
	const absolute = await safeFilePath(root, path)
	try {
		return await readFile(absolute)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
		throw error
	}
}

export interface FileChange {
	path: string
	content: Buffer | null
	/** Hash observed during planning, or null for a missing file. */
	beforeHash: string | null
}

/** Do not let clearing a stale lock hide a partially applied operation. */
export async function assertNoInterruptedTransaction(root: string): Promise<void> {
	await safeFilePath(root, ".ocx/recovery-check")
	let names: string[]
	try {
		names = await readdir(join(root, ".ocx"))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return
		throw error
	}
	for (const name of names.filter((name) => name.startsWith("transaction-"))) {
		const path = `.ocx/${name}/manifest.json`
		const bytes = await readManagedFile(root, path)
		let complete = false
		try {
			complete = bytes !== null && JSON.parse(bytes.toString()).complete === true
		} catch {
			/* An unreadable journal requires recovery too. */
		}
		if (!complete)
			throw new ConflictError(
				`Interrupted operation at ${join(root, ".ocx", name)}. Restore files using its manifest.json and *.original backups before removing this directory and retrying. See the OCX V2 recovery guide.`,
			)
	}
}

export async function withInstallLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
	const run = async () => {
		await assertNoInterruptedTransaction(root)
		return operation()
	}
	const profileName = relative(getProfilesDir(), resolve(root))
	if (profileNameSchema.safeParse(profileName).success)
		return withProfileLock(profileName, async () => {
			// A rename/removal between destination resolution and lock acquisition must not recreate it.
			try {
				await lstat(root)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT")
					throw new ProfileNotFoundError(profileName)
				throw error
			}
			return run()
		})
	await safeFilePath(root, ".ocx/operation.lock/owner")
	const metadata = join(root, ".ocx")
	await mkdir(metadata, { recursive: true })
	const lock = join(metadata, "operation.lock")
	return withDirectoryLock(lock, `Another OCX operation is using ${root}.`, run)
}

/** Apply owned files and the receipt as one rollback unit. The receipt must be last. */
export async function applyFileChanges(
	root: string,
	changes: FileChange[],
	beforeWrite?: (index: number) => Promise<void>,
): Promise<void> {
	if (changes.length === 0) return
	await safeFilePath(root, ".ocx/staging-check")
	const seen = new Set<string>()
	for (const change of changes) {
		const target = await safeFilePath(root, change.path)
		if (seen.has(target)) throw new ConflictError(`Duplicate transaction target: ${change.path}`)
		seen.add(target)
	}
	await mkdir(join(root, ".ocx"), { recursive: true })
	const stage = await mkdtemp(join(root, ".ocx", "transaction-"))
	const applied: { path: string; backup: string | null; afterHash: string | null }[] = []
	let preserveBackups = false
	try {
		const journal = {
			complete: false,
			files: changes.map((change, index) => ({
				path: change.path,
				beforeHash: change.beforeHash,
				afterHash: change.content === null ? null : hashContent(change.content),
				backup: change.beforeHash === null ? null : `${index}.original`,
			})),
		}
		await writeFile(join(stage, "manifest.json"), JSON.stringify(journal, null, 2), { mode: 0o600 })
		for (const [index, change] of changes.entries()) {
			await beforeWrite?.(index)
			const target = await safeFilePath(root, change.path)
			const existing = await readManagedFile(root, change.path)
			if ((existing === null ? null : hashContent(existing)) !== change.beforeHash)
				throw new ConflictError(
					`File changed while OCX was preparing the operation: ${change.path}`,
				)
			await mkdir(dirname(target), { recursive: true })
			const backup = existing === null ? null : join(stage, `${index}.original`)
			if (backup) await rename(target, backup)
			const appliedFile = { path: change.path, backup, afterHash: null as string | null }
			applied.push(appliedFile)
			if (change.content !== null) {
				const temporary = join(stage, `${index}.new`)
				await writeFile(temporary, change.content, { mode: 0o600, flag: "wx" })
				await rename(temporary, target)
				appliedFile.afterHash = hashContent(change.content)
			}
		}
		await atomicWrite(join(stage, "manifest.json"), { ...journal, complete: true })
	} catch (error) {
		const failures: unknown[] = []
		for (const item of applied.reverse()) {
			try {
				const target = await safeFilePath(root, item.path)
				const current = await readManagedFile(root, item.path)
				if ((current === null ? null : hashContent(current)) !== item.afterHash)
					throw new ConflictError(
						`File changed after installation; preserving it and recovery backups: ${item.path}`,
					)
				await rm(target, { force: true })
				if (item.backup) await rename(item.backup, target)
			} catch (rollbackError) {
				failures.push(rollbackError)
			}
		}
		if (failures.length > 0) {
			preserveBackups = true
			throw new AggregateError(
				[error, ...failures],
				`Rollback was incomplete. Original files remain at ${stage}.`,
			)
		}
		throw error
	} finally {
		if (!preserveBackups)
			await rm(stage, { recursive: true, force: true }).catch((error) =>
				logger.warn(`Could not remove transaction staging directory ${stage}: ${error}`),
			)
	}
}

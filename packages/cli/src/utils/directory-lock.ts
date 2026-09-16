import { randomUUID } from "node:crypto"
import { lstat, mkdir, readdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import { dirname, join } from "node:path"
import { ConflictError } from "./errors"
import { logger } from "./logger"

/** Only reclaim a positively identified, dead local owner; unknown locks stay explicit. */
async function reclaimDeadOwner(lock: string): Promise<boolean> {
	try {
		const info = await lstat(lock)
		if (!info.isDirectory() || info.isSymbolicLink()) return false
		const entries = await readdir(lock)
		if (entries.length !== 1 || !/^[a-f0-9-]{36}$/.test(entries[0] ?? "")) return false
		const file = join(lock, entries[0] as string)
		const owner = JSON.parse(await readFile(file, "utf8"))
		if (owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0)
			return false
		try {
			process.kill(owner.pid, 0)
			return false
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false
		}
		await unlink(file)
		await rmdir(lock)
		return true
	} catch {
		return false
	}
}

/** Fail immediately when occupied; release only this acquisition's owner file. */
export async function withDirectoryLock<T>(
	lock: string,
	message: string,
	operation: () => Promise<T>,
	options: { recoverDeadOwner?: boolean } = {},
): Promise<T> {
	await mkdir(dirname(lock), { recursive: true, mode: 0o700 })
	try {
		await mkdir(lock, { mode: 0o700 })
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
		if (options.recoverDeadOwner && (await reclaimDeadOwner(lock)))
			return withDirectoryLock(lock, message, operation)
		throw new ConflictError(
			`${message} If no operation is running, remove the stale lock at ${lock}.`,
		)
	}
	const owner = join(lock, randomUUID())
	try {
		await writeFile(owner, JSON.stringify({ pid: process.pid, host: hostname() }), {
			flag: "wx",
			mode: 0o600,
		})
	} catch (error) {
		// An incomplete owner file is ours; never recursively remove another acquisition.
		await unlink(owner).catch(() => {})
		await rmdir(lock).catch(() => {})
		throw error
	}
	try {
		return await operation()
	} finally {
		try {
			await unlink(owner)
			// Never recursively delete a replacement owner's lock.
			await rmdir(lock)
		} catch (error) {
			if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? ""))
				logger.warn(`Could not release lock ${lock}: ${error}`)
		}
	}
}

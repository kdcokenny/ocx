import { randomUUID } from "node:crypto"
import { mkdir, rmdir, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { ConflictError } from "./errors"
import { logger } from "./logger"

/** Fail immediately when occupied; release only this acquisition's owner file. */
export async function withDirectoryLock<T>(
	lock: string,
	message: string,
	operation: () => Promise<T>,
): Promise<T> {
	await mkdir(dirname(lock), { recursive: true, mode: 0o700 })
	try {
		await mkdir(lock, { mode: 0o700 })
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
		throw new ConflictError(
			`${message} If no operation is running, remove the stale lock at ${lock}.`,
		)
	}
	const owner = join(lock, randomUUID())
	await writeFile(owner, String(process.pid), { flag: "wx", mode: 0o600 })
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

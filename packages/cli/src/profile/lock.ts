import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { ConflictError } from "../utils/errors"
import { getProfilesDir, profileNameSchema } from "./paths"

/** Serialize OCX operations on a profile; interrupted operations leave an explicit lock. */
export async function withProfileLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
	profileNameSchema.parse(name)
	const locks = join(getProfilesDir(), ".locks")
	await mkdir(locks, { recursive: true, mode: 0o700 })
	const lock = join(locks, name)
	try {
		await mkdir(lock, { mode: 0o700 })
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
		throw new ConflictError(
			`Profile "${name}" is busy. If no OCX command is running, remove the stale lock at ${lock}.`,
		)
	}
	try {
		return await operation()
	} finally {
		await rm(lock, { recursive: true })
	}
}

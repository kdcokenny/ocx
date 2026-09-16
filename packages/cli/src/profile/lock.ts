import { lstat } from "node:fs/promises"
import { join } from "node:path"
import { withDirectoryLock } from "../utils/directory-lock"
import { ConfigError } from "../utils/errors"
import { getGlobalOcxRoot, getProfilesDir, profileNameSchema } from "./paths"

export async function realDirectoryExists(path: string): Promise<boolean> {
	try {
		const info = await lstat(path)
		if (!info.isDirectory() || info.isSymbolicLink())
			throw new ConfigError(`Managed path must be a real directory: ${path}`)
		return true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
		throw error
	}
}

export async function assertProfileRoots(): Promise<void> {
	for (const path of [getGlobalOcxRoot(), getProfilesDir(), join(getProfilesDir(), ".locks")])
		await realDirectoryExists(path)
}

/** Serialize OCX operations on a profile; interrupted operations leave an explicit lock. */
export async function withProfileLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
	profileNameSchema.parse(name)
	await assertProfileRoots()
	const locks = join(getProfilesDir(), ".locks")
	const lock = join(locks, name)
	return withDirectoryLock(lock, `Profile "${name}" is busy.`, operation)
}

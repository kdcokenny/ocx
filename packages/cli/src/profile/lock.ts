import { join } from "node:path"
import { withDirectoryLock } from "../utils/directory-lock"
import { getProfilesDir, profileNameSchema } from "./paths"

/** Serialize OCX operations on a profile; interrupted operations leave an explicit lock. */
export async function withProfileLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
	profileNameSchema.parse(name)
	const locks = join(getProfilesDir(), ".locks")
	const lock = join(locks, name)
	return withDirectoryLock(lock, `Profile "${name}" is busy.`, operation)
}

import { lstat, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { atomicWrite } from "../profile/atomic"
import { withDirectoryLock } from "./directory-lock"
import { ConflictError } from "./errors"

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path)
		return true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
		throw error
	}
}

async function directoryExists(path: string): Promise<boolean> {
	try {
		const info = await lstat(path)
		if (!info.isDirectory() || info.isSymbolicLink())
			throw new ConflictError(`Publication path must be a real directory: ${path}`)
		return true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
		throw error
	}
}

/** Prepare a complete build, preserving the previous output across failures and process exits.
 * Re-running publication recovers its journal. Serve immutable deployments, not this build directory.
 */
export async function publishDirectory(
	output: string,
	populate: (candidate: string) => Promise<void>,
	afterBackup?: () => Promise<void>,
): Promise<void> {
	const out = resolve(output)
	const parent = dirname(out)
	const prefix = `.${basename(out)}.ocx-publish-`
	const journal = `${out}.ocx-publication.json`
	await withDirectoryLock(
		`${out}.ocx-publication.lock`,
		`Publication of ${out} is busy.`,
		async () => {
			const recover = async () => {
				if (!(await exists(journal))) return
				const journalInfo = await lstat(journal)
				if (!journalInfo.isFile() || journalInfo.isSymbolicLink())
					throw new ConflictError(`Publication journal must be a regular file: ${journal}`)
				const record: unknown = JSON.parse(await readFile(journal, "utf8"))
				if (
					!record ||
					typeof record !== "object" ||
					!("stage" in record) ||
					typeof record.stage !== "string" ||
					dirname(record.stage) !== parent ||
					!basename(record.stage).startsWith(prefix)
				)
					throw new ConflictError(`Invalid publication journal: ${journal}`)
				const stage = record.stage
				if (!(await directoryExists(stage)))
					throw new ConflictError(`Publication stage is missing; recover ${journal} manually`)
				const backup = join(stage, "previous")
				const hasBackup = await directoryExists(backup)
				const hasCandidate = await directoryExists(join(stage, "candidate"))
				const hasOutput = await directoryExists(out)
				if (hasBackup) {
					if (!hasOutput) await rename(backup, out)
					else if (hasCandidate)
						throw new ConflictError(
							`Output changed during interrupted publication; recover ${journal} manually`,
						)
				}
				await rm(stage, { recursive: true, force: true })
				await rm(journal)
			}
			await recover()
			await directoryExists(out)
			const stage = await mkdtemp(join(parent, prefix))
			const candidate = join(stage, "candidate")
			let journaled = false
			try {
				await atomicWrite(journal, { stage })
				journaled = true
				await mkdir(candidate)
				await populate(candidate)
				if (await exists(out)) await rename(out, join(stage, "previous"))
				await afterBackup?.()
				await rename(candidate, out)
				await recover()
			} catch (error) {
				if (journaled) {
					try {
						await recover()
					} catch (recoveryError) {
						throw new AggregateError(
							[error, recoveryError],
							`Publication recovery required: ${journal}`,
						)
					}
				} else await rm(stage, { recursive: true, force: true })
				throw error
			}
		},
		{ recoverDeadOwner: true },
	)
}

import { createHash, randomUUID } from "node:crypto"
import {
	chmod,
	cp,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export function mergedCacheRoot(cacheHome = process.env.XDG_CACHE_HOME): string {
	const base = cacheHome && isAbsolute(cacheHome) ? cacheHome : join(homedir(), ".cache")
	return join(base, "ocx", "opencode", "v1")
}

export async function identifyOpenCode(executable: string): Promise<string> {
	const resolved = await realpath(executable)
	const bytes = await readFile(resolved)
	const digest = createHash("sha256").update(bytes).digest("hex")
	try {
		const proc = Bun.spawn([resolved, "--version"], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
			timeout: 5000,
			killSignal: "SIGKILL",
		})
		const version = (await new Response(proc.stdout).text()).trim()
		if ((await proc.exited) === 0 && version) {
			return JSON.stringify([resolved, digest, version])
		}
	} catch {
		// Custom launchers need not implement --version. The real launch determines success.
	}
	// Without a version, an unchanged wrapper may select a different OpenCode install.
	// Allow the launch, but avoid reusing potentially incompatible dependency outputs.
	return JSON.stringify([resolved, digest, null, randomUUID()])
}

// Profile links are trusted inputs, but cached outputs must never write through them.
// Run after overlay validation so links still cannot bypass its destination restrictions.
async function snapshotProfileLinks(root: string): Promise<void> {
	for (const name of await readdir(root)) {
		const entry = join(root, name)
		const stats = await lstat(entry)
		if (stats.isSymbolicLink()) {
			const snapshot = join(root, `.snapshot-${randomUUID()}`)
			await cp(entry, snapshot, {
				recursive: true,
				dereference: true,
				filter: (source) => source.split(/[\\/]/).at(-1) !== "node_modules",
			})
			await rm(entry)
			await rename(snapshot, entry)
		} else if (stats.isDirectory()) {
			await snapshotProfileLinks(entry)
		}
	}
}

async function fingerprintTree(root: string): Promise<string> {
	const hash = createHash("sha256")
	async function visit(relativePath: string): Promise<void> {
		const absolutePath = join(root, relativePath)
		const stats = await lstat(absolutePath)
		hash.update(JSON.stringify([relativePath, stats.mode]))
		if (stats.isSymbolicLink()) {
			throw new Error(`Profile snapshot contains a symlink: ${relativePath}`)
		} else if (stats.isDirectory()) {
			for (const name of (await readdir(absolutePath)).sort()) await visit(join(relativePath, name))
		} else if (stats.isFile()) {
			hash.update(
				createHash("sha256")
					.update(await readFile(absolutePath))
					.digest(),
			)
		} else {
			throw new Error(`Unsupported profile entry: ${relativePath}`)
		}
	}
	await visit("")
	return hash.digest("hex")
}

async function claim(slot: string): Promise<boolean> {
	const owner = join(slot, `.owner-${randomUUID()}`)
	const lease = join(slot, "lease")
	try {
		await mkdir(owner, { mode: 0o700 })
		await writeFile(join(owner, "pid"), String(process.pid), { mode: 0o600, flag: "wx" })
		// Publishing a nonempty directory is atomic and cannot replace another lease.
		// Unlike hard links, directory rename also works on FAT/exFAT filesystems.
		await rename(owner, lease)
		return true
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (
			code === "EEXIST" ||
			code === "ENOTEMPTY" ||
			code === "ENOENT" ||
			code === "ENOTDIR" ||
			code === "EISDIR"
		)
			return false
		// Windows can report EPERM for an existing destination. Old cache leases
		// were regular files, which some platforms report as ENOTDIR/EISDIR.
		if (code === "EPERM") {
			try {
				await lstat(lease)
				return false
			} catch (inspectError) {
				if ((inspectError as NodeJS.ErrnoException).code !== "ENOENT") throw inspectError
				// The owner may have released the lease after our rename failed.
				return false
			}
		}
		throw error
	} finally {
		await rm(owner, { recursive: true, force: true })
	}
}

async function createLeasedSlot(generation: string): Promise<string> {
	const id = randomUUID()
	const pending = join(generation, `.slot-${id}`)
	const published = join(generation, `slot-${id}`)
	await mkdir(pending, { mode: 0o700 })
	try {
		if (!(await claim(pending))) throw new Error("Unable to claim a new cache slot")
		// Other launchers must not see a new slot until its creator holds the lease.
		await rename(pending, published)
		return published
	} catch (error) {
		await rm(pending, { recursive: true, force: true })
		throw error
	}
}

async function releaseLease(slot: string): Promise<void> {
	const retired = join(slot, `.owner-${randomUUID()}`)
	// Unpublish the entire lease before removing pid; otherwise another claimant
	// could replace the briefly empty directory midway through recursive removal.
	await rename(join(slot, "lease"), retired)
	await rm(retired, { recursive: true, force: true })
}

async function readLeasePid(slot: string): Promise<number> {
	const lease = join(slot, "lease")
	const stats = await lstat(lease)
	const ownerFile = stats.isDirectory() ? join(lease, "pid") : lease
	return Number(await readFile(ownerFile, "utf8"))
}

async function pruneIfDue(identityRoot: string): Promise<void> {
	const stamp = join(identityRoot, ".pruned-at")
	try {
		if (Date.now() - (await lstat(stamp)).mtimeMs < PRUNE_INTERVAL_MS) return
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
	// Simultaneous cold launches may both prune. Slot claims and atomic removal
	// coordinate them; a crashed sweep leaves no stamp and is retried next launch.
	await prune(identityRoot)
	await writeFile(stamp, "", { mode: 0o600 })
}

async function prune(identityRoot: string): Promise<void> {
	for (const generation of await readdir(identityRoot)) {
		const generationPath = join(identityRoot, generation)
		if (!(await lstat(generationPath)).isDirectory()) continue
		for (const name of await readdir(generationPath)) {
			if (name.startsWith(".pruned-")) {
				await rm(join(generationPath, name), { recursive: true, force: true })
				continue
			}
			if (!name.startsWith("slot-") && !name.startsWith(".slot-")) continue
			const slot = join(generationPath, name)
			const metadata = join(slot, "metadata.json")
			try {
				let modified: number
				try {
					modified = (await lstat(metadata)).mtimeMs
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
					try {
						modified = (await lstat(join(slot, "lease"))).mtimeMs
					} catch (leaseError) {
						if ((leaseError as NodeJS.ErrnoException).code !== "ENOENT") throw leaseError
						modified = (await lstat(slot)).mtimeMs
					}
				}
				if (Date.now() - modified < RETENTION_MS) continue
				if (!(await claim(slot))) {
					const pid = await readLeasePid(slot)
					if (!Number.isInteger(pid) || pid <= 0) continue
					try {
						process.kill(pid, 0)
						continue
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue
					}
					// Abandoned leases are never reused, so no new launcher can own this slot.
				}
				// Hide the entire slot before unlinking its lease. Otherwise a launcher
				// could claim it midway through recursive deletion.
				const discarded = join(generationPath, `.pruned-${randomUUID()}`)
				await rename(slot, discarded)
				await rm(discarded, { recursive: true, force: true })
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			}
		}
	}
}

export async function publishMergedConfig(options: {
	stagedConfig: string
	cacheRoot: string
	identity: unknown
	inputs: unknown
}): Promise<{ path: string; cleanup: () => Promise<void> }> {
	await snapshotProfileLinks(options.stagedConfig)
	const identity = createHash("sha256").update(JSON.stringify(options.identity)).digest("hex")
	const fingerprint = createHash("sha256")
		.update(
			JSON.stringify([
				options.inputs,
				process.platform,
				process.arch,
				await fingerprintTree(options.stagedConfig),
			]),
		)
		.digest("hex")
	const identityRoot = join(options.cacheRoot, identity)
	const generation = join(identityRoot, fingerprint)
	await mkdir(generation, { recursive: true, mode: 0o700 })
	await pruneIfDue(identityRoot)
	const freshSlot = `slot-${randomUUID()}`
	const candidates = (await readdir(generation)).filter((name) => name.startsWith("slot-")).sort()
	candidates.push(freshSlot)
	for (const name of candidates) {
		let slot: string
		if (name === freshSlot) {
			slot = await createLeasedSlot(generation)
		} else {
			slot = join(generation, name)
			// Never recreate a pruned slot: concurrent pruners may still refer to its old path.
			if (!(await claim(slot))) continue
		}
		const config = join(slot, "config")
		try {
			try {
				await lstat(config)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
				// The lease is also the materialization lock. Only complete trees are published.
				await rename(options.stagedConfig, config)
			}
			await writeFile(
				join(slot, "metadata.json"),
				JSON.stringify({ fingerprint, prepared: true }),
				{ mode: 0o600 },
			)
			let released = false
			return {
				path: config,
				cleanup: async () => {
					if (released) return
					released = true
					await releaseLease(slot)
				},
			}
		} catch (error) {
			await releaseLease(slot)
			throw error
		}
	}
	throw new Error("Unable to lease a merged configuration slot")
}

export async function createCacheStaging(cacheRoot: string): Promise<string> {
	await mkdir(cacheRoot, { recursive: true, mode: 0o700 })
	if (!(await lstat(cacheRoot)).isDirectory())
		throw new Error(`Cache root must be a real directory: ${cacheRoot}`)
	await chmod(cacheRoot, 0o700)
	for (const name of await readdir(cacheRoot)) {
		const match = /^\.staging-(\d+)-/.exec(name)
		if (!match) continue
		const abandoned = join(cacheRoot, name)
		try {
			if (Date.now() - (await lstat(abandoned)).mtimeMs < RETENTION_MS) continue
			try {
				process.kill(Number(match[1]), 0)
				continue
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue
			}
			await rm(abandoned, { recursive: true, force: true })
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		}
	}
	const staging = join(cacheRoot, `.staging-${process.pid}-${randomUUID()}`)
	await mkdir(staging, { mode: 0o700 })
	return staging
}

import { createHash, randomUUID } from "node:crypto"
import {
	chmod,
	cp,
	link,
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

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export function mergedCacheRoot(cacheHome = process.env.XDG_CACHE_HOME): string {
	const base = cacheHome && isAbsolute(cacheHome) ? cacheHome : join(homedir(), ".cache")
	return join(base, "ocx", "opencode", "v1")
}

export async function identifyOpenCode(executable: string): Promise<string> {
	const resolved = await realpath(executable)
	const bytes = await readFile(resolved)
	const proc = Bun.spawn([resolved, "--version"], {
		stdout: "pipe",
		stderr: "ignore",
		timeout: 5000,
	})
	const version = await new Response(proc.stdout).text()
	if ((await proc.exited) !== 0) throw new Error(`Unable to identify OpenCode version: ${resolved}`)
	return JSON.stringify([
		resolved,
		createHash("sha256").update(bytes).digest("hex"),
		version.trim(),
	])
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
	try {
		await writeFile(owner, String(process.pid), { mode: 0o600, flag: "wx" })
		// A hard link publishes the owner atomically on POSIX and Windows.
		await link(owner, join(slot, "lease"))
		return true
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (code === "EEXIST" || code === "ENOENT") return false
		throw error
	} finally {
		await rm(owner, { force: true })
	}
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
			if (!name.startsWith("slot-")) continue
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
					const pid = Number(await readFile(join(slot, "lease"), "utf8"))
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
	await prune(identityRoot)
	const freshSlot = `slot-${randomUUID()}`
	const candidates = (await readdir(generation)).filter((name) => name.startsWith("slot-")).sort()
	candidates.push(freshSlot)
	for (const name of candidates) {
		const slot = join(generation, name)
		// Never recreate a pruned slot: concurrent pruners may still refer to its old path.
		if (name === freshSlot) await mkdir(slot, { mode: 0o700 })
		if (!(await claim(slot))) continue
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
					await rm(join(slot, "lease"), { force: true })
				},
			}
		} catch (error) {
			await rm(join(slot, "lease"), { force: true })
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

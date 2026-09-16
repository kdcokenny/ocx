import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { publishDirectory } from "../packages/cli/src/utils/publish-directory"
import manifest from "./manifest.json"

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

/** Restore verified built V1 assets. Never rebuild these with the V2-only CLI. */
export async function restoreLegacyRegistry(
	name: keyof typeof manifest.registries,
	output: string,
): Promise<void> {
	const snapshot = manifest.registries[name]
	const archive = join(import.meta.dir, snapshot.archive)
	if (digest(await readFile(archive)) !== snapshot.sha256)
		throw new Error(`Legacy archive checksum mismatch: ${name}`)
	await publishDirectory(output, async (stage) => {
		const listing = Bun.spawn(["tar", "-tzf", archive], { stdout: "pipe", stderr: "pipe" })
		const [list, listError, listCode] = await Promise.all([
			new Response(listing.stdout).text(),
			new Response(listing.stderr).text(),
			listing.exited,
		])
		if (listCode !== 0) throw new Error(`Cannot inspect ${archive}: ${listError}`)
		const paths = list.trim().split("\n").sort()
		if (JSON.stringify(paths) !== JSON.stringify(Object.keys(snapshot.files).sort()))
			throw new Error(`Unexpected paths in legacy archive: ${name}`)
		const extraction = Bun.spawn(["tar", "-xzf", archive, "-C", stage], {
			stdout: "ignore",
			stderr: "pipe",
		})
		const [error, code] = await Promise.all([
			new Response(extraction.stderr).text(),
			extraction.exited,
		])
		if (code !== 0) throw new Error(`Cannot restore ${name}: ${error}`)
		for (const [path, expected] of Object.entries(snapshot.files)) {
			if (digest(await readFile(join(stage, path))) !== expected)
				throw new Error(`Legacy file checksum mismatch: ${name}/${path}`)
		}
	})
}

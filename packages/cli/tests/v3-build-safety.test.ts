import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { REGISTRY_SCHEMA_LATEST_URL } from "../src/constants"
import { buildRegistry } from "../src/lib/build-registry"

let root: string
let source: string
let out: string
const manifest = {
	$schema: REGISTRY_SCHEMA_LATEST_URL,
	name: "Test",
	version: "1.2.3",
	author: "Test",
	components: [
		{ name: "asset", type: "skill", description: "Binary asset", files: ["skills/data.bin"] },
	],
}
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "ocx-build-safe-"))
	source = join(root, "source")
	out = join(root, "published")
	await mkdir(join(source, "files/skills"), { recursive: true })
	await mkdir(out)
	await writeFile(join(out, "previous"), "previous")
	await writeFile(join(source, "registry.jsonc"), JSON.stringify(manifest))
	await writeFile(join(source, "files/skills/data.bin"), Buffer.from([0, 255, 128]))
})
afterEach(async () => {
	await rm(root, { recursive: true, force: true })
})
test("publishes binary bytes and component versions, replacing obsolete output", async () => {
	await buildRegistry({ source, out, dryRun: true })
	expect(await readFile(join(out, "previous"), "utf8")).toBe("previous")
	await buildRegistry({ source, out })
	expect(await Bun.file(join(out, "previous")).exists()).toBe(false)
	expect(await readFile(join(out, "components/asset/skills/data.bin"))).toEqual(
		Buffer.from([0, 255, 128]),
	)
	expect((await Bun.file(join(out, "components/asset.json")).json())["dist-tags"].latest).toBe(
		"1.2.3",
	)
})
test("syntax errors and missing sources leave previously published output intact", async () => {
	await writeFile(join(source, "registry.jsonc"), `${JSON.stringify(manifest)} trailing`)
	await expect(buildRegistry({ source, out })).rejects.toThrow()
	expect(await readFile(join(out, "previous"), "utf8")).toBe("previous")
	await writeFile(join(source, "registry.jsonc"), JSON.stringify(manifest))
	await rm(join(source, "files/skills/data.bin"))
	await expect(buildRegistry({ source, out })).rejects.toThrow()
	expect(await readFile(join(out, "previous"), "utf8")).toBe("previous")
})
test("refuses symlink sources and output directories, and never replaces its own source", async () => {
	await rm(join(source, "files/skills/data.bin"))
	await symlink(join(out, "previous"), join(source, "files/skills/data.bin"))
	await expect(buildRegistry({ source, out })).rejects.toThrow()
	await rm(join(source, "files/skills/data.bin"))
	await writeFile(join(source, "files/skills/data.bin"), "safe")
	await symlink(out, join(root, "link"))
	await expect(buildRegistry({ source, out: join(root, "link") })).rejects.toThrow("real directory")
	await expect(buildRegistry({ source, out: source })).rejects.toThrow("must not contain")
	await expect(buildRegistry({ source, out: root })).rejects.toThrow("must not contain")
	expect(await readFile(join(out, "previous"), "utf8")).toBe("previous")
})

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { lstat, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import WorktreePlugin from "../files/plugins/worktree"

const { copyFiles, symlinkDirs } = WorktreePlugin.testInternals

const log = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
}

let testDir: string

beforeEach(async () => {
	testDir = await mkdtemp(path.join(os.tmpdir(), "worktree-sync-security-"))
})

afterEach(async () => {
	await rm(testDir, { recursive: true, force: true })
})

async function writeText(filePath: string, content: string): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true })
	await Bun.write(filePath, content)
}

describe("worktree sync path containment", () => {
	it("does not copy files from source paths that resolve outside the source worktree", async () => {
		const sourceDir = path.join(testDir, "source")
		const targetDir = path.join(testDir, "target")
		const externalDir = path.join(testDir, "external-source")
		await writeText(path.join(sourceDir, ".keep"), "")
		await writeText(path.join(targetDir, ".keep"), "")
		await writeText(path.join(externalDir, ".env"), "external secret")
		await symlink(externalDir, path.join(sourceDir, "secrets"), "dir")

		await copyFiles(sourceDir, targetDir, ["secrets/.env"], log)

		expect(await Bun.file(path.join(targetDir, "secrets", ".env")).exists()).toBe(false)
	})

	it("does not copy files through symlinked target parents outside the target worktree", async () => {
		const sourceDir = path.join(testDir, "source")
		const targetDir = path.join(testDir, "target")
		const externalDir = path.join(testDir, "external-target")
		await writeText(path.join(sourceDir, "secrets", ".env"), "attacker controlled")
		await writeText(path.join(targetDir, ".keep"), "")
		await writeText(path.join(externalDir, ".env"), "original external")
		await symlink(externalDir, path.join(targetDir, "secrets"), "dir")

		await copyFiles(sourceDir, targetDir, ["secrets/.env"], log)

		expect(await readFile(path.join(externalDir, ".env"), "utf8")).toBe("original external")
	})

	it("does not symlink directories from source paths that resolve outside the source worktree", async () => {
		const sourceDir = path.join(testDir, "source")
		const targetDir = path.join(testDir, "target")
		const externalDir = path.join(testDir, "external-source")
		await writeText(path.join(sourceDir, ".keep"), "")
		await writeText(path.join(targetDir, ".keep"), "")
		await writeText(path.join(externalDir, "package.json"), "{}")
		await symlink(externalDir, path.join(sourceDir, "node_modules"), "dir")

		await symlinkDirs(sourceDir, targetDir, ["node_modules"], log)

		expect(await Bun.file(path.join(targetDir, "node_modules")).exists()).toBe(false)
	})

	it("does not remove or symlink through symlinked target parents outside the target worktree", async () => {
		const sourceDir = path.join(testDir, "source")
		const targetDir = path.join(testDir, "target")
		const externalDir = path.join(testDir, "external-target")
		await writeText(path.join(sourceDir, "p", "opencode", "source-marker.txt"), "source")
		await writeText(path.join(targetDir, ".keep"), "")
		await writeText(path.join(externalDir, "opencode", "victim-marker.txt"), "victim")
		await symlink(externalDir, path.join(targetDir, "p"), "dir")

		await symlinkDirs(sourceDir, targetDir, ["p/opencode"], log)

		expect(await readFile(path.join(externalDir, "opencode", "victim-marker.txt"), "utf8")).toBe(
			"victim",
		)
		expect((await lstat(path.join(externalDir, "opencode"))).isDirectory()).toBe(true)
	})

	it("still copies regular files and symlinks regular directories within the worktree roots", async () => {
		const sourceDir = path.join(testDir, "source")
		const targetDir = path.join(testDir, "target")
		await writeText(path.join(sourceDir, ".env"), "local env")
		await writeText(path.join(sourceDir, "node_modules", "package.txt"), "installed")
		await writeText(path.join(targetDir, ".keep"), "")

		await copyFiles(sourceDir, targetDir, [".env"], log)
		await symlinkDirs(sourceDir, targetDir, ["node_modules"], log)

		expect(await readFile(path.join(targetDir, ".env"), "utf8")).toBe("local env")
		const modulesStat = await lstat(path.join(targetDir, "node_modules"))
		expect(modulesStat.isSymbolicLink()).toBe(true)
		expect(await readFile(path.join(targetDir, "node_modules", "package.txt"), "utf8")).toBe(
			"installed",
		)
	})
})

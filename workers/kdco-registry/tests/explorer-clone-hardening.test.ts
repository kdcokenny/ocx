import { afterEach, describe, expect, it } from "bun:test"
import { chmod, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import ExplorerClonePlugin from "../files/plugins/explorer-clone"

const {
	buildIsolatedGitEnv,
	buildSafeGitArgs,
	ensureSafeTempRoot,
	prepareGitExecutionContext,
	resolveExplorerTempRoot,
} = ExplorerClonePlugin.testInternals

const testDirectories: string[] = []

afterEach(async () => {
	for (const directory of testDirectories.splice(0, testDirectories.length)) {
		await rm(directory, { recursive: true, force: true })
	}
})

async function createTestDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), prefix))
	testDirectories.push(directory)
	return directory
}

describe("explorer-clone hardening", () => {
	it("uses a private deterministic per-user temp root", async () => {
		const baseDirectory = await realpath(await createTestDirectory("explorer-clone-root-"))
		const tempRoot = await resolveExplorerTempRoot(baseDirectory)

		expect(tempRoot.startsWith(`${baseDirectory}${path.sep}`)).toBe(true)
		expect(path.basename(tempRoot).startsWith("kdco-flow-")).toBe(true)

		await ensureSafeTempRoot(tempRoot)
		const tempRootStats = await stat(tempRoot)
		expect(tempRootStats.isDirectory()).toBe(true)
		expect(tempRootStats.mode & 0o077).toBe(0)
	})

	it("rejects an existing shared or world-accessible temp root", async () => {
		const baseDirectory = await realpath(await createTestDirectory("explorer-clone-unsafe-"))
		const tempRoot = path.join(baseDirectory, "kdco-flow-unsafe")

		await mkdirUnsafe(tempRoot)
		await expect(ensureSafeTempRoot(tempRoot)).rejects.toThrow(/group or other users/i)
	})

	it("builds fail-closed git invocations with isolated config and credentials", async () => {
		const tempRoot = await realpath(await createTestDirectory("explorer-clone-git-"))
		await chmod(tempRoot, 0o700)

		const hostileEnvironment = {
			PATH: process.env.PATH,
			HOME: "/Users/example-hostile-home",
			XDG_CONFIG_HOME: "/Users/example-hostile-xdg",
			GIT_CONFIG_GLOBAL: "/Users/example-hostile/.gitconfig",
			GIT_ASKPASS: "/tmp/steal-credentials",
			SSH_ASKPASS: "/tmp/steal-ssh-credentials",
			GCM_INTERACTIVE: "Always",
			GIT_TERMINAL_PROMPT: "1",
		}

		const context = await prepareGitExecutionContext(
			tempRoot,
			["clone", "--", "https://github.com/kdcokenny/ocx.git", path.join(tempRoot, "kdcokenny", "ocx")],
			undefined,
			hostileEnvironment,
		)

		expect(context.command).toBe("git")
		expect(context.options.env.HOME.startsWith(`${tempRoot}${path.sep}`)).toBe(true)
		expect(context.options.env.XDG_CONFIG_HOME.startsWith(`${tempRoot}${path.sep}`)).toBe(true)
		expect(context.options.env.GIT_CONFIG_GLOBAL.startsWith(`${tempRoot}${path.sep}`)).toBe(true)
		expect(context.options.env.GIT_CONFIG_NOSYSTEM).toBe("1")
		expect(context.options.env.GIT_TERMINAL_PROMPT).toBe("0")
		expect(context.options.env.GIT_ASKPASS).toBe("")
		expect(context.options.env.SSH_ASKPASS).toBe("")
		expect(context.options.env.GCM_INTERACTIVE).toBe("Never")
		expect(context.options.env.GIT_ALLOW_PROTOCOL).toBe("https:file")

		expect(context.options.env.HOME).not.toBe(hostileEnvironment.HOME)
		expect(context.options.env.XDG_CONFIG_HOME).not.toBe(hostileEnvironment.XDG_CONFIG_HOME)
		expect(context.options.env.GIT_CONFIG_GLOBAL).not.toBe(hostileEnvironment.GIT_CONFIG_GLOBAL)

		expect(context.args).toEqual(expect.arrayContaining(["credential.helper=", "credential.interactive=false", "core.askPass="]))
		expect(context.args).toEqual(expect.arrayContaining(["protocol.ssh.allow=never", "protocol.git.allow=never"]))
		expect(context.args).toEqual(expect.arrayContaining(["protocol.file.allow=always", "protocol.https.allow=always"]))
		expect(context.args).toEqual(expect.arrayContaining(["http.extraHeader=", "http.https://github.com/.extraHeader="]))
		expect(context.args.some((arg) => /^url\..*\.(?:insteadOf|pushInsteadOf)=$/.test(arg))).toBe(false)
	})

	it("keeps git safety overrides ahead of requested git arguments", () => {
		const safeArgs = buildSafeGitArgs(["status"])
		expect(safeArgs.slice(0, 2)).toEqual(["-c", "credential.helper="])
		expect(safeArgs.at(-1)).toBe("status")

		const isolatedEnv = buildIsolatedGitEnv(
			{
				home: "/private/home",
				xdgConfigHome: "/private/xdg",
				globalConfig: "/private/gitconfig",
			},
			{ PATH: "/usr/bin", GIT_CONFIG_GLOBAL: "/hostile" },
		)
		expect(isolatedEnv.PATH).toBe("/usr/bin")
		expect(isolatedEnv.GIT_CONFIG_GLOBAL).toBe("/private/gitconfig")
	})
})

async function mkdirUnsafe(directory: string): Promise<void> {
	await mkdir(directory, { mode: 0o777 })
	await chmod(directory, 0o777)
}

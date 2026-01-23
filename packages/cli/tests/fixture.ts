import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { $ } from "bun"

type TmpDirOptions<T> = {
	/** Create .git directory (or run git init for full repo) */
	git?: boolean
	/** Run actual git init (vs just mkdir .git) */
	gitInit?: boolean
	/** Write to .opencode/ocx.jsonc */
	ocxConfig?: Record<string, unknown>
	/** Write to .opencode/opencode.jsonc */
	opencodeConfig?: Record<string, unknown>
	/** Create a profile in XDG_CONFIG_HOME */
	profile?: {
		name: string
		ocxConfig?: Record<string, unknown>
		opencodeConfig?: Record<string, unknown>
		agentsMd?: string
	}
	/** Custom initialization function */
	init?: (dir: string) => Promise<T>
}

/**
 * Create a temporary directory for per-test isolation.
 * Supports Symbol.asyncDispose for automatic cleanup with `await using`.
 */
export async function tmpdir<T>(options?: TmpDirOptions<T>): Promise<{
	path: string
	extra: T
	[Symbol.asyncDispose]: () => Promise<void>
}> {
	const dirpath = path.join(os.tmpdir(), `ocx-test-${Math.random().toString(36).slice(2)}`)
	await fs.mkdir(dirpath, { recursive: true })

	// Git setup
	if (options?.gitInit) {
		await $`git init`.cwd(dirpath).quiet()
		await $`git config user.email "test@example.com"`.cwd(dirpath).quiet()
		await $`git config user.name "Test"`.cwd(dirpath).quiet()
		await $`git commit --allow-empty -m "init"`.cwd(dirpath).quiet()
	} else if (options?.git) {
		await fs.mkdir(path.join(dirpath, ".git"), { recursive: true })
	}

	// Local .opencode config
	if (options?.ocxConfig || options?.opencodeConfig) {
		const configDir = path.join(dirpath, ".opencode")
		await fs.mkdir(configDir, { recursive: true })

		if (options?.ocxConfig) {
			await Bun.write(path.join(configDir, "ocx.jsonc"), JSON.stringify(options.ocxConfig, null, 2))
		}
		if (options?.opencodeConfig) {
			await Bun.write(
				path.join(configDir, "opencode.jsonc"),
				JSON.stringify(options.opencodeConfig, null, 2),
			)
		}
	}

	// Profile setup (in XDG_CONFIG_HOME)
	if (options?.profile) {
		const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
		const profileDir = path.join(xdgConfig, "opencode", "profiles", options.profile.name)
		await fs.mkdir(profileDir, { recursive: true })

		if (options.profile.ocxConfig) {
			await Bun.write(
				path.join(profileDir, "ocx.jsonc"),
				JSON.stringify(options.profile.ocxConfig, null, 2),
			)
		}
		if (options.profile.opencodeConfig) {
			await Bun.write(
				path.join(profileDir, "opencode.jsonc"),
				JSON.stringify(options.profile.opencodeConfig, null, 2),
			)
		}
		if (options.profile.agentsMd) {
			await Bun.write(path.join(profileDir, "AGENTS.md"), options.profile.agentsMd)
		}
	}

	const extra = await options?.init?.(dirpath)
	const realpath = await fs.realpath(dirpath)

	return {
		path: realpath,
		extra: extra as T,
		[Symbol.asyncDispose]: async () => {
			await fs.rm(dirpath, { recursive: true, force: true })
		},
	}
}

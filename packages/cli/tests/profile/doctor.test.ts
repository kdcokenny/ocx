import { describe, expect, it, mock } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runProfileDoctor } from "../../src/commands/profile/index"
import { ProfileManager } from "../../src/profile/manager"
import { getProfileDir } from "../../src/profile/paths"
import { ConfigError } from "../../src/utils/errors"

async function withIsolatedConfig(run: () => Promise<void>): Promise<void> {
	const originalXdg = process.env.XDG_CONFIG_HOME
	const root = await mkdtemp(join(tmpdir(), "ocx-profile-doctor-"))
	process.env.XDG_CONFIG_HOME = root
	try {
		await run()
	} finally {
		if (originalXdg !== undefined) process.env.XDG_CONFIG_HOME = originalXdg
		else delete process.env.XDG_CONFIG_HOME
		await rm(root, { recursive: true, force: true })
	}
}

const unix = process.platform === "win32" ? it.skip : it

describe("profile doctor", () => {
	unix("runs the executable doctor owned by the selected profile", async () => {
		await withIsolatedConfig(async () => {
			await ProfileManager.create().add("checked")
			const doctor = join(getProfileDir("checked"), "doctor")
			await writeFile(doctor, "#!/bin/sh\nprintf 'checked ok\\n'\nexit 0\n")
			await chmod(doctor, 0o755)

			expect((await runProfileDoctor("checked")).exitCode).toBe(0)
		})
	})

	unix("returns the profile doctor exit code", async () => {
		await withIsolatedConfig(async () => {
			await ProfileManager.create().add("failing")
			const doctor = join(getProfileDir("failing"), "doctor")
			await writeFile(doctor, "#!/bin/sh\nprintf 'missing token\\n' >&2\nexit 7\n")
			await chmod(doctor, 0o755)

			expect((await runProfileDoctor("failing")).exitCode).toBe(7)
		})
	})

	it("names a profile that does not provide a doctor", async () => {
		await withIsolatedConfig(async () => {
			await ProfileManager.create().add("empty")

			await expect(runProfileDoctor("empty")).rejects.toThrow(
				'Profile "empty" has no executable doctor script',
			)
		})
	})

	it("rejects a directory named doctor", async () => {
		await withIsolatedConfig(async () => {
			await ProfileManager.create().add("directory")
			await mkdir(join(getProfileDir("directory"), "doctor"))

			await expect(runProfileDoctor("directory")).rejects.toThrow("must be a regular file")
		})
	})

	unix("keeps doctor stdout out of the JSON result stream", async () => {
		await withIsolatedConfig(async () => {
			await ProfileManager.create().add("json")
			const doctor = join(getProfileDir("json"), "doctor")
			await writeFile(doctor, "#!/bin/sh\nprintf 'plain out\\n'\nprintf 'plain err\\n' >&2\nexit 3\n")
			await chmod(doctor, 0o755)
			const result = await runProfileDoctor("json", { json: true })
			expect(result).toEqual({ exitCode: 3, stdout: "plain out\n", stderr: "plain err\n" })
		})
	})

	it("launches Windows script doctors through cmd.exe", async () => {
		await withIsolatedConfig(async () => {
			await ProfileManager.create().add("windows")
			const doctor = join(getProfileDir("windows"), "doctor")
			await writeFile(doctor, "@echo off\r\nexit /b 0\r\n")
			const originalPlatform = process.platform
			Object.defineProperty(process, "platform", { value: "win32" })
			let command = ""
			let args: readonly string[] = []
			const spawned = {
				stdout: undefined,
				on(event: string, listener: (value?: number) => void) {
					if (event === "close") listener(0)
					return spawned
				},
			}
			mock.module("node:child_process", () => ({
				spawn: (file: string, commandArgs: readonly string[] = []) => {
					command = file
					args = commandArgs
					return spawned
				},
			}))
			try {
				const { runProfileDoctor: runWindowsDoctor } = await import(
					`../../src/commands/profile/index?windows=${Date.now()}`
				)
				expect((await runWindowsDoctor("windows")).exitCode).toBe(0)
			} finally {
				mock.restore()
				Object.defineProperty(process, "platform", { value: originalPlatform })
			}
			expect(command.toLowerCase()).toContain("cmd")
			expect(args.at(-1)).toBe(`""${JSON.stringify(doctor)}"`)
		})
	})

	it("runs doctor.exe directly on Windows", async () => {
		await withIsolatedConfig(async () => {
			await ProfileManager.create().add("binary")
			const doctor = join(getProfileDir("binary"), "doctor.exe")
			await writeFile(doctor, "")
			const originalPlatform = process.platform
			Object.defineProperty(process, "platform", { value: "win32" })
			let command = ""
			const spawned = {
				stdout: undefined,
				on(event: string, listener: (value?: number) => void) {
					if (event === "close") listener(0)
					return spawned
				},
			}
			mock.module("node:child_process", () => ({
				spawn: (file: string) => {
					command = file
					return spawned
				},
			}))
			try {
				const { runProfileDoctor: runWindowsDoctor } = await import(
					`../../src/commands/profile/index?exe=${Date.now()}`
				)
				expect((await runWindowsDoctor("binary")).exitCode).toBe(0)
			} finally {
				mock.restore()
				Object.defineProperty(process, "platform", { value: originalPlatform })
			}
			expect(command).toBe(doctor)
		})
	})

	it("quotes Windows doctor paths before passing them to cmd.exe", async () => {
		await withIsolatedConfig(async () => {
			process.env.XDG_CONFIG_HOME = `${process.env.XDG_CONFIG_HOME}&calc`
			await ProfileManager.create().add("windows")
			const doctor = join(getProfileDir("windows"), "doctor")
			await mkdir(join(doctor, ".."), { recursive: true })
			await writeFile(doctor, "@echo off\r\nexit /b 0\r\n")
			const originalPlatform = process.platform
			Object.defineProperty(process, "platform", { value: "win32" })
			let args: readonly string[] = []
			const spawned = {
				stdout: undefined,
				on(event: string, listener: (value?: number) => void) {
					if (event === "close") listener(0)
					return spawned
				},
			}
			mock.module("node:child_process", () => ({
				spawn: (_file: string, commandArgs: readonly string[] = []) => {
					args = commandArgs
					return spawned
				},
			}))
			try {
				const { runProfileDoctor: runWindowsDoctor } = await import(
					`../../src/commands/profile/index?quoted=${Date.now()}`
				)
				expect((await runWindowsDoctor("windows")).exitCode).toBe(0)
			} finally {
				mock.restore()
				Object.defineProperty(process, "platform", { value: originalPlatform })
			}
			expect(args.at(-1)).toBe(`""${JSON.stringify(doctor)}"`)
			expect(args.at(-1)?.includes("&calc")).toBe(true)
		})
	})

	unix("rejects a doctor that is not executable", async () => {
		await withIsolatedConfig(async () => {
			await ProfileManager.create().add("plain")
			await mkdir(getProfileDir("plain"), { recursive: true })
			await writeFile(join(getProfileDir("plain"), "doctor"), "#!/bin/sh\nexit 0\n", { mode: 0o644 })

			await expect(runProfileDoctor("plain")).rejects.toBeInstanceOf(ConfigError)
		})
	})
})

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCLI } from "../helpers"

describe("Integration: Global Workflow", () => {
	let testDir: string
	let globalDir: string
	let env: { XDG_CONFIG_HOME: string }

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "ocx-integration-global-"))
		globalDir = await mkdtemp(join(tmpdir(), "ocx-global-"))
		env = { XDG_CONFIG_HOME: globalDir }
	})

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true })
		await rm(globalDir, { recursive: true, force: true })
	})

	it("should complete full global setup workflow with profile isolation", async () => {
		// Step 1: Initialize global config
		const init = await runCLI(["init", "--global"], testDir, { env })
		expect(init.exitCode).toBe(0)

		// Step 2: Add a registry to global config
		const addGlobal = await runCLI(
			["registry", "add", "https://example.com", "--name", "example", "--global"],
			testDir,
			{ env },
		)
		expect(addGlobal.exitCode).toBe(0)

		// Step 3: Create a new profile
		const addProfile = await runCLI(["profile", "add", "work"], testDir, { env })
		expect(addProfile.exitCode).toBe(0)

		// Step 4: Add a registry to the profile
		const addToProfile = await runCLI(
			["registry", "add", "https://work.example.com", "--name", "work-reg", "--profile", "work"],
			testDir,
			{ env },
		)
		expect(addToProfile.exitCode).toBe(0)

		// Step 5: List profile registries - verify isolation
		// Profile registries should NOT include global registries (isolation check)
		const listProfile = await runCLI(["registry", "list", "--profile", "work", "--json"], testDir, {
			env,
		})
		expect(listProfile.exitCode).toBe(0)
		const profileOutput = JSON.parse(listProfile.stdout)
		const profileRegistries: Array<{ name: string }> =
			profileOutput.data?.registries || profileOutput.registries || []

		// Profile should have work-reg
		expect(profileRegistries.find((r) => r.name === "work-reg")).toBeDefined()
		// Profile should NOT have example (isolation from global)
		expect(profileRegistries.find((r) => r.name === "example")).toBeUndefined()

		// Step 6: Verify config edit works (using echo as editor stub)
		const edit = await runCLI(["config", "edit", "--profile", "work"], testDir, {
			env: { ...env, EDITOR: "echo", VISUAL: "echo" },
		})
		expect(edit.exitCode).toBe(0)
		// Editor stub echoes the path - verify it contains profile config path
		expect(edit.stdout).toContain("ocx.jsonc")
	})
})

describe("Integration: Local Workflow", () => {
	let testDir: string

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "ocx-integration-local-"))
	})

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true })
	})

	it("should complete full local project setup", async () => {
		// Step 1: Initialize local config
		const init = await runCLI(["init"], testDir)
		expect(init.exitCode).toBe(0)

		// Step 2: Add a registry
		const add = await runCLI(
			["registry", "add", "https://example.com", "--name", "example"],
			testDir,
		)
		expect(add.exitCode).toBe(0)

		// Step 3: List registries - verify it was added
		const list = await runCLI(["registry", "list", "--json"], testDir)
		expect(list.exitCode).toBe(0)
		const listOutput = JSON.parse(list.stdout)
		const registries: Array<{ name: string }> =
			listOutput.data?.registries || listOutput.registries || []
		expect(registries.find((r) => r.name === "example")).toBeDefined()

		// Step 4: Remove the registry
		const remove = await runCLI(["registry", "remove", "example"], testDir)
		expect(remove.exitCode).toBe(0)

		// Step 5: Verify it's gone
		const listAfter = await runCLI(["registry", "list", "--json"], testDir)
		expect(listAfter.exitCode).toBe(0)
		const afterOutput = JSON.parse(listAfter.stdout)
		const regsAfter: Array<{ name: string }> =
			afterOutput.data?.registries || afterOutput.registries || []
		expect(regsAfter.find((r) => r.name === "example")).toBeUndefined()
	})
})

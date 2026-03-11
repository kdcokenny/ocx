import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCLI } from "../helpers"
import { type MockRegistry, startMockRegistry } from "../mock-registry"

describe("Integration: Global Workflow", () => {
	let testDir: string
	let globalDir: string
	let env: { XDG_CONFIG_HOME: string }
	let registry: MockRegistry

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "ocx-integration-global-"))
		globalDir = await mkdtemp(join(tmpdir(), "ocx-global-"))
		env = { XDG_CONFIG_HOME: globalDir }
		registry = startMockRegistry()
	})

	afterEach(async () => {
		registry.stop()
		await rm(testDir, { recursive: true, force: true })
		await rm(globalDir, { recursive: true, force: true })
	})

	it("should complete full global setup workflow with profile isolation", async () => {
		// Step 1: Initialize global config
		const init = await runCLI(["init", "--global"], testDir, { env })
		expect(init.exitCode).toBe(0)

		// Step 2: Add a registry to global config (V2: use namespace kdco)
		const addGlobal = await runCLI(
			["registry", "add", registry.url, "--name", "kdco", "--global"],
			testDir,
			{ env },
		)
		expect(addGlobal.exitCode).toBe(0)

		// Step 3: Create a new profile (global-only profiles)
		const addProfile = await runCLI(["profile", "add", "work", "--global"], testDir, { env })
		expect(addProfile.exitCode).toBe(0)

		// V2: Create profile ocx.jsonc (profile add doesn't create it)
		const profileDir = join(globalDir, "opencode", "profiles", "work")
		await Bun.write(
			join(profileDir, "ocx.jsonc"),
			JSON.stringify({ $schema: "https://ocx.kdco.dev/schemas/ocx.json", registries: {} }, null, 2),
		)

		// Step 4: Add a registry to the profile (V2: use namespace kdco)
		const addToProfile = await runCLI(
			["registry", "add", registry.url, "--name", "kdco", "--profile", "work"],
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

		// Profile should have kdco
		expect(profileRegistries.find((r) => r.name === "kdco")).toBeDefined()
		// Since both global and profile have same namespace kdco, profile wins (isolation)
		expect(profileRegistries).toHaveLength(1)

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
	let registry: MockRegistry

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "ocx-integration-local-"))
		registry = startMockRegistry()
	})

	afterEach(async () => {
		registry.stop()
		await rm(testDir, { recursive: true, force: true })
	})

	it("should complete full local project setup", async () => {
		const init = await runCLI(["init"], testDir)
		expect(init.exitCode).toBe(0)

		const add = await runCLI(["registry", "add", registry.url, "--name", "kdco"], testDir)
		expect(add.exitCode).toBe(0)

		const list = await runCLI(["registry", "list", "--json"], testDir)
		expect(list.exitCode).toBe(0)
		const listOutput = JSON.parse(list.stdout)
		const registries: Array<{ name: string }> =
			listOutput.data?.registries || listOutput.registries || []
		expect(registries.find((r) => r.name === "kdco")).toBeDefined()

		const remove = await runCLI(["registry", "remove", "kdco"], testDir)
		expect(remove.exitCode).toBe(0)

		const listAfter = await runCLI(["registry", "list", "--json"], testDir)
		expect(listAfter.exitCode).toBe(0)
		const afterOutput = JSON.parse(listAfter.stdout)
		const regsAfter: Array<{ name: string }> =
			afterOutput.data?.registries || afterOutput.registries || []
		expect(regsAfter.find((r) => r.name === "kdco")).toBeUndefined()
	})
})

describe("Integration: GitHub Registry Workflow", () => {
	let testDir: string
	let registry: MockRegistry

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "ocx-integration-github-"))
		registry = startMockRegistry()
	})

	afterEach(async () => {
		registry.stop()
		await rm(testDir, { recursive: true, force: true })
	})

	it("should preserve GitHub source field through component operations", async () => {
		const init = await runCLI(["init"], testDir)
		expect(init.exitCode).toBe(0)

		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const configContent = await Bun.file(configPath).text()
		const config = JSON.parse(configContent) as {
			registries: Record<string, { url: string; source?: string }>
		}

		config.registries["gh-test"] = {
			url: registry.url,
			source: "github:test-org/test-repo@main",
		}
		config.registries["http-test"] = {
			url: registry.url,
		}

		await Bun.write(configPath, JSON.stringify(config, null, 2))

		const listBefore = await runCLI(["registry", "list", "--json"], testDir)
		expect(listBefore.exitCode).toBe(0)
		const beforeOutput = JSON.parse(listBefore.stdout)
		const beforeRegistries = beforeOutput.data?.registries || []
		expect(beforeRegistries).toHaveLength(2)

		const ghReg = beforeRegistries.find((r: { name: string }) => r.name === "gh-test")
		expect(ghReg).toBeDefined()
		expect(ghReg.source).toBe("github:test-org/test-repo@main")

		const httpReg = beforeRegistries.find((r: { name: string }) => r.name === "http-test")
		expect(httpReg).toBeDefined()
		expect(httpReg.source).toBeUndefined()

		const addComponent = await runCLI(["add", "http-test/test-plugin"], testDir)
		expect(addComponent.exitCode).toBe(0)

		const pluginPath = join(testDir, ".opencode", "plugins", "test-plugin.ts")
		const pluginExists = await Bun.file(pluginPath).exists()
		expect(pluginExists).toBe(true)

		const listAfterAdd = await runCLI(["registry", "list", "--json"], testDir)
		expect(listAfterAdd.exitCode).toBe(0)
		const afterAddOutput = JSON.parse(listAfterAdd.stdout)
		const afterAddRegs = afterAddOutput.data?.registries || []
		const ghRegAfterAdd = afterAddRegs.find((r: { name: string }) => r.name === "gh-test")
		expect(ghRegAfterAdd.source).toBe("github:test-org/test-repo@main")

		const removeHttpRegistry = await runCLI(["registry", "remove", "http-test"], testDir)
		expect(removeHttpRegistry.exitCode).toBe(0)

		const listAfterHttpRemove = await runCLI(["registry", "list", "--json"], testDir)
		expect(listAfterHttpRemove.exitCode).toBe(0)
		const afterHttpRemoveOutput = JSON.parse(listAfterHttpRemove.stdout)
		const afterHttpRemoveRegs = afterHttpRemoveOutput.data?.registries || []
		expect(afterHttpRemoveRegs).toHaveLength(1)
		const ghRegAfterHttpRemove = afterHttpRemoveRegs.find(
			(r: { name: string }) => r.name === "gh-test",
		)
		expect(ghRegAfterHttpRemove).toBeDefined()
		expect(ghRegAfterHttpRemove.source).toBe("github:test-org/test-repo@main")

		const removeGhRegistry = await runCLI(["registry", "remove", "gh-test"], testDir)
		expect(removeGhRegistry.exitCode).toBe(0)

		const listAfterAll = await runCLI(["registry", "list", "--json"], testDir)
		expect(listAfterAll.exitCode).toBe(0)
		const afterAllOutput = JSON.parse(listAfterAll.stdout)
		const afterAllRegs = afterAllOutput.data?.registries || []
		expect(afterAllRegs).toHaveLength(0)
	})
})

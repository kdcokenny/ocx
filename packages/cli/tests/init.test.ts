import { afterEach, describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { cleanupTempDir, createTempDir, parseJsonc, runCLI } from "./helpers"

/** Path to the registry-template test fixture */
const REGISTRY_FIXTURE = join(dirname(import.meta.path), "fixtures/registry-template")

describe("ocx init", () => {
	let testDir: string

	afterEach(async () => {
		if (testDir) {
			await cleanupTempDir(testDir)
		}
	})

	it("should create ocx.jsonc with default config", async () => {
		testDir = await createTempDir("init-basic")
		const { exitCode, output } = await runCLI(["init"], testDir)

		expect(exitCode).toBe(0)
		// Success message from logger.info
		expect(output).toContain("Created")

		const configPath = join(testDir, "ocx.jsonc")
		expect(existsSync(configPath)).toBe(true)

		const content = await readFile(configPath, "utf-8")
		const config = parseJsonc(content)
		expect(config.registries).toBeDefined()
		expect(config.lockRegistries).toBe(false)
	})

	it("should error if ocx.jsonc already exists", async () => {
		testDir = await createTempDir("init-exists")
		const configPath = join(testDir, "ocx.jsonc")
		await Bun.write(configPath, "{}")

		const { exitCode, output } = await runCLI(["init"], testDir)
		expect(exitCode).not.toBe(0)
		expect(output).toContain("ocx.jsonc already exists")
		expect(output).toContain("To reset")
		expect(output).toContain("rm")
	})

	it("should output JSON when requested", async () => {
		testDir = await createTempDir("init-json")
		const { exitCode, output } = await runCLI(["init", "--json"], testDir)

		expect(exitCode).toBe(0)
		const json = JSON.parse(output)
		expect(json.success).toBe(true)
		expect(json.path).toContain("ocx.jsonc")
	})
})

describe("init --registry", () => {
	let testDir: string

	afterEach(async () => {
		if (testDir) {
			await cleanupTempDir(testDir)
		}
	})

	it("should replace placeholders in registry.jsonc", async () => {
		testDir = await createTempDir("init-registry-placeholders")

		const { exitCode, output } = await runCLI(
			[
				"init",
				"--registry",
				"--local",
				REGISTRY_FIXTURE,
				"--namespace",
				"test-namespace",
				"--author",
				"Test Author",
			],
			testDir,
		)

		expect(exitCode).toBe(0)
		expect(output).toContain("Next steps:")

		// Read the generated registry.jsonc
		const registryPath = join(testDir, "registry.jsonc")
		expect(existsSync(registryPath)).toBe(true)

		const content = await readFile(registryPath, "utf-8")

		// Positive assertions - new values present
		expect(content).toContain('"namespace": "test-namespace"')
		expect(content).toContain('"author": "Test Author"')

		// CRITICAL: Negative assertions - template placeholders GONE
		// These are the original template values that should be replaced
		expect(content).not.toContain('"namespace": "my-registry"')
		expect(content).not.toContain('"author": "Your Name"')
	})

	it("should reference registry.jsonc in output message", async () => {
		testDir = await createTempDir("init-registry-output")

		const { exitCode, output } = await runCLI(
			["init", "--registry", "--local", REGISTRY_FIXTURE, "--namespace", "my-ns", "--author", "Me"],
			testDir,
		)

		expect(exitCode).toBe(0)
		// Should mention registry.jsonc, not registry.json
		expect(output).toContain("registry.jsonc")
		expect(output).not.toMatch(/registry\.json\b/)
	})

	it("should replace namespace in package.json name field", async () => {
		testDir = await createTempDir("init-registry-package")

		const { exitCode } = await runCLI(
			[
				"init",
				"--registry",
				"--local",
				REGISTRY_FIXTURE,
				"--namespace",
				"custom-namespace",
				"--author",
				"Test",
			],
			testDir,
		)

		expect(exitCode).toBe(0)

		const packagePath = join(testDir, "package.json")
		const content = await readFile(packagePath, "utf-8")

		// Positive: new namespace should be present
		expect(content).toContain('"name": "custom-namespace"')

		// Negative: template placeholder should be gone
		expect(content).not.toContain('"name": "my-registry"')
	})
})

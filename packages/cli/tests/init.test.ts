import { afterEach, describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { getReleaseTag, getTemplateUrl, TEMPLATE_REPO } from "../src/commands/init"
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
		const { exitCode, output } = await runCLI(["init", "--project"], testDir)

		expect(exitCode).toBe(0)
		// Success message from logger.info
		expect(output).toContain("Created")

		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		expect(existsSync(configPath)).toBe(true)

		const content = await readFile(configPath, "utf-8")
		const config = parseJsonc(content)
		expect(config.registries).toBeDefined()
		expect(config.lockRegistries).toBe(false)
	})

	it("should error if ocx.jsonc already exists", async () => {
		testDir = await createTempDir("init-exists")
		const configDir = join(testDir, ".opencode")
		await mkdir(configDir, { recursive: true })
		const configPath = join(configDir, "ocx.jsonc")
		await Bun.write(configPath, "{}")

		const { exitCode, output } = await runCLI(["init", "--project"], testDir)
		expect(exitCode).not.toBe(0)
		expect(output).toContain("already exists")
		expect(await Bun.file(configPath).text()).toBe("{}")
	})

	it("should output JSON when requested", async () => {
		testDir = await createTempDir("init-json")
		const { exitCode, output } = await runCLI(["init", "--project", "--json"], testDir)

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
				testDir,
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
		const manifest = parseJsonc(content) as { $schema?: string }

		// Positive assertions - new values present
		expect(content).toContain('"name": "Test Namespace"')
		expect(content).toContain('"author": "Test Author"')
		expect(manifest.$schema).toBe("https://ocx.kdco.dev/schemas/v3/registry.json")

		// CRITICAL: Negative assertions - template placeholders GONE
		// These are the original template values that should be replaced
		expect(content).not.toContain('"namespace": "my-registry"')
		expect(content).not.toContain('"author": "Your Name"')
	})

	it("should reference registry.jsonc in output message", async () => {
		testDir = await createTempDir("init-registry-output")

		const { exitCode, output } = await runCLI(
			[
				"init",
				"--registry",
				testDir,
				"--local",
				REGISTRY_FIXTURE,
				"--namespace",
				"my-ns",
				"--author",
				"Me",
			],
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
				testDir,
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

describe("getReleaseTag", () => {
	it("should throw ValidationError in development mode (when __VERSION__ is undefined)", () => {
		// In source/test mode, __VERSION__ is not defined, so this should throw
		expect(() => getReleaseTag()).toThrow("Cannot fetch release template in development mode")
	})

	it("should provide helpful guidance in error message", () => {
		try {
			getReleaseTag()
			expect.unreachable("Should have thrown")
		} catch (error) {
			expect((error as Error).message).toContain("--canary")
		}
	})
})

describe("getTemplateUrl", () => {
	it("should use heads/main ref for canary", () => {
		const url = getTemplateUrl("main")
		expect(url).toBe(`https://github.com/${TEMPLATE_REPO}/archive/refs/heads/main.tar.gz`)
	})

	it("should use tags ref for release version", () => {
		const url = getTemplateUrl("v1.4.1")
		expect(url).toBe(`https://github.com/${TEMPLATE_REPO}/archive/refs/tags/v1.4.1.tar.gz`)
	})

	it("should handle pre-release versions", () => {
		const url = getTemplateUrl("v2.0.0-beta.1")
		expect(url).toBe(`https://github.com/${TEMPLATE_REPO}/archive/refs/tags/v2.0.0-beta.1.tar.gz`)
	})
})

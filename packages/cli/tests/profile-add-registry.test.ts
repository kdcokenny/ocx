import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parseSourceOption } from "../src/commands/profile/add"
import { resolveEmbeddedProfileTarget } from "../src/commands/profile/install-from-registry"
import { _clearFetcherCacheForTests } from "../src/registry/fetcher"
import { validateSafePath } from "../src/schemas/registry"
import { ValidationError } from "../src/utils/errors"
import { cleanupTempDir, createTempDir, parseJsonc, runCLI } from "./helpers"
import { type MockRegistry, startMockRegistry } from "./mock-registry"

// =============================================================================
// UNIT TESTS: parseSourceOption() - V2 Contract
// =============================================================================

describe("parseSourceOption()", () => {
	it("parses namespace/component format", () => {
		const result = parseSourceOption("kdco/minimal")
		expect(result).toEqual({ namespace: "kdco", component: "minimal" })
	})

	it("throws on empty input", () => {
		expect(() => parseSourceOption("")).toThrow(ValidationError)
	})

	it("throws on whitespace-only input", () => {
		expect(() => parseSourceOption("   ")).toThrow(ValidationError)
	})

	it("throws on missing component part", () => {
		expect(() => parseSourceOption("kdco/")).toThrow(ValidationError)
	})

	it("throws on missing namespace part", () => {
		expect(() => parseSourceOption("/minimal")).toThrow(ValidationError)
	})

	it("throws on multiple slashes", () => {
		expect(() => parseSourceOption("namespace/component/extra")).toThrow(ValidationError)
	})

	it("throws on no slash (bare component name)", () => {
		expect(() => parseSourceOption("my-profile")).toThrow(ValidationError)
	})

	it("trims whitespace from input", () => {
		const result = parseSourceOption("  kdco/minimal  ")
		expect(result).toEqual({ namespace: "kdco", component: "minimal" })
	})

	it("trims whitespace around slash", () => {
		const result = parseSourceOption("kdco / minimal")
		expect(result).toEqual({ namespace: "kdco", component: "minimal" })
	})
})

// =============================================================================
// UNIT TESTS: Path Security (validateSafePath)
// =============================================================================

describe("Path security", () => {
	describe("resolveEmbeddedProfileTarget()", () => {
		it("fails loud on post-strip traversal escapes", () => {
			expect(() => resolveEmbeddedProfileTarget(".opencode/../victim.txt", "/tmp/staging")).toThrow(
				ValidationError,
			)
		})

		it("returns safe relative embedded target when containment holds", () => {
			expect(
				resolveEmbeddedProfileTarget(".opencode/commands/safe-command.md", "/tmp/profile-staging"),
			).toBe("commands/safe-command.md")
		})
	})

	describe("validateSafePath()", () => {
		it("accepts normal relative paths", () => {
			expect(() => validateSafePath("ocx.jsonc")).not.toThrow()
			expect(() => validateSafePath("opencode.jsonc")).not.toThrow()
			expect(() => validateSafePath("plugin/foo.ts")).not.toThrow()
		})

		it("rejects path traversal with ../", () => {
			expect(() => validateSafePath("../etc/passwd")).toThrow(ValidationError)
			// Note: foo/../bar normalizes to "bar" which is safe (no traversal escape)
		})

		it("rejects path traversal that escapes the directory", () => {
			expect(() => validateSafePath("foo/../../bar")).toThrow(ValidationError)
			expect(() => validateSafePath("foo/bar/../../../baz")).toThrow(ValidationError)
		})

		it("rejects absolute paths starting with /", () => {
			expect(() => validateSafePath("/etc/passwd")).toThrow(ValidationError)
		})

		it("rejects home directory paths starting with ~", () => {
			expect(() => validateSafePath("~/.ssh/id_rsa")).toThrow(ValidationError)
		})

		it("accepts paths that normalize to safe values", () => {
			// foo/../bar normalizes to "bar" which is safe (no escape)
			expect(() => validateSafePath("foo/../bar")).not.toThrow()
			// ./foo/bar normalizes to "foo/bar" which is safe
			expect(() => validateSafePath("./foo/bar")).not.toThrow()
		})
	})
})

// =============================================================================
// INTEGRATION TESTS: V2 Option Invariants
// =============================================================================

describe("ocx profile add (V2 option invariants)", () => {
	let testDir: string
	const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

	beforeEach(async () => {
		testDir = await createTempDir("profile-invariants")
		process.env.XDG_CONFIG_HOME = testDir

		// Setup minimal global config
		const globalConfigDir = join(testDir, "opencode")
		const profilesDir = join(globalConfigDir, "profiles")
		await mkdir(profilesDir, { recursive: true })
		await writeFile(join(globalConfigDir, "ocx.jsonc"), JSON.stringify({ registries: {} }, null, 2))
		await mkdir(join(profilesDir, "default"), { recursive: true })
		await writeFile(join(profilesDir, "default", "ocx.jsonc"), "{}")
	})

	afterEach(async () => {
		if (originalXdgConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME
		} else {
			process.env.XDG_CONFIG_HOME = originalXdgConfigHome
		}
		if (testDir) {
			await cleanupTempDir(testDir)
		}
	})

	it("rejects --clone with --source", async () => {
		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		const { exitCode, output } = await runCLI(
			["profile", "add", "test", "--clone", "default", "--source", "kdco/minimal", "--global"],
			workDir,
		)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("--clone cannot be used with --source")
	})

	it("rejects --clone with --from", async () => {
		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		const { exitCode, output } = await runCLI(
			["profile", "add", "test", "--clone", "default", "--from", "http://example.com"],
			workDir,
		)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("--clone cannot be used with")
	})

	it("rejects --from without --source (with migration hint for namespace/component)", async () => {
		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		const { exitCode, output } = await runCLI(
			["profile", "add", "test", "--from", "kdco/minimal", "--global"],
			workDir,
		)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("--from requires --source")
		expect(output).toContain("Migration")
		expect(output).toContain("--source kdco/minimal --global")
	})

	it("rejects --from without --source (with migration hint for URL)", async () => {
		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		const { exitCode, output } = await runCLI(
			["profile", "add", "test", "--from", "http://example.com", "--global"],
			workDir,
		)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("--from requires --source")
		expect(output).toContain("Migration")
		expect(output).toContain("--source <namespace/component>")
	})

	it("rejects --from without --source (suggests --clone for profile name)", async () => {
		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		const { exitCode, output } = await runCLI(
			["profile", "add", "test", "--from", "my-profile", "--global"],
			workDir,
		)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("--from requires --source")
		expect(output).toContain("--clone my-profile")
	})

	it("rejects --source without --global", async () => {
		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		const { exitCode, output } = await runCLI(
			["profile", "add", "test", "--source", "kdco/minimal"],
			workDir,
		)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("--source requires --global")
		expect(output).toContain("--source kdco/minimal --global")
	})

	it("rejects non-URL --from value when --source is provided", async () => {
		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		const { exitCode, output } = await runCLI(
			["profile", "add", "test", "--source", "kdco/minimal", "--from", "not-a-url", "--global"],
			workDir,
		)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("--from must be a")
	})

	it("rejects malformed URL with http:// prefix only (no hostname)", async () => {
		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		const { exitCode, output } = await runCLI(
			["profile", "add", "test", "--source", "kdco/minimal", "--from", "http://", "--global"],
			workDir,
		)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("--from must be a")
	})

	it("rejects malformed URL with https:/// (triple slash, no hostname)", async () => {
		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		const { exitCode, output } = await runCLI(
			["profile", "add", "test", "--source", "kdco/minimal", "--from", "https:///", "--global"],
			workDir,
		)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("--from must be a")
	})

	it("rejects URL with invalid protocol (ftp://)", async () => {
		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		const { exitCode, output } = await runCLI(
			[
				"profile",
				"add",
				"test",
				"--source",
				"kdco/minimal",
				"--from",
				"ftp://example.com",
				"--global",
			],
			workDir,
		)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("http:// or https://")
	})

	it("rejects malformed URL with missing hostname after protocol", async () => {
		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		const { exitCode, output } = await runCLI(
			[
				"profile",
				"add",
				"test",
				"--source",
				"kdco/minimal",
				"--from",
				"https://:8080/path",
				"--global",
			],
			workDir,
		)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("--from must be a")
	})
})

// =============================================================================
// INTEGRATION TESTS: Global Registry Requirement
// =============================================================================

describe("ocx profile add --source (global registry requirement)", () => {
	let testDir: string
	let registry: MockRegistry
	const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

	beforeAll(() => {
		registry = startMockRegistry()
	})

	afterAll(() => {
		registry.stop()
	})

	beforeEach(async () => {
		testDir = await createTempDir("profile-registry")
		process.env.XDG_CONFIG_HOME = testDir
	})

	afterEach(async () => {
		if (originalXdgConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME
		} else {
			process.env.XDG_CONFIG_HOME = originalXdgConfigHome
		}
		if (testDir) {
			await cleanupTempDir(testDir)
		}
	})

	it("fails with ConfigError when registry is not configured globally", async () => {
		// Create global config directory but without registry configured
		const globalConfigDir = join(testDir, "opencode")
		const profilesDir = join(globalConfigDir, "profiles")
		await mkdir(profilesDir, { recursive: true })

		// Create global ocx.jsonc without the registry
		await writeFile(join(globalConfigDir, "ocx.jsonc"), JSON.stringify({ registries: {} }, null, 2))

		// Create a dummy default profile to satisfy initialization
		await mkdir(join(profilesDir, "default"), { recursive: true })
		await writeFile(join(profilesDir, "default", "ocx.jsonc"), "{}")

		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		const { exitCode, output } = await runCLI(
			["profile", "add", "test-profile", "--source", "kdco/minimal", "--global"],
			workDir,
		)

		expect(exitCode).not.toBe(0)
		// Verify error message contains key information for user action
		expect(output).toContain("not configured globally")
		expect(output).toContain("ocx registry add")
	})

	it("fails when registry is only configured locally (not globally)", async () => {
		// Create global config without registry
		const globalConfigDir = join(testDir, "opencode")
		const profilesDir = join(globalConfigDir, "profiles")
		await mkdir(profilesDir, { recursive: true })
		await writeFile(join(globalConfigDir, "ocx.jsonc"), JSON.stringify({ registries: {} }, null, 2))

		// Create default profile
		await mkdir(join(profilesDir, "default"), { recursive: true })
		await writeFile(join(profilesDir, "default", "ocx.jsonc"), "{}")

		// Create local project with registry configured locally
		const workDir = join(testDir, "workspace")
		const localConfigDir = join(workDir, ".opencode")
		await mkdir(localConfigDir, { recursive: true })

		// Local config has the registry, but global does not
		await writeFile(
			join(localConfigDir, "ocx.jsonc"),
			JSON.stringify({ registries: { kdco: { url: registry.url } } }, null, 2),
		)

		const { exitCode, output } = await runCLI(
			["profile", "add", "test-profile", "--source", "kdco/minimal", "--global"],
			workDir,
		)

		expect(exitCode).not.toBe(0)
		// Should fail because registry must be configured globally for profile installation
		expect(output).toContain("not configured globally")
	})
})

// =============================================================================
// INTEGRATION TESTS: Conflict Detection
// =============================================================================

describe("ocx profile add (conflict detection)", () => {
	let testDir: string
	let registry: MockRegistry
	const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

	beforeAll(() => {
		registry = startMockRegistry()
	})

	afterAll(() => {
		registry.stop()
	})

	beforeEach(async () => {
		testDir = await createTempDir("profile-conflict")
		process.env.XDG_CONFIG_HOME = testDir
	})

	afterEach(async () => {
		if (originalXdgConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME
		} else {
			process.env.XDG_CONFIG_HOME = originalXdgConfigHome
		}
		if (testDir) {
			await cleanupTempDir(testDir)
		}
	})

	it("creates profile successfully when it does not exist", async () => {
		// Setup global config
		const globalConfigDir = join(testDir, "opencode")
		const profilesDir = join(globalConfigDir, "profiles")
		await mkdir(profilesDir, { recursive: true })
		await writeFile(
			join(globalConfigDir, "ocx.jsonc"),
			JSON.stringify({ registries: { kdco: { url: registry.url } } }, null, 2),
		)

		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		// V2: Create global profile with --global flag
		const { exitCode } = await runCLI(["profile", "add", "new-profile", "--global"], workDir, {
			env: { XDG_CONFIG_HOME: testDir },
			isolated: true,
		})

		expect(exitCode).toBe(0)
		expect(existsSync(join(profilesDir, "new-profile"))).toBe(true)
	})

	it("fails when profile exists without --force (with actionable error)", async () => {
		// Setup global config
		const globalConfigDir = join(testDir, "opencode")
		const profilesDir = join(globalConfigDir, "profiles")
		await mkdir(profilesDir, { recursive: true })
		await writeFile(
			join(globalConfigDir, "ocx.jsonc"),
			JSON.stringify({ registries: { kdco: { url: registry.url } } }, null, 2),
		)

		// Create default profile
		await mkdir(join(profilesDir, "default"), { recursive: true })
		await writeFile(join(profilesDir, "default", "ocx.jsonc"), "{}")

		// Create existing profile manually
		await mkdir(join(profilesDir, "existing-profile"), { recursive: true })
		await writeFile(
			join(profilesDir, "existing-profile", "ocx.jsonc"),
			JSON.stringify({ some: "config" }, null, 2),
		)

		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		const { exitCode, output } = await runCLI(
			["profile", "add", "existing-profile", "--global"],
			workDir,
		)

		expect(exitCode).toBe(6)
		// Verify error message contains key information for user action
		expect(output).toContain("already exists")
		expect(output).toContain("ocx profile rm existing-profile --global")
	})

	it("allows adding profile after explicit removal", async () => {
		// Setup global config
		const globalConfigDir = join(testDir, "opencode")
		const profilesDir = join(globalConfigDir, "profiles")
		await mkdir(profilesDir, { recursive: true })
		await writeFile(
			join(globalConfigDir, "ocx.jsonc"),
			JSON.stringify({ registries: { kdco: { url: registry.url } } }, null, 2),
		)

		// Create default profile
		await mkdir(join(profilesDir, "default"), { recursive: true })
		await writeFile(join(profilesDir, "default", "ocx.jsonc"), "{}")

		// Create existing profile manually
		await mkdir(join(profilesDir, "existing-profile"), { recursive: true })
		await writeFile(
			join(profilesDir, "existing-profile", "ocx.jsonc"),
			JSON.stringify({ some: "config" }, null, 2),
		)

		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		const env = { XDG_CONFIG_HOME: testDir }

		// Remove the profile
		const { exitCode: rmExitCode } = await runCLI(
			["profile", "rm", "existing-profile", "--global"],
			workDir,
			{
				env,
				isolated: true,
			},
		)
		expect(rmExitCode).toBe(0)

		// Then add the profile fresh (V2: with --global flag)
		const { exitCode } = await runCLI(["profile", "add", "existing-profile", "--global"], workDir, {
			env,
			isolated: true,
		})

		expect(exitCode).toBe(0)

		// Verify the profile was recreated
		const profileDir = join(profilesDir, "existing-profile")
		const newContent = await readFile(join(profileDir, "ocx.jsonc"), "utf-8")
		expect(newContent).not.toContain("content-that-will-be-overwritten")
	})
})

// =============================================================================
// INTEGRATION TESTS: Profile Type Validation
// =============================================================================

describe("ocx profile add --source (type validation)", () => {
	let testDir: string
	let registry: MockRegistry
	const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

	async function setupGlobalConfig(registries: Record<string, { url: string }>): Promise<string> {
		const globalConfigDir = join(testDir, "opencode")
		const profilesDir = join(globalConfigDir, "profiles")
		await mkdir(profilesDir, { recursive: true })
		await writeFile(join(globalConfigDir, "ocx.jsonc"), JSON.stringify({ registries }, null, 2))
		await mkdir(join(profilesDir, "default"), { recursive: true })
		await writeFile(join(profilesDir, "default", "ocx.jsonc"), "{}")
		return profilesDir
	}

	beforeAll(() => {
		registry = startMockRegistry()
	})

	afterAll(() => {
		registry.stop()
	})

	beforeEach(async () => {
		testDir = await createTempDir("profile-type")
		process.env.XDG_CONFIG_HOME = testDir
	})

	afterEach(async () => {
		if (originalXdgConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME
		} else {
			process.env.XDG_CONFIG_HOME = originalXdgConfigHome
		}
		if (testDir) {
			await cleanupTempDir(testDir)
		}
	})

	it("fails when component type is not profile", async () => {
		await setupGlobalConfig({ kdco: { url: registry.url } })

		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		// Try to install test-agent (which is type agent, not profile)
		const { exitCode, output } = await runCLI(
			["profile", "add", "agent-as-profile", "--source", "kdco/test-agent", "--global"],
			workDir,
			{
				env: { XDG_CONFIG_HOME: testDir },
				isolated: true,
			},
		)

		expect(exitCode).not.toBe(0)
		// V2: Error message uses type without ocx: prefix
		expect(output).toContain("agent")
		expect(output).toContain("profile")
	})

	it("fails when trying to install a plugin as a profile", async () => {
		await setupGlobalConfig({ kdco: { url: registry.url } })

		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		// Try to install test-plugin (which is type plugin, not profile)
		const { exitCode, output } = await runCLI(
			["profile", "add", "plugin-as-profile", "--source", "kdco/test-plugin", "--global"],
			workDir,
			{
				env: { XDG_CONFIG_HOME: testDir },
				isolated: true,
			},
		)

		expect(exitCode).not.toBe(0)
		// V2: Error message uses type without ocx: prefix
		expect(output).toContain("plugin")
		expect(output).toContain("profile")
	})

	it("rejects v2 profile manifests that still use ocx:profile", async () => {
		const prefixedRegistry = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url)

				if (url.pathname === "/index.json") {
					return Response.json({
						$schema: "https://ocx.kdco.dev/schemas/v2/registry.json",
						author: "Legacy-v2",
						components: [
							{
								name: "prefixed-profile",
								type: "ocx:profile",
								description: "Legacy-prefixed profile type",
							},
						],
					})
				}

				if (url.pathname === "/components/prefixed-profile.json") {
					return Response.json({
						name: "prefixed-profile",
						"dist-tags": { latest: "1.0.0" },
						versions: {
							"1.0.0": {
								name: "prefixed-profile",
								type: "ocx:profile",
								description: "Legacy-prefixed profile type",
								files: [
									{ path: "ocx.jsonc", target: "ocx.jsonc" },
									{ path: "opencode.jsonc", target: "opencode.jsonc" },
								],
								dependencies: [],
							},
						},
					})
				}

				if (url.pathname === "/components/prefixed-profile/ocx.jsonc") {
					return new Response(JSON.stringify({ registries: {} }, null, 2))
				}
				if (url.pathname === "/components/prefixed-profile/opencode.jsonc") {
					return new Response(JSON.stringify({}, null, 2))
				}

				return new Response("Not Found", { status: 404 })
			},
		})

		try {
			await setupGlobalConfig({ v2prefixed: { url: `http://localhost:${prefixedRegistry.port}` } })

			const workDir = join(testDir, "workspace")
			await mkdir(workDir, { recursive: true })

			const { exitCode, output } = await runCLI(
				[
					"profile",
					"add",
					"prefixed-profile",
					"--source",
					"v2prefixed/prefixed-profile",
					"--global",
				],
				workDir,
				{
					env: { XDG_CONFIG_HOME: testDir },
					isolated: true,
				},
			)

			expect(exitCode).not.toBe(0)
			expect(output).toContain("ocx:profile")
			expect(output).toContain('Use "profile"')
		} finally {
			prefixedRegistry.stop()
		}
	})

	it("accepts canonical v2 profile manifests during profile install", async () => {
		await setupGlobalConfig({ kdco: { url: registry.url } })

		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		const { exitCode } = await runCLI(
			["profile", "add", "canonical-profile", "--source", "kdco/test-profile", "--global"],
			workDir,
			{
				env: { XDG_CONFIG_HOME: testDir },
				isolated: true,
			},
		)

		expect(exitCode).toBe(0)
		expect(
			existsSync(join(testDir, "opencode", "profiles", "canonical-profile", "ocx.jsonc")),
		).toBe(true)
	})

	it("adapts legacy v1 prefixed profile manifests during profile install", async () => {
		const legacyRegistry = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url)

				if (url.pathname === "/index.json") {
					return Response.json({
						author: "Legacy-v1",
						components: [
							{
								name: "legacy-profile",
								type: "ocx:profile",
								description: "Legacy v1 profile",
							},
						],
					})
				}

				if (url.pathname === "/components/legacy-profile.json") {
					return Response.json({
						name: "legacy-profile",
						"dist-tags": { latest: "1.0.0" },
						versions: {
							"1.0.0": {
								name: "legacy-profile",
								type: "ocx:profile",
								description: "Legacy v1 profile",
								files: [
									{ path: "ocx.jsonc", target: ".opencode/ocx.jsonc" },
									{ path: "opencode.jsonc", target: ".opencode/opencode.jsonc" },
								],
								dependencies: [],
							},
						},
					})
				}

				if (url.pathname === "/components/legacy-profile/ocx.jsonc") {
					return new Response(JSON.stringify({ registries: {} }, null, 2))
				}
				if (url.pathname === "/components/legacy-profile/opencode.jsonc") {
					return new Response(JSON.stringify({}, null, 2))
				}

				return new Response("Not Found", { status: 404 })
			},
		})

		try {
			await setupGlobalConfig({ legacy: { url: `http://localhost:${legacyRegistry.port}` } })

			const workDir = join(testDir, "workspace")
			await mkdir(workDir, { recursive: true })

			const { exitCode } = await runCLI(
				["profile", "add", "legacy-profile", "--source", "legacy/legacy-profile", "--global"],
				workDir,
				{
					env: { XDG_CONFIG_HOME: testDir },
					isolated: true,
				},
			)

			expect(exitCode).toBe(0)
			expect(existsSync(join(testDir, "opencode", "profiles", "legacy-profile", "ocx.jsonc"))).toBe(
				true,
			)
		} finally {
			legacyRegistry.stop()
		}
	})
})

// =============================================================================
// INTEGRATION TESTS: Profile Cloning (--clone option)
// =============================================================================

describe("ocx profile add --clone (profile cloning)", () => {
	let testDir: string
	const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

	beforeEach(async () => {
		testDir = await createTempDir("profile-clone")
		process.env.XDG_CONFIG_HOME = testDir
	})

	afterEach(async () => {
		if (originalXdgConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME
		} else {
			process.env.XDG_CONFIG_HOME = originalXdgConfigHome
		}
		if (testDir) {
			await cleanupTempDir(testDir)
		}
	})

	it("clones settings from existing global profile (global to global)", async () => {
		// Setup global config
		const globalConfigDir = join(testDir, "opencode")
		const profilesDir = join(globalConfigDir, "profiles")
		await mkdir(profilesDir, { recursive: true })
		await writeFile(join(globalConfigDir, "ocx.jsonc"), JSON.stringify({ registries: {} }, null, 2))

		// Create source profile with specific config
		const sourceProfileDir = join(profilesDir, "source-profile")
		await mkdir(sourceProfileDir, { recursive: true })
		const sourceConfig = {
			registries: {
				custom: { url: "https://custom.registry.com" },
			},
			exclude: ["**/SECRET.md"],
		}
		await writeFile(join(sourceProfileDir, "ocx.jsonc"), JSON.stringify(sourceConfig, null, 2))

		// Create default profile
		await mkdir(join(profilesDir, "default"), { recursive: true })
		await writeFile(join(profilesDir, "default", "ocx.jsonc"), "{}")

		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		// V2: Clone using --clone option with --global flag
		const { exitCode, output } = await runCLI(
			["profile", "add", "cloned-profile", "--clone", "source-profile", "--global"],
			workDir,
			{
				env: { XDG_CONFIG_HOME: testDir },
				isolated: true,
			},
		)

		expect(exitCode).toBe(0)
		expect(output).toContain("cloned from")

		// Verify cloned profile has source's config
		const clonedConfig = parseJsonc(
			await readFile(join(profilesDir, "cloned-profile", "ocx.jsonc"), "utf-8"),
		) as typeof sourceConfig

		expect(clonedConfig.registries?.custom?.url).toBe("https://custom.registry.com")
		expect(clonedConfig.exclude).toContain("**/SECRET.md")
	})

	it("preserves raw ocx.jsonc bytes exactly when cloning global profile to global profile", async () => {
		// Setup global config
		const globalConfigDir = join(testDir, "opencode")
		const profilesDir = join(globalConfigDir, "profiles")
		await mkdir(profilesDir, { recursive: true })
		await writeFile(join(globalConfigDir, "ocx.jsonc"), JSON.stringify({ registries: {} }, null, 2))

		// Create source profile with non-trivial JSONC formatting/comments/newline
		const sourceProfileDir = join(profilesDir, "byte-source-global")
		await mkdir(sourceProfileDir, { recursive: true })
		const sourcePath = join(sourceProfileDir, "ocx.jsonc")
		const sourceBytes = `{
  // byte-preservation sentinel comment
  "$schema": "https://ocx.kdco.dev/schemas/ocx.json",
  "registries": { "custom": { "url": "https://custom.registry.com" } },
  "exclude": [
    "**/SECRET.md",
    // keep this comment exactly
    "**/PRIVATE.md"
  ],
  "include": []
}
`
		await writeFile(sourcePath, sourceBytes)
		const sourceRawBeforeClone = await readFile(sourcePath, "utf-8")

		// Create default profile
		await mkdir(join(profilesDir, "default"), { recursive: true })
		await writeFile(join(profilesDir, "default", "ocx.jsonc"), "{}")

		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		const { exitCode } = await runCLI(
			["profile", "add", "byte-cloned-global", "--clone", "byte-source-global", "--global"],
			workDir,
			{
				env: { XDG_CONFIG_HOME: testDir },
				isolated: true,
			},
		)

		expect(exitCode).toBe(0)

		const sourceRawAfterClone = await readFile(sourcePath, "utf-8")
		const clonedPath = join(profilesDir, "byte-cloned-global", "ocx.jsonc")
		const clonedRaw = await readFile(clonedPath, "utf-8")

		expect(sourceRawAfterClone).toBe(sourceRawBeforeClone)
		// RED contract: preserve exact bytes (comments/format/newline)
		expect(clonedRaw).toBe(sourceRawBeforeClone)

		// Keep semantic clone assertions intact
		const clonedConfig = parseJsonc(clonedRaw) as {
			registries?: { custom?: { url?: string } }
			exclude?: string[]
		}
		expect(clonedConfig.registries?.custom?.url).toBe("https://custom.registry.com")
		expect(clonedConfig.exclude).toContain("**/SECRET.md")
	})

	it("preserves default profile AGENTS.md comment line when cloning", async () => {
		// Setup global config
		const globalConfigDir = join(testDir, "opencode")
		const profilesDir = join(globalConfigDir, "profiles")
		await mkdir(profilesDir, { recursive: true })
		await writeFile(join(globalConfigDir, "ocx.jsonc"), JSON.stringify({ registries: {} }, null, 2))

		// Create default profile with the canonical commented AGENTS.md exclude line
		const defaultProfileDir = join(profilesDir, "default")
		await mkdir(defaultProfileDir, { recursive: true })
		const defaultPath = join(defaultProfileDir, "ocx.jsonc")
		const defaultBytes = `{
  "$schema": "https://ocx.kdco.dev/schemas/ocx.json",
  "registries": {},
  "renameWindow": true,
  "exclude": [
    // "**/AGENTS.md",
    "**/CLAUDE.md",
    "**/CONTEXT.md",
    "**/.opencode/**",
    "**/opencode.jsonc",
    "**/opencode.json"
  ],
  "include": []
}
`
		await writeFile(defaultPath, defaultBytes)
		const sourceRawBeforeClone = await readFile(defaultPath, "utf-8")

		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		const { exitCode } = await runCLI(
			["profile", "add", "default-clone", "--clone", "default", "--global"],
			workDir,
			{
				env: { XDG_CONFIG_HOME: testDir },
				isolated: true,
			},
		)

		expect(exitCode).toBe(0)

		const sourceRawAfterClone = await readFile(defaultPath, "utf-8")
		const clonedPath = join(profilesDir, "default-clone", "ocx.jsonc")
		const clonedRaw = await readFile(clonedPath, "utf-8")

		expect(sourceRawBeforeClone).toContain('// "**/AGENTS.md",')
		expect(sourceRawAfterClone).toBe(sourceRawBeforeClone)
		// RED contract: commented AGENTS.md line (and full raw bytes) must be preserved
		expect(clonedRaw).toContain('// "**/AGENTS.md",')
		expect(clonedRaw).toBe(sourceRawBeforeClone)
	})

	it("fails when source profile does not exist", async () => {
		// Setup global config
		const globalConfigDir = join(testDir, "opencode")
		const profilesDir = join(globalConfigDir, "profiles")
		await mkdir(profilesDir, { recursive: true })
		await writeFile(join(globalConfigDir, "ocx.jsonc"), JSON.stringify({ registries: {} }, null, 2))

		// Create default profile
		await mkdir(join(profilesDir, "default"), { recursive: true })
		await writeFile(join(profilesDir, "default", "ocx.jsonc"), "{}")

		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		// V2: Try to clone from non-existent profile using --clone (with --global flag)
		const { exitCode, output } = await runCLI(
			["profile", "add", "cloned-from-nothing", "--clone", "nonexistent-profile", "--global"],
			workDir,
			{
				env: { XDG_CONFIG_HOME: testDir },
				isolated: true,
			},
		)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("not found")
	})
})

// =============================================================================
// INTEGRATION TESTS: Registry Profile Installation (--source option)
// =============================================================================

describe("ocx profile add --source (registry installation)", () => {
	let testDir: string
	let registry: MockRegistry
	const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

	beforeAll(() => {
		registry = startMockRegistry()
	})

	afterAll(() => {
		registry.stop()
	})

	beforeEach(async () => {
		testDir = await createTempDir("profile-registry-install")
		process.env.XDG_CONFIG_HOME = testDir
	})

	afterEach(async () => {
		if (originalXdgConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME
		} else {
			process.env.XDG_CONFIG_HOME = originalXdgConfigHome
		}
		if (testDir) {
			await cleanupTempDir(testDir)
		}
	})

	it("installs profile from configured registry with receipt-only state", async () => {
		// Setup global config with registry configured
		const globalConfigDir = join(testDir, "opencode")
		const profilesDir = join(globalConfigDir, "profiles")
		await mkdir(profilesDir, { recursive: true })
		await writeFile(
			join(globalConfigDir, "ocx.jsonc"),
			JSON.stringify({ registries: { kdco: { url: registry.url } } }, null, 2),
		)

		// Create default profile (required for initialization)
		await mkdir(join(profilesDir, "default"), { recursive: true })
		await writeFile(join(profilesDir, "default", "ocx.jsonc"), "{}")

		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		// V2: Install profile from registry using --source
		const { exitCode, output } = await runCLI(
			["profile", "add", "work", "--source", "kdco/test-profile", "--global"],
			workDir,
		)

		if (exitCode !== 0) {
			console.log("Output:", output)
		}
		expect(exitCode).toBe(0)

		// Verify profile files created
		const profileDir = join(profilesDir, "work")
		expect(existsSync(join(profileDir, "ocx.jsonc"))).toBe(true)
		expect(existsSync(join(profileDir, "opencode.jsonc"))).toBe(true)
		expect(existsSync(join(profileDir, "AGENTS.md"))).toBe(true)

		// Verify receipt exists and legacy lock does not
		expect(existsSync(join(profileDir, "ocx.lock"))).toBe(false)
		const receiptPath = join(profileDir, ".ocx", "receipt.jsonc")
		expect(existsSync(receiptPath)).toBe(true)
		const receiptContent = parseJsonc(await readFile(receiptPath, "utf-8")) as {
			version: number
			root?: string
			installed: Record<string, unknown>
			profileSource?: unknown
			installedFrom?: unknown
		}
		expect(receiptContent.version).toBe(1)
		expect(receiptContent.root).toBe(profileDir)
		expect(receiptContent.installed).toEqual({})
		expect("profileSource" in receiptContent).toBe(false)
		expect("installedFrom" in receiptContent).toBe(false)
	})

	it("installs profile from ephemeral registry using --source with --from", async () => {
		// Setup global config WITHOUT the registry (ephemeral mode)
		const globalConfigDir = join(testDir, "opencode")
		const profilesDir = join(globalConfigDir, "profiles")
		await mkdir(profilesDir, { recursive: true })
		await writeFile(join(globalConfigDir, "ocx.jsonc"), JSON.stringify({ registries: {} }, null, 2))

		// Create default profile (required for initialization)
		await mkdir(join(profilesDir, "default"), { recursive: true })
		await writeFile(join(profilesDir, "default", "ocx.jsonc"), "{}")

		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		// V2: Install profile from ephemeral registry using --source and --from
		const { exitCode, output } = await runCLI(
			[
				"profile",
				"add",
				"ephemeral-profile",
				"--source",
				"kdco/test-profile",
				"--from",
				registry.url,
				"--global",
			],
			workDir,
		)

		if (exitCode !== 0) {
			console.log("Output:", output)
		}
		expect(exitCode).toBe(0)

		// Verify profile files created
		const profileDir = join(profilesDir, "ephemeral-profile")
		expect(existsSync(join(profileDir, "ocx.jsonc"))).toBe(true)
		expect(existsSync(join(profileDir, "opencode.jsonc"))).toBe(true)
		expect(existsSync(join(profileDir, "AGENTS.md"))).toBe(true)
		expect(existsSync(join(profileDir, "ocx.lock"))).toBe(false)
		expect(existsSync(join(profileDir, ".ocx", "receipt.jsonc"))).toBe(true)
	})

	it("surfaces source-registry diagnostics for initial ephemeral failures in human and JSON output", async () => {
		const globalConfigDir = join(testDir, "opencode")
		const profilesDir = join(globalConfigDir, "profiles")
		await mkdir(profilesDir, { recursive: true })
		await writeFile(join(globalConfigDir, "ocx.jsonc"), JSON.stringify({ registries: {} }, null, 2))
		await mkdir(join(profilesDir, "default"), { recursive: true })
		await writeFile(join(profilesDir, "default", "ocx.jsonc"), "{}")

		registry.setRouteError("/components/test-profile.json", 503, "Source registry unavailable")
		_clearFetcherCacheForTests()

		try {
			const workDir = join(testDir, "workspace")
			await mkdir(workDir, { recursive: true })

			const textAttempt = await runCLI(
				[
					"profile",
					"add",
					"ephemeral-source-fail-text",
					"--source",
					"kdco/test-profile",
					"--from",
					registry.url,
					"--global",
				],
				workDir,
			)

			expect(textAttempt.exitCode).toBe(69)
			expect(textAttempt.output).toContain("phase: packument-fetch")
			expect(textAttempt.output).toContain("qualifiedName: kdco/test-profile")
			expect(textAttempt.output).toContain("registryContext: source")
			expect(textAttempt.output).toContain("registryName: kdco")
			expect(textAttempt.output).toContain(`${registry.url}/components/test-profile.json`)
			expect(existsSync(join(profilesDir, "ephemeral-source-fail-text"))).toBe(false)

			_clearFetcherCacheForTests()

			const jsonAttempt = await runCLI(
				[
					"profile",
					"add",
					"ephemeral-source-fail-json",
					"--source",
					"kdco/test-profile",
					"--from",
					registry.url,
					"--global",
					"--json",
				],
				workDir,
			)

			expect(jsonAttempt.exitCode).toBe(69)
			const jsonPayload = JSON.parse(jsonAttempt.stdout || jsonAttempt.stderr) as {
				success: false
				error: {
					code: string
					details?: {
						url?: string
						phase?: string
						qualifiedName?: string
						registryContext?: string
						registryName?: string
						status?: number
					}
				}
			}

			expect(jsonPayload.success).toBe(false)
			expect(jsonPayload.error.code).toBe("NETWORK_ERROR")
			expect(jsonPayload.error.details?.url).toContain(
				`${registry.url}/components/test-profile.json`,
			)
			expect(jsonPayload.error.details?.phase).toBe("packument-fetch")
			expect(jsonPayload.error.details?.qualifiedName).toBe("kdco/test-profile")
			expect(jsonPayload.error.details?.registryContext).toBe("source")
			expect(jsonPayload.error.details?.registryName).toBe("kdco")
			expect(jsonPayload.error.details?.status).toBe(503)
			expect(existsSync(join(profilesDir, "ephemeral-source-fail-json"))).toBe(false)
		} finally {
			registry.clearRouteOverrides()
			_clearFetcherCacheForTests()
		}
	})

	it("surfaces dependency-registry diagnostics after profile download and rolls back in human and JSON output", async () => {
		const globalConfigDir = join(testDir, "opencode")
		const profilesDir = join(globalConfigDir, "profiles")
		await mkdir(profilesDir, { recursive: true })
		await writeFile(
			join(globalConfigDir, "ocx.jsonc"),
			JSON.stringify({ registries: { kdco: { url: registry.url } } }, null, 2),
		)
		await mkdir(join(profilesDir, "default"), { recursive: true })
		await writeFile(join(profilesDir, "default", "ocx.jsonc"), "{}")

		const dependencyRegistry = startMockRegistry()

		try {
			dependencyRegistry.setRouteError(
				"/components/test-plugin.json",
				503,
				"Dependency unavailable",
			)
			registry.setFileContent(
				"test-profile-with-deps",
				"ocx.jsonc",
				JSON.stringify({ registries: { kdco: { url: dependencyRegistry.url } } }, null, 2),
			)
			_clearFetcherCacheForTests()

			const workDir = join(testDir, "workspace")
			await mkdir(workDir, { recursive: true })

			const textProfileName = "dependency-fail-text"
			const textAttempt = await runCLI(
				["profile", "add", textProfileName, "--source", "kdco/test-profile-with-deps", "--global"],
				workDir,
				{
					env: { XDG_CONFIG_HOME: testDir },
					isolated: true,
				},
			)

			expect(textAttempt.exitCode).toBe(69)
			expect(textAttempt.output).toContain("phase: packument-fetch")
			expect(textAttempt.output).toContain("qualifiedName: kdco/test-plugin")
			expect(textAttempt.output).toContain("registryContext: dependency")
			expect(textAttempt.output).toContain("registryName: kdco")
			expect(textAttempt.output).toContain(`${dependencyRegistry.url}/components/test-plugin.json`)
			expect(existsSync(join(profilesDir, textProfileName))).toBe(false)
			const textEntries = await readdir(profilesDir)
			expect(textEntries.some((entry) => entry.startsWith(".staging-"))).toBe(false)

			_clearFetcherCacheForTests()

			const jsonProfileName = "dependency-fail-json"
			const jsonAttempt = await runCLI(
				[
					"profile",
					"add",
					jsonProfileName,
					"--source",
					"kdco/test-profile-with-deps",
					"--global",
					"--json",
				],
				workDir,
				{
					env: { XDG_CONFIG_HOME: testDir },
					isolated: true,
				},
			)

			expect(jsonAttempt.exitCode).toBe(69)
			const jsonPayload = JSON.parse(jsonAttempt.stdout || jsonAttempt.stderr) as {
				success: false
				error: {
					code: string
					details?: {
						url?: string
						phase?: string
						qualifiedName?: string
						registryContext?: string
						registryName?: string
						status?: number
					}
				}
			}

			expect(jsonPayload.success).toBe(false)
			expect(jsonPayload.error.code).toBe("NETWORK_ERROR")
			expect(jsonPayload.error.details?.url).toContain(
				`${dependencyRegistry.url}/components/test-plugin.json`,
			)
			expect(jsonPayload.error.details?.phase).toBe("packument-fetch")
			expect(jsonPayload.error.details?.qualifiedName).toBe("kdco/test-plugin")
			expect(jsonPayload.error.details?.registryContext).toBe("dependency")
			expect(jsonPayload.error.details?.registryName).toBe("kdco")
			expect(jsonPayload.error.details?.status).toBe(503)
			expect(existsSync(join(profilesDir, jsonProfileName))).toBe(false)
			const jsonEntries = await readdir(profilesDir)
			expect(jsonEntries.some((entry) => entry.startsWith(".staging-"))).toBe(false)
		} finally {
			dependencyRegistry.stop()
			registry.clearRouteOverrides()
			registry.clearFileContent()
			_clearFetcherCacheForTests()
		}
	})

	it("reports actual transitive dependency context in dependency diagnostics", async () => {
		const globalConfigDir = join(testDir, "opencode")
		const profilesDir = join(globalConfigDir, "profiles")
		await mkdir(profilesDir, { recursive: true })
		await writeFile(
			join(globalConfigDir, "ocx.jsonc"),
			JSON.stringify({ registries: { kdco: { url: registry.url } } }, null, 2),
		)
		await mkdir(join(profilesDir, "default"), { recursive: true })
		await writeFile(join(profilesDir, "default", "ocx.jsonc"), "{}")

		const transitiveRegistry = startMockRegistry()

		try {
			registry.setRouteError(
				"/components/test-profile-with-deps.json",
				200,
				JSON.stringify({
					name: "test-profile-with-deps",
					"dist-tags": { latest: "1.0.0" },
					versions: {
						"1.0.0": {
							name: "test-profile-with-deps",
							type: "profile",
							description: "Profile that resolves through a transitive dependency",
							files: [
								{ path: "ocx.jsonc", target: "ocx.jsonc" },
								{ path: "opencode.jsonc", target: "opencode.jsonc" },
								{ path: "AGENTS.md", target: "AGENTS.md" },
							],
							dependencies: ["test-agent"],
						},
					},
				}),
			)

			registry.setRouteError(
				"/components/test-agent.json",
				200,
				JSON.stringify({
					name: "test-agent",
					"dist-tags": { latest: "1.0.0" },
					versions: {
						"1.0.0": {
							name: "test-agent",
							type: "agent",
							description: "Agent that depends on cross-registry plugin",
							files: [{ path: "agent.md", target: "agents/test-agent.md" }],
							dependencies: ["dep/test-plugin"],
						},
					},
				}),
			)

			registry.setFileContent(
				"test-profile-with-deps",
				"ocx.jsonc",
				JSON.stringify(
					{
						registries: {
							kdco: { url: registry.url },
							dep: { url: transitiveRegistry.url },
						},
					},
					null,
					2,
				),
			)

			transitiveRegistry.setRouteError(
				"/components/test-plugin.json",
				503,
				"Transitive dependency unavailable",
			)
			_clearFetcherCacheForTests()

			const workDir = join(testDir, "workspace")
			await mkdir(workDir, { recursive: true })

			const textProfileName = "transitive-context-fail-text"
			const textAttempt = await runCLI(
				["profile", "add", textProfileName, "--source", "kdco/test-profile-with-deps", "--global"],
				workDir,
				{
					env: { XDG_CONFIG_HOME: testDir },
					isolated: true,
				},
			)

			expect(textAttempt.exitCode).toBe(69)
			expect(textAttempt.output).toContain("phase: packument-fetch")
			expect(textAttempt.output).toContain("qualifiedName: dep/test-plugin")
			expect(textAttempt.output).toContain("registryContext: dependency")
			expect(textAttempt.output).toContain("registryName: dep")
			expect(textAttempt.output).toContain(`${transitiveRegistry.url}/components/test-plugin.json`)
			expect(textAttempt.output).not.toContain("qualifiedName: kdco/test-agent")
			expect(existsSync(join(profilesDir, textProfileName))).toBe(false)

			_clearFetcherCacheForTests()

			const jsonProfileName = "transitive-context-fail-json"
			const jsonAttempt = await runCLI(
				[
					"profile",
					"add",
					jsonProfileName,
					"--source",
					"kdco/test-profile-with-deps",
					"--global",
					"--json",
				],
				workDir,
				{
					env: { XDG_CONFIG_HOME: testDir },
					isolated: true,
				},
			)

			expect(jsonAttempt.exitCode).toBe(69)
			const jsonPayload = JSON.parse(jsonAttempt.stdout || jsonAttempt.stderr) as {
				success: false
				error: {
					code: string
					details?: {
						url?: string
						phase?: string
						qualifiedName?: string
						registryContext?: string
						registryName?: string
						status?: number
					}
				}
			}

			expect(jsonPayload.success).toBe(false)
			expect(jsonPayload.error.code).toBe("NETWORK_ERROR")
			expect(jsonPayload.error.details?.url).toContain(
				`${transitiveRegistry.url}/components/test-plugin.json`,
			)
			expect(jsonPayload.error.details?.phase).toBe("packument-fetch")
			expect(jsonPayload.error.details?.qualifiedName).toBe("dep/test-plugin")
			expect(jsonPayload.error.details?.registryContext).toBe("dependency")
			expect(jsonPayload.error.details?.registryName).toBe("dep")
			expect(jsonPayload.error.details?.status).toBe(503)
			expect(jsonPayload.error.details?.qualifiedName).not.toBe("kdco/test-agent")
			expect(existsSync(join(profilesDir, jsonProfileName))).toBe(false)
		} finally {
			transitiveRegistry.stop()
			registry.clearRouteOverrides()
			registry.clearFileContent()
			_clearFetcherCacheForTests()
		}
	})

	it("keeps dependency diagnostics accurate for registries hosted under a path prefix", async () => {
		const globalConfigDir = join(testDir, "opencode")
		const profilesDir = join(globalConfigDir, "profiles")
		await mkdir(profilesDir, { recursive: true })
		await writeFile(
			join(globalConfigDir, "ocx.jsonc"),
			JSON.stringify({ registries: { kdco: { url: registry.url } } }, null, 2),
		)
		await mkdir(join(profilesDir, "default"), { recursive: true })
		await writeFile(join(profilesDir, "default", "ocx.jsonc"), "{}")

		const transitiveRegistry = startMockRegistry()

		try {
			registry.setRouteError(
				"/components/test-profile-with-deps.json",
				200,
				JSON.stringify({
					name: "test-profile-with-deps",
					"dist-tags": { latest: "1.0.0" },
					versions: {
						"1.0.0": {
							name: "test-profile-with-deps",
							type: "profile",
							description: "Profile that resolves through a transitive dependency",
							files: [
								{ path: "ocx.jsonc", target: "ocx.jsonc" },
								{ path: "opencode.jsonc", target: "opencode.jsonc" },
								{ path: "AGENTS.md", target: "AGENTS.md" },
							],
							dependencies: ["test-agent"],
						},
					},
				}),
			)

			registry.setRouteError(
				"/components/test-agent.json",
				200,
				JSON.stringify({
					name: "test-agent",
					"dist-tags": { latest: "1.0.0" },
					versions: {
						"1.0.0": {
							name: "test-agent",
							type: "agent",
							description: "Agent that depends on cross-registry plugin",
							files: [{ path: "agent.md", target: "agents/test-agent.md" }],
							dependencies: ["dep/test-plugin"],
						},
					},
				}),
			)

			registry.setFileContent(
				"test-profile-with-deps",
				"ocx.jsonc",
				JSON.stringify(
					{
						registries: {
							kdco: { url: registry.url },
							dep: { url: `${transitiveRegistry.url}/r` },
						},
					},
					null,
					2,
				),
			)

			transitiveRegistry.setRouteError(
				"/r/components/test-plugin.json",
				503,
				"Transitive dependency unavailable",
			)
			_clearFetcherCacheForTests()

			const workDir = join(testDir, "workspace")
			await mkdir(workDir, { recursive: true })

			const textProfileName = "prefix-context-fail-text"
			const textAttempt = await runCLI(
				["profile", "add", textProfileName, "--source", "kdco/test-profile-with-deps", "--global"],
				workDir,
				{
					env: { XDG_CONFIG_HOME: testDir },
					isolated: true,
				},
			)

			expect(textAttempt.exitCode).toBe(69)
			expect(textAttempt.output).toContain("qualifiedName: dep/test-plugin")
			expect(textAttempt.output).toContain("registryContext: dependency")
			expect(textAttempt.output).toContain("registryName: dep")
			expect(textAttempt.output).toContain(
				`${transitiveRegistry.url}/r/components/test-plugin.json`,
			)
			expect(textAttempt.output).not.toContain("qualifiedName: kdco/test-agent")
			expect(existsSync(join(profilesDir, textProfileName))).toBe(false)

			_clearFetcherCacheForTests()

			const jsonProfileName = "prefix-context-fail-json"
			const jsonAttempt = await runCLI(
				[
					"profile",
					"add",
					jsonProfileName,
					"--source",
					"kdco/test-profile-with-deps",
					"--global",
					"--json",
				],
				workDir,
				{
					env: { XDG_CONFIG_HOME: testDir },
					isolated: true,
				},
			)

			expect(jsonAttempt.exitCode).toBe(69)
			const jsonPayload = JSON.parse(jsonAttempt.stdout || jsonAttempt.stderr) as {
				success: false
				error: {
					code: string
					details?: {
						url?: string
						phase?: string
						qualifiedName?: string
						registryContext?: string
						registryName?: string
						status?: number
					}
				}
			}

			expect(jsonPayload.success).toBe(false)
			expect(jsonPayload.error.code).toBe("NETWORK_ERROR")
			expect(jsonPayload.error.details?.url).toContain(
				`${transitiveRegistry.url}/r/components/test-plugin.json`,
			)
			expect(jsonPayload.error.details?.phase).toBe("packument-fetch")
			expect(jsonPayload.error.details?.qualifiedName).toBe("dep/test-plugin")
			expect(jsonPayload.error.details?.registryContext).toBe("dependency")
			expect(jsonPayload.error.details?.registryName).toBe("dep")
			expect(jsonPayload.error.details?.status).toBe(503)
			expect(jsonPayload.error.details?.qualifiedName).not.toBe("kdco/test-agent")
			expect(existsSync(join(profilesDir, jsonProfileName))).toBe(false)
		} finally {
			transitiveRegistry.stop()
			registry.clearRouteOverrides()
			registry.clearFileContent()
			_clearFetcherCacheForTests()
		}
	})

	it("reports actual dependency context for transitive file-download failures", async () => {
		const globalConfigDir = join(testDir, "opencode")
		const profilesDir = join(globalConfigDir, "profiles")
		await mkdir(profilesDir, { recursive: true })
		await writeFile(
			join(globalConfigDir, "ocx.jsonc"),
			JSON.stringify({ registries: { kdco: { url: registry.url } } }, null, 2),
		)
		await mkdir(join(profilesDir, "default"), { recursive: true })
		await writeFile(join(profilesDir, "default", "ocx.jsonc"), "{}")

		const transitiveRegistry = startMockRegistry()

		try {
			registry.setRouteError(
				"/components/test-profile-with-deps.json",
				200,
				JSON.stringify({
					name: "test-profile-with-deps",
					"dist-tags": { latest: "1.0.0" },
					versions: {
						"1.0.0": {
							name: "test-profile-with-deps",
							type: "profile",
							description: "Profile that resolves through a transitive dependency",
							files: [
								{ path: "ocx.jsonc", target: "ocx.jsonc" },
								{ path: "opencode.jsonc", target: "opencode.jsonc" },
								{ path: "AGENTS.md", target: "AGENTS.md" },
							],
							dependencies: ["test-agent"],
						},
					},
				}),
			)

			registry.setRouteError(
				"/components/test-agent.json",
				200,
				JSON.stringify({
					name: "test-agent",
					"dist-tags": { latest: "1.0.0" },
					versions: {
						"1.0.0": {
							name: "test-agent",
							type: "agent",
							description: "Agent that depends on cross-registry plugin",
							files: [{ path: "agent.md", target: "agents/test-agent.md" }],
							dependencies: ["dep/test-plugin"],
						},
					},
				}),
			)

			registry.setFileContent(
				"test-profile-with-deps",
				"ocx.jsonc",
				JSON.stringify(
					{
						registries: {
							kdco: { url: registry.url },
							dep: { url: transitiveRegistry.url },
						},
					},
					null,
					2,
				),
			)

			transitiveRegistry.setRouteError(
				"/components/test-plugin/index.ts",
				503,
				"Transitive dependency file unavailable",
			)
			_clearFetcherCacheForTests()

			const workDir = join(testDir, "workspace")
			await mkdir(workDir, { recursive: true })

			const textProfileName = "transitive-file-fail-t"
			const textAttempt = await runCLI(
				["profile", "add", textProfileName, "--source", "kdco/test-profile-with-deps", "--global"],
				workDir,
				{
					env: { XDG_CONFIG_HOME: testDir },
					isolated: true,
				},
			)

			expect(textAttempt.exitCode).toBe(69)
			expect(textAttempt.output).toContain("phase: file-content-fetch")
			expect(textAttempt.output).toContain("qualifiedName: dep/test-plugin")
			expect(textAttempt.output).toContain("registryContext: dependency")
			expect(textAttempt.output).toContain("registryName: dep")
			expect(textAttempt.output).toContain(
				`${transitiveRegistry.url}/components/test-plugin/index.ts`,
			)
			expect(textAttempt.output).not.toContain("qualifiedName: kdco/test-agent")
			expect(existsSync(join(profilesDir, textProfileName))).toBe(false)

			_clearFetcherCacheForTests()

			const jsonProfileName = "transitive-file-fail-j"
			const jsonAttempt = await runCLI(
				[
					"profile",
					"add",
					jsonProfileName,
					"--source",
					"kdco/test-profile-with-deps",
					"--global",
					"--json",
				],
				workDir,
				{
					env: { XDG_CONFIG_HOME: testDir },
					isolated: true,
				},
			)

			expect(jsonAttempt.exitCode).toBe(69)
			const jsonPayload = JSON.parse(jsonAttempt.stdout || jsonAttempt.stderr) as {
				success: false
				error: {
					code: string
					details?: {
						url?: string
						phase?: string
						qualifiedName?: string
						registryContext?: string
						registryName?: string
						status?: number
					}
				}
			}

			expect(jsonPayload.success).toBe(false)
			expect(jsonPayload.error.code).toBe("NETWORK_ERROR")
			expect(jsonPayload.error.details?.url).toContain(
				`${transitiveRegistry.url}/components/test-plugin/index.ts`,
			)
			expect(jsonPayload.error.details?.phase).toBe("file-content-fetch")
			expect(jsonPayload.error.details?.qualifiedName).toBe("dep/test-plugin")
			expect(jsonPayload.error.details?.registryContext).toBe("dependency")
			expect(jsonPayload.error.details?.registryName).toBe("dep")
			expect(jsonPayload.error.details?.status).toBe(503)
			expect(jsonPayload.error.details?.qualifiedName).not.toBe("kdco/test-agent")
			expect(existsSync(join(profilesDir, jsonProfileName))).toBe(false)
		} finally {
			transitiveRegistry.stop()
			registry.clearRouteOverrides()
			registry.clearFileContent()
			_clearFetcherCacheForTests()
		}
	})

	it("should install profile dependencies flat (not in .opencode/)", async () => {
		// Setup global config with registry configured
		const globalConfigDir = join(testDir, "opencode")
		const profilesDir = join(globalConfigDir, "profiles")
		await mkdir(profilesDir, { recursive: true })
		await writeFile(
			join(globalConfigDir, "ocx.jsonc"),
			JSON.stringify({ registries: { kdco: { url: registry.url } } }, null, 2),
		)

		// Create default profile (required for initialization)
		await mkdir(join(profilesDir, "default"), { recursive: true })
		await writeFile(join(profilesDir, "default", "ocx.jsonc"), "{}")

		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		// V2: Install profile with dependencies from registry using --source
		const { exitCode, output } = await runCLI(
			["profile", "add", "test-with-deps", "--source", "kdco/test-profile-with-deps", "--global"],
			workDir,
			{
				env: { XDG_CONFIG_HOME: testDir },
				isolated: true,
			},
		)

		if (exitCode !== 0) {
			console.log("Output:", output)
		}
		expect(exitCode).toBe(0)

		const profileDir = join(profilesDir, "test-with-deps")

		// Verify profile files exist at root
		expect(existsSync(join(profileDir, "ocx.jsonc"))).toBe(true)
		expect(existsSync(join(profileDir, "opencode.jsonc"))).toBe(true)
		expect(existsSync(join(profileDir, "AGENTS.md"))).toBe(true)

		// V2: Verify dependency files are FLAT at root with root-relative paths
		expect(existsSync(join(profileDir, "plugins", "test-plugin.ts"))).toBe(true)

		// Verify NO .opencode/ directory exists - this is the key regression check
		expect(existsSync(join(profileDir, ".opencode"))).toBe(false)

		// Verify receipt file instead of ocx.lock
		const receiptPath = join(profileDir, ".ocx", "receipt.jsonc")
		expect(existsSync(receiptPath)).toBe(true)
		expect(existsSync(join(profileDir, "ocx.lock"))).toBe(false)
		const receiptContent = parseJsonc(await readFile(receiptPath, "utf-8")) as {
			version: number
			profileSource?: unknown
			installedFrom?: unknown
			installed: Record<string, unknown>
		}
		expect(receiptContent.version).toBe(1)
		expect(Object.keys(receiptContent.installed).length).toBeGreaterThan(0)
		expect("profileSource" in receiptContent).toBe(false)
		expect("installedFrom" in receiptContent).toBe(false)
	})

	it("rolls back promoted profile when dependency install fails after rename", async () => {
		const globalConfigDir = join(testDir, "opencode")
		const profilesDir = join(globalConfigDir, "profiles")
		await mkdir(profilesDir, { recursive: true })
		await writeFile(
			join(globalConfigDir, "ocx.jsonc"),
			JSON.stringify({ registries: { kdco: { url: registry.url } } }, null, 2),
		)

		await mkdir(join(profilesDir, "default"), { recursive: true })
		await writeFile(join(profilesDir, "default", "ocx.jsonc"), "{}")

		registry.setRouteError(
			"/components/test-plugin.json",
			200,
			JSON.stringify({
				name: "test-plugin",
				"dist-tags": {
					latest: "1.0.0",
				},
				versions: {
					"1.0.0": {
						name: "test-plugin",
						type: "plugin",
						description: "Dependency failure fixture",
						files: [
							{ path: "first.ts", target: "plugins/test-plugin.ts" },
							{ path: "keep.md", target: "plugins/write-failure-dir/.keep" },
							{ path: "second.md", target: "plugins/write-failure-dir" },
						],
						dependencies: [],
					},
				},
			}),
		)
		registry.setFileContent("test-plugin", "first.ts", "// dependency should roll back")
		registry.setFileContent("test-plugin", "keep.md", "keep")
		registry.setFileContent("test-plugin", "second.md", "second")
		_clearFetcherCacheForTests()

		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })
		const profileName = "broken-profile"
		const profileDir = join(profilesDir, profileName)

		try {
			const firstAttempt = await runCLI(
				["profile", "add", profileName, "--source", "kdco/test-profile-with-deps", "--global"],
				workDir,
				{
					env: { XDG_CONFIG_HOME: testDir },
					isolated: true,
				},
			)

			expect(firstAttempt.exitCode).not.toBe(0)
			expect(existsSync(profileDir)).toBe(false)
			const profileRootEntries = await readdir(profilesDir)
			expect(profileRootEntries.some((entry) => entry.startsWith(".staging-"))).toBe(false)
		} finally {
			registry.clearRouteOverrides()
			registry.clearFileContent()
			_clearFetcherCacheForTests()
		}

		const retryAttempt = await runCLI(
			["profile", "add", profileName, "--source", "kdco/test-profile-with-deps", "--global"],
			workDir,
			{
				env: { XDG_CONFIG_HOME: testDir },
				isolated: true,
			},
		)

		expect(retryAttempt.exitCode).toBe(0)
		expect(existsSync(join(profileDir, "plugins", "test-plugin.ts"))).toBe(true)
	})

	it("normalizes singular command targets to plural during profile install flows", async () => {
		const globalConfigDir = join(testDir, "opencode")
		const profilesDir = join(globalConfigDir, "profiles")
		await mkdir(profilesDir, { recursive: true })
		await writeFile(
			join(globalConfigDir, "ocx.jsonc"),
			JSON.stringify({ registries: { kdco: { url: registry.url } } }, null, 2),
		)

		await mkdir(join(profilesDir, "default"), { recursive: true })
		await writeFile(join(profilesDir, "default", "ocx.jsonc"), "{}")

		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		const { exitCode, output } = await runCLI(
			[
				"profile",
				"add",
				"command-root-profile",
				"--source",
				"kdco/test-profile-with-command-deps",
				"--global",
			],
			workDir,
			{
				env: { XDG_CONFIG_HOME: testDir },
				isolated: true,
			},
		)

		if (exitCode !== 0) {
			console.log("Output:", output)
		}
		expect(exitCode).toBe(0)

		const profileDir = join(profilesDir, "command-root-profile")
		expect(existsSync(join(profileDir, "commands", ".keep"))).toBe(true)
		expect(existsSync(join(profileDir, "commands", "test-command-singular.md"))).toBe(true)
		expect(existsSync(join(profileDir, "command", "test-command-singular.md"))).toBe(false)
	})

	it("fails loud on intra-batch collisions while writing profile files", async () => {
		const globalConfigDir = join(testDir, "opencode")
		const profilesDir = join(globalConfigDir, "profiles")
		await mkdir(profilesDir, { recursive: true })
		await writeFile(
			join(globalConfigDir, "ocx.jsonc"),
			JSON.stringify({ registries: { kdco: { url: registry.url } } }, null, 2),
		)

		await mkdir(join(profilesDir, "default"), { recursive: true })
		await writeFile(join(profilesDir, "default", "ocx.jsonc"), "{}")

		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		const { exitCode, output } = await runCLI(
			[
				"profile",
				"add",
				"profile-collision",
				"--source",
				"kdco/test-profile-with-file-collision",
				"--global",
			],
			workDir,
			{
				env: { XDG_CONFIG_HOME: testDir },
				isolated: true,
			},
		)

		expect(exitCode).not.toBe(0)
		expect(output).toContain("Intra-batch target collision")
		expect(output).toContain("commands/shared-profile-collision.md")
		expect(existsSync(join(profilesDir, "profile-collision"))).toBe(false)
	})

	it("fails on malicious embedded traversal targets and leaves sibling profiles untouched", async () => {
		const globalConfigDir = join(testDir, "opencode")
		const profilesDir = join(globalConfigDir, "profiles")
		await mkdir(profilesDir, { recursive: true })
		await writeFile(
			join(globalConfigDir, "ocx.jsonc"),
			JSON.stringify({ registries: { kdco: { url: registry.url } } }, null, 2),
		)

		await mkdir(join(profilesDir, "default"), { recursive: true })
		await writeFile(join(profilesDir, "default", "ocx.jsonc"), "{}")

		const siblingProfileDir = join(profilesDir, "safe-profile")
		await mkdir(siblingProfileDir, { recursive: true })
		await writeFile(join(siblingProfileDir, "AGENTS.md"), "safe-sentinel")

		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		const { exitCode, output } = await runCLI(
			[
				"profile",
				"add",
				"malicious-profile",
				"--source",
				"kdco/test-profile-malicious-embedded",
				"--global",
			],
			workDir,
			{
				env: { XDG_CONFIG_HOME: testDir },
				isolated: true,
			},
		)

		expect(exitCode).not.toBe(0)
		expect(output).toMatch(/Invalid embedded target|Unsafe target|legacy \.opencode\/ prefix/)
		expect(existsSync(join(profilesDir, "victim.txt"))).toBe(false)
		expect(existsSync(join(profilesDir, "malicious-profile"))).toBe(false)
		expect(await readFile(join(siblingProfileDir, "AGENTS.md"), "utf-8")).toBe("safe-sentinel")
	})
})

// =============================================================================
// INTEGRATION TESTS: Global Config Edge Cases
// =============================================================================

describe("ocx profile add (global config edge cases)", () => {
	let testDir: string
	const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

	beforeEach(async () => {
		testDir = await createTempDir("profile-global-config")
		process.env.XDG_CONFIG_HOME = testDir
	})

	afterEach(async () => {
		if (originalXdgConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME
		} else {
			process.env.XDG_CONFIG_HOME = originalXdgConfigHome
		}
		if (testDir) {
			await cleanupTempDir(testDir)
		}
	})

	it("handles missing global config directory gracefully", async () => {
		// Don't create any global config - XDG_CONFIG_HOME points to empty temp dir
		const workDir = join(testDir, "workspace")
		await mkdir(workDir, { recursive: true })

		// Try to add a profile - should fail gracefully with clear error
		const { exitCode, output } = await runCLI(["profile", "add", "new-profile"], workDir)

		// Should fail but with a clear, actionable error message
		expect(exitCode).not.toBe(0)
		// Error should indicate profiles need to be initialized
		expect(
			output.includes("not initialized") ||
				output.includes("Run 'ocx init") ||
				output.includes("profiles"),
		).toBe(true)
	})
})

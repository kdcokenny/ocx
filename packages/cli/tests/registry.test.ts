import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { join } from "node:path"
import { cleanupTempDir, createTempDir, parseJsonc, runCLI } from "./helpers"
import { type MockRegistry, startMockRegistry } from "./mock-registry"

describe("registry add conflict matrix", () => {
	let testDir: string
	let registry: MockRegistry

	beforeEach(async () => {
		testDir = await createTempDir("registry-conflict-test")
		registry = startMockRegistry()
		await runCLI(["init", "--project"], testDir)
	})

	afterEach(async () => {
		registry.stop()
		await cleanupTempDir(testDir)
	})

	// Rule 1: New name + new URL => add (covered by "should add a registry" above)

	// Rule 2: Same name + same normalized URL => idempotent no-op
	it("should succeed idempotently when adding same name + same URL", async () => {
		// Add initial registry
		await runCLI(["registry", "add", "--project", registry.url, "--name", "kdco"], testDir)

		// Re-add with exact same name + URL
		const result = await runCLI(
			["registry", "add", "--project", registry.url, "--name", "kdco"],
			testDir,
		)

		expect(result.exitCode).toBe(0)
		expect(JSON.parse(result.stdout).alreadyConfigured).toBe(true)

		// Config unchanged
		const configPath = join(testDir, ".opencode", "ocx.jsonc")
		const configContent = await Bun.file(configPath).text()
		const config = parseJsonc(configContent) as { registries: Record<string, { url: string }> }
		expect(config.registries.kdco.url).toBe(registry.url)
	})

	// Rule 3: Same name + different URL => conflict error
	it("should fail when same name points to a different URL", async () => {
		// Add initial registry
		await runCLI(["registry", "add", "--project", registry.url, "--name", "kdco"], testDir)

		// Start a second mock registry to get a different valid URL
		const registry2 = startMockRegistry()
		try {
			const result = await runCLI(
				["registry", "add", "--project", registry2.url, "--name", "kdco"],
				testDir,
			)

			expect(result.exitCode).toBe(6)
			expect(result.stderr).toContain("already exists")
			expect(result.stderr).toContain("ocx registry remove kdco")
			expect(result.stderr).not.toContain("--force")
		} finally {
			registry2.stop()
		}
	})

	// Rule 4: Different name + same URL => conflict error
	it("should fail when different name points to same URL", async () => {
		// Add initial registry
		await runCLI(["registry", "add", "--project", registry.url, "--name", "kdco"], testDir)

		// Try to add same URL under different name
		const result = await runCLI(
			["registry", "add", "--project", registry.url, "--name", "other-alias"],
			testDir,
		)

		expect(result.exitCode).toBe(6)
		expect(result.stderr).toContain("already registered under name")
		expect(result.stderr).toContain("kdco")
		expect(result.stderr).toContain("ocx registry remove kdco")
		expect(result.stderr).not.toContain("--force")
	})

	it("should show current and new URL in name-conflict error message", async () => {
		// First add registry with original URL
		await runCLI(["registry", "add", "--project", registry.url, "--name", "kdco"], testDir)

		// Start a second mock registry to get a different valid URL
		const registry2 = startMockRegistry()
		try {
			// Try to update with a DIFFERENT URL (same name)
			const result = await runCLI(
				["registry", "add", "--project", registry2.url, "--name", "kdco"],
				testDir,
			)

			// Error message should contain BOTH the existing and new URLs
			expect(result.stderr).toContain(registry.url) // existing URL
			expect(result.stderr).toContain(registry2.url) // new URL
		} finally {
			registry2.stop()
		}
	})

	it("should output structured JSON for name conflict with --json flag", async () => {
		// First add registry with original URL
		await runCLI(["registry", "add", "--project", registry.url, "--name", "kdco"], testDir)

		// Start a second mock registry to get a different valid URL
		const registry2 = startMockRegistry()
		try {
			// Try to add with DIFFERENT URL to trigger name conflict
			const result = await runCLI(
				["registry", "add", "--project", registry2.url, "--name", "kdco", "--json"],
				testDir,
			)

			expect(result.exitCode).toBe(6)
			const output = JSON.parse(result.stdout || result.stderr)
			expect(output.success).toBe(false)
			expect(output.error.code).toBe("CONFLICT")
			expect(output.error.details.conflictType).toBe("name")
			expect(output.error.details.registryName).toBe("kdco")
			// Assert BOTH URLs are different and both present
			expect(output.error.details.existingUrl).toBe(registry.url)
			expect(output.error.details.newUrl).toBe(registry2.url)
			expect(output.error.details.existingUrl).not.toBe(output.error.details.newUrl)
			expect(output.meta.timestamp).toBeDefined()
		} finally {
			registry2.stop()
		}
	})

	it("should output structured JSON for URL conflict with --json flag", async () => {
		// First add registry
		await runCLI(["registry", "add", "--project", registry.url, "--name", "kdco"], testDir)

		// Try to add same URL under different name with --json
		const result = await runCLI(
			["registry", "add", "--project", registry.url, "--name", "another-alias", "--json"],
			testDir,
		)

		expect(result.exitCode).toBe(6)
		const output = JSON.parse(result.stdout || result.stderr)
		expect(output.success).toBe(false)
		expect(output.error.code).toBe("CONFLICT")
		expect(output.error.details.conflictType).toBe("url")
		expect(output.error.details.registryName).toBe("another-alias")
		expect(output.error.details.existingName).toBe("kdco")
		expect(output.meta.timestamp).toBeDefined()
	})

	it("should error for empty URL", async () => {
		const result = await runCLI(["registry", "add", "--project", "", "--name", "test"], testDir)
		expect(result.exitCode).not.toBe(0)
		expect(result.stderr).toContain("Registry URL is required")
	})

	it("should error for whitespace-only URL", async () => {
		const result = await runCLI(["registry", "add", "--project", "   ", "--name", "test"], testDir)
		expect(result.exitCode).not.toBe(0)
		expect(result.stderr).toContain("Registry URL is required")
	})

	it("should error for invalid protocol", async () => {
		const result = await runCLI(
			["registry", "add", "--project", "ftp://example.com", "--name", "test"],
			testDir,
		)
		expect(result.exitCode).not.toBe(0)
		expect(result.stderr).toContain("must use http, https, or file")
	})
})

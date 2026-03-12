/**
 * Integration tests for `registry add github:...` CLI path (P1 fix)
 *
 * Uses mock.module() to redirect resolveGitHubRegistry to the mock HTTP server,
 * so runRegistryAddCore exercises the real github: detection → resolve → fetch → store path.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import type { RegistryConfig } from "../src/schemas/config"
import { type MockRegistry, startMockRegistry } from "./mock-registry"

let mockRegistryUrl = ""

mock.module("../src/registry/github", () => ({
	isGitHubUrl: (input: string) => input.startsWith("github:"),
	resolveGitHubRegistry: async () => ({
		baseUrl: mockRegistryUrl,
		headers: {},
		source: "none" as const,
	}),
	parseGitHubUrl: () => {
		throw new Error("not mocked — use resolveGitHubRegistry")
	},
	resolveGitHubBaseUrl: () => {
		throw new Error("not mocked — use resolveGitHubRegistry")
	},
	resolveGitHubAuthToken: async () => null,
	buildGitHubHeaders: () => ({}),
	ValidationError: class extends Error {},
}))

// Import AFTER mock.module — reordering this breaks the mock wiring
import { runRegistryAddCore } from "../src/commands/registry"

function createCallbacks(registries: Record<string, RegistryConfig>) {
	return {
		getRegistries: () => registries,
		isLocked: () => false,
		setRegistry: async (name: string, config: RegistryConfig) => {
			registries[name] = config
		},
		targetLabel: "test config",
	}
}

function minimalOptions(name: string) {
	return { name, cwd: "/tmp", json: false, quiet: false }
}

describe("registry add github: integration path", () => {
	let mockRegistry: MockRegistry
	let registries: Record<string, RegistryConfig>

	beforeEach(() => {
		mockRegistry = startMockRegistry()
		mockRegistryUrl = mockRegistry.url
		registries = {}
	})

	afterEach(() => {
		mockRegistry.stop()
	})

	it("should resolve github: URL, validate index.json, and store config", async () => {
		const result = await runRegistryAddCore(
			"github:test-org/test-repo",
			minimalOptions("ghtest"),
			createCallbacks(registries),
		)

		expect("dryRun" in result).toBe(false)

		const addResult = result as {
			name: string
			url: string
			updated: boolean
			alreadyConfigured: boolean
		}
		expect(addResult.name).toBe("ghtest")
		expect(addResult.alreadyConfigured).toBe(false)
		expect(registries["ghtest"]).toBeDefined()
		expect(registries["ghtest"].url).toContain("localhost")
	})

	it("should store original github: URL as source (not auth method string)", async () => {
		await runRegistryAddCore(
			"github:test-org/test-repo",
			minimalOptions("ghtest"),
			createCallbacks(registries),
		)

		expect(registries["ghtest"].source).toBe("github:test-org/test-repo")
	})

	it("should preserve ref in source field", async () => {
		await runRegistryAddCore(
			"github:myorg/my-registry@v2.0",
			minimalOptions("myrepo"),
			createCallbacks(registries),
		)

		expect(registries["myrepo"].source).toBe("github:myorg/my-registry@v2.0")
	})

	it("should be idempotent when re-adding same github: URL with same name", async () => {
		await runRegistryAddCore(
			"github:test-org/test-repo",
			minimalOptions("ghtest"),
			createCallbacks(registries),
		)

		const result = await runRegistryAddCore(
			"github:test-org/test-repo",
			minimalOptions("ghtest"),
			createCallbacks(registries),
		)

		const addResult = result as { alreadyConfigured: boolean }
		expect(addResult.alreadyConfigured).toBe(true)
	})

	it("should fail with actionable error on 401", async () => {
		mockRegistry.setRouteError("/index.json", 401, "Unauthorized")

		await expect(
			runRegistryAddCore(
				"github:private-org/secret-repo",
				minimalOptions("secret"),
				createCallbacks(registries),
			),
		).rejects.toThrow("Authentication failed")
	})

	it("should fail with actionable error on 403", async () => {
		mockRegistry.setRouteError("/index.json", 403, "Forbidden")

		await expect(
			runRegistryAddCore(
				"github:private-org/secret-repo",
				minimalOptions("secret"),
				createCallbacks(registries),
			),
		).rejects.toThrow("Authentication failed")
	})

	it("should fail when index.json serves malformed content", async () => {
		mockRegistry.setRouteMalformed("/index.json")

		await expect(
			runRegistryAddCore(
				"github:test-org/bad-repo",
				minimalOptions("bad"),
				createCallbacks(registries),
			),
		).rejects.toThrow()
	})

	it("should fail when index.json returns 404", async () => {
		mockRegistry.setRouteError("/index.json", 404, "Not Found")

		await expect(
			runRegistryAddCore(
				"github:test-org/missing-repo",
				minimalOptions("missing"),
				createCallbacks(registries),
			),
		).rejects.toThrow()
	})

	it("should reject URL conflict when same resolved URL registered under different name", async () => {
		await runRegistryAddCore(
			"github:test-org/test-repo",
			minimalOptions("first-name"),
			createCallbacks(registries),
		)

		await expect(
			runRegistryAddCore(
				"github:test-org/test-repo",
				minimalOptions("second-name"),
				createCallbacks(registries),
			),
		).rejects.toThrow()
	})

	it("should support dry-run mode", async () => {
		const result = await runRegistryAddCore(
			"github:test-org/test-repo",
			{ ...minimalOptions("ghtest"), dryRun: true },
			createCallbacks(registries),
		)

		expect("dryRun" in result).toBe(true)
		expect(registries["ghtest"]).toBeUndefined()
	})
})

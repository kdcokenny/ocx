/**
 * Tests for env var resolution in serialized configuration strings.
 */

import { describe, expect, it } from "bun:test"
import { resolveEnvVars } from "../src/utils/resolve-env"

const env = {
	API_KEY: "sk-test-123",
	SERVICE_URL: "https://api.example.com",
	EMPTY_VAR: "",
}

describe("resolveEnvVars", () => {
	it("resolves a single pattern", () => {
		expect(resolveEnvVars("{env:API_KEY}", env)).toBe("sk-test-123")
	})

	it("resolves multiple patterns in one string", () => {
		expect(resolveEnvVars("{env:SERVICE_URL}?key={env:API_KEY}", env)).toBe(
			"https://api.example.com?key=sk-test-123",
		)
	})

	it("returns string unchanged when no patterns present", () => {
		expect(resolveEnvVars("no-env-vars-here", env)).toBe("no-env-vars-here")
	})

	it("replaces unset variables with empty string", () => {
		expect(resolveEnvVars("{env:DOES_NOT_EXIST}", env)).toBe("")
	})

	it("preserves text around the pattern", () => {
		expect(resolveEnvVars("prefix-{env:API_KEY}-suffix", env)).toBe("prefix-sk-test-123-suffix")
	})

	it("handles empty env var value", () => {
		expect(resolveEnvVars("{env:EMPTY_VAR}", env)).toBe("")
	})

	it("handles empty string input", () => {
		expect(resolveEnvVars("", env)).toBe("")
	})

	it("resolves patterns in serialized JSON config", () => {
		const config = {
			mcp: {
				"db-server": {
					type: "local",
					command: ["npx", "-y", "some-mcp-server"],
					environment: {
						CONNECTION_STRING: "{env:SERVICE_URL}",
					},
					enabled: true,
				},
				"api-server": {
					type: "remote",
					url: "https://remote.example.com",
					headers: {
						Authorization: "Bearer {env:API_KEY}",
					},
					enabled: true,
				},
			},
			theme: "dark",
		}

		const resolved = JSON.parse(resolveEnvVars(JSON.stringify(config), env))

		expect(resolved.mcp["db-server"].environment.CONNECTION_STRING).toBe("https://api.example.com")
		expect(resolved.mcp["api-server"].headers.Authorization).toBe("Bearer sk-test-123")
		expect(resolved.mcp["db-server"].type).toBe("local")
		expect(resolved.mcp["db-server"].enabled).toBe(true)
		expect(resolved.mcp["db-server"].command).toEqual(["npx", "-y", "some-mcp-server"])
		expect(resolved.theme).toBe("dark")
	})
})

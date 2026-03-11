/**
 * Registry header resolution for authenticated fetch calls
 *
 * Resolves headers for a registry by:
 * 1. Reading config.headers and expanding ${ENV_VAR} patterns
 * 2. Detecting GitHub-sourced registries via config.source field
 * 3. Merging GitHub auth token (if GitHub source detected)
 *
 * Auth token takes precedence over config headers for Authorization field.
 */

import type { RegistryConfig } from "../schemas/config"
import { expandEnvVars } from "../utils/env-expand"
import { buildGitHubHeaders, resolveGitHubAuthToken } from "./github"

/**
 * Resolve headers for a registry config.
 *
 * Process:
 * 1. Expand env vars in config.headers (${VAR} → process.env.VAR)
 * 2. Detect GitHub source via config.source?.startsWith("github:")
 * 3. If GitHub: resolve auth token and merge into headers (auth takes precedence)
 *
 * @param config - Registry configuration from ocx.jsonc
 * @returns Resolved headers ready for fetch calls
 *
 * @example
 * // Config with env var headers
 * const config = {
 *   url: "https://registry.example.com",
 *   headers: { "X-API-Key": "${API_KEY}" }
 * }
 * await resolveHeadersForRegistry(config)
 * // → { "X-API-Key": "abc123" } (if API_KEY=abc123)
 *
 * @example
 * // GitHub-sourced registry
 * const config = {
 *   url: "https://raw.githubusercontent.com/owner/repo/main",
 *   source: "github:owner/repo@main"
 * }
 * await resolveHeadersForRegistry(config)
 * // → { "Authorization": "token ghp_xxxx" } (if GITHUB_TOKEN set)
 */
export async function resolveHeadersForRegistry(
	config: RegistryConfig,
): Promise<Record<string, string>> {
	// Start with empty headers
	let headers: Record<string, string> = {}

	// Step 1: Expand env vars in config headers
	if (config.headers) {
		for (const [key, value] of Object.entries(config.headers)) {
			headers[key] = expandEnvVars(value)
		}
	}

	// Step 2: Detect GitHub source and merge auth token
	const isGitHub = config.source?.startsWith("github:")
	if (isGitHub) {
		const token = await resolveGitHubAuthToken()
		const githubHeaders = buildGitHubHeaders(token)

		// Merge GitHub headers (auth token takes precedence)
		headers = { ...headers, ...githubHeaders }
	}

	return headers
}

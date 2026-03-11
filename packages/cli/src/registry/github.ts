/**
 * GitHub URL parsing and auth token resolution for GitHub-based registries
 *
 * Supports github:owner/repo[@ref] format for accessing registries via GitHub raw content
 */

import { ValidationError } from "../utils/errors"

export { ValidationError }

/**
 * Parsed GitHub URL components
 */
export interface ParsedGitHubUrl {
	owner: string
	repo: string
	ref: string
}

/**
 * GitHub registry resolution result
 */
export interface ResolvedGitHubRegistry {
	baseUrl: string
	headers: Record<string, string>
	source: "gh-cli" | "env" | "none"
}

/**
 * Check if a URL string uses the github: protocol
 *
 * @param input - URL string to check
 * @returns true if input starts with "github:"
 *
 * @example
 * isGitHubUrl("github:owner/repo") // true
 * isGitHubUrl("https://example.com") // false
 */
export function isGitHubUrl(input: string): boolean {
	return input.startsWith("github:")
}

/**
 * Parse a GitHub URL into owner, repo, and ref components
 *
 * Format: github:owner/repo[@ref]
 * - owner: GitHub user or organization
 * - repo: Repository name
 * - ref: Optional branch/tag/commit (defaults to "main")
 *
 * @param input - GitHub URL string
 * @returns Parsed components
 * @throws {ValidationError} If URL format is invalid
 *
 * @example
 * parseGitHubUrl("github:myorg/my-registry")
 * // { owner: "myorg", repo: "my-registry", ref: "main" }
 *
 * parseGitHubUrl("github:myorg/my-registry@v2.0")
 * // { owner: "myorg", repo: "my-registry", ref: "v2.0" }
 */
export function parseGitHubUrl(input: string): ParsedGitHubUrl {
	// Validate github: prefix
	if (!isGitHubUrl(input)) {
		throw new ValidationError(`Invalid GitHub URL: must start with "github:" (got: "${input}")`)
	}

	// Strip github: prefix
	const withoutProtocol = input.slice(7) // "github:".length === 7

	// Split on @ to separate repo path from ref
	const atIndex = withoutProtocol.indexOf("@")
	const repoPath = atIndex === -1 ? withoutProtocol : withoutProtocol.slice(0, atIndex)
	const ref = atIndex === -1 ? "main" : withoutProtocol.slice(atIndex + 1)

	// Validate ref is not empty
	if (ref === "") {
		throw new ValidationError(`Invalid GitHub URL: ref cannot be empty (got: "${input}")`)
	}

	// Split repo path on /
	const parts = repoPath.split("/")

	// Must have exactly 2 parts: owner/repo
	if (parts.length !== 2) {
		if (parts.length === 1) {
			throw new ValidationError(
				`Invalid GitHub URL: must be "github:owner/repo[@ref]" (got: "${input}")`,
			)
		}
		throw new ValidationError(
			`Invalid GitHub URL: subdirectory paths not supported (got: "${input}")`,
		)
	}

	const [owner, repo] = parts as [string, string]

	// Validate owner and repo are not empty
	if (owner === "" || repo === "") {
		throw new ValidationError(
			`Invalid GitHub URL: owner and repo cannot be empty (got: "${input}")`,
		)
	}

	return { owner, repo, ref }
}

/**
 * Build the base URL for GitHub raw content
 *
 * @param parsed - Parsed GitHub URL components
 * @returns Base URL for raw.githubusercontent.com
 *
 * @example
 * resolveGitHubBaseUrl({ owner: "o", repo: "r", ref: "main" })
 * // "https://raw.githubusercontent.com/o/r/main"
 */
export function resolveGitHubBaseUrl(parsed: ParsedGitHubUrl): string {
	return `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${parsed.ref}`
}

/**
 * Attempt to resolve GitHub auth token from multiple sources
 *
 * Fallback chain:
 * 1. GITHUB_TOKEN environment variable (fastest, no subprocess)
 * 2. gh CLI (`gh auth token` with 5s timeout)
 * 3. null (no token available)
 *
 * @returns Auth token or null if unavailable
 *
 * @example
 * // With GITHUB_TOKEN env var set
 * await resolveGitHubAuthToken() // "ghp_xxxxxxxxxxxx"
 *
 * // With gh CLI logged in
 * await resolveGitHubAuthToken() // "ghp_yyyyyyyyyyyy"
 *
 * // No auth available
 * await resolveGitHubAuthToken() // null
 */
export async function resolveGitHubAuthToken(): Promise<string | null> {
	// Try 1: GITHUB_TOKEN env var (fastest, no subprocess)
	const envToken = process.env.GITHUB_TOKEN
	if (envToken) {
		return envToken
	}

	// Try 2: gh CLI (with timeout)
	try {
		const proc = Bun.spawn(["gh", "auth", "token"], {
			stdout: "pipe",
			stderr: "pipe",
		})

		// Set up 5 second timeout
		const timeoutPromise = new Promise<null>((resolve) => {
			setTimeout(() => {
				proc.kill()
				resolve(null)
			}, 5000)
		})

		// Race between process completion and timeout
		const result = await Promise.race([
			proc.exited.then(async (exitCode) => {
				if (exitCode === 0) {
					const output = await new Response(proc.stdout).text()
					const token = output.trim()
					return token || null
				}
				return null
			}),
			timeoutPromise,
		])

		if (result) {
			return result
		}
	} catch {
		// gh CLI not available or failed, fall through
	}

	// Try 3: No token available
	return null
}

/**
 * Build HTTP headers for GitHub raw content requests
 *
 * @param token - GitHub personal access token or null
 * @returns Headers object (empty if no token)
 *
 * @example
 * buildGitHubHeaders("ghp_xxxx") // { "Authorization": "token ghp_xxxx" }
 * buildGitHubHeaders(null) // {}
 */
export function buildGitHubHeaders(token: string | null): Record<string, string> {
	if (token) {
		return { Authorization: `token ${token}` }
	}
	return {}
}

/**
 * Resolve a GitHub URL to base URL, headers, and auth source
 *
 * Convenience function that combines URL parsing, auth resolution, and header building
 *
 * @param input - GitHub URL string
 * @returns Resolved registry with base URL, headers, and auth source
 * @throws {ValidationError} If URL format is invalid
 *
 * @example
 * await resolveGitHubRegistry("github:myorg/my-registry")
 * // {
 * //   baseUrl: "https://raw.githubusercontent.com/myorg/my-registry/main",
 * //   headers: { "Authorization": "token ghp_xxxx" },
 * //   source: "gh-cli"
 * // }
 */
export async function resolveGitHubRegistry(input: string): Promise<ResolvedGitHubRegistry> {
	const parsed = parseGitHubUrl(input)
	const baseUrl = resolveGitHubBaseUrl(parsed)
	const token = await resolveGitHubAuthToken()
	const headers = buildGitHubHeaders(token)

	let source: "gh-cli" | "env" | "none"
	if (token) {
		source = process.env.GITHUB_TOKEN ? "env" : "gh-cli"
	} else {
		source = "none"
	}

	return { baseUrl, headers, source }
}

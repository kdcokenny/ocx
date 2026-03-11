/**
 * Tests for GitHub URL parsing and auth token resolution
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import {
	buildGitHubHeaders,
	isGitHubUrl,
	parseGitHubUrl,
	resolveGitHubAuthToken,
	resolveGitHubBaseUrl,
	resolveGitHubRegistry,
	ValidationError,
} from "../src/registry/github"

describe("isGitHubUrl", () => {
	it("should return true for github: URLs", () => {
		expect(isGitHubUrl("github:owner/repo")).toBe(true)
		expect(isGitHubUrl("github:myorg/my-registry")).toBe(true)
		expect(isGitHubUrl("github:a/b@v1.0")).toBe(true)
		expect(isGitHubUrl("github:")).toBe(true)
	})

	it("should return false for non-github URLs", () => {
		expect(isGitHubUrl("https://example.com")).toBe(false)
		expect(isGitHubUrl("http://github.com")).toBe(false)
		expect(isGitHubUrl("git@github.com:owner/repo.git")).toBe(false)
		expect(isGitHubUrl("owner/repo")).toBe(false)
		expect(isGitHubUrl("")).toBe(false)
	})
})

describe("parseGitHubUrl", () => {
	describe("valid URLs", () => {
		it("should parse github:owner/repo with default ref", () => {
			const result = parseGitHubUrl("github:myorg/my-registry")
			expect(result).toEqual({
				owner: "myorg",
				repo: "my-registry",
				ref: "main",
			})
		})

		it("should parse github:owner/repo@ref", () => {
			const result = parseGitHubUrl("github:myorg/my-registry@v2.0")
			expect(result).toEqual({
				owner: "myorg",
				repo: "my-registry",
				ref: "v2.0",
			})
		})

		it("should parse with branch ref", () => {
			const result = parseGitHubUrl("github:owner/repo@develop")
			expect(result).toEqual({
				owner: "owner",
				repo: "repo",
				ref: "develop",
			})
		})

		it("should parse with commit SHA ref", () => {
			const result = parseGitHubUrl("github:owner/repo@abc123def456")
			expect(result).toEqual({
				owner: "owner",
				repo: "repo",
				ref: "abc123def456",
			})
		})

		it("should parse with tag ref", () => {
			const result = parseGitHubUrl("github:owner/repo@v1.2.3")
			expect(result).toEqual({
				owner: "owner",
				repo: "repo",
				ref: "v1.2.3",
			})
		})

		it("should handle refs with slashes", () => {
			const result = parseGitHubUrl("github:owner/repo@feature/branch-name")
			expect(result).toEqual({
				owner: "owner",
				repo: "repo",
				ref: "feature/branch-name",
			})
		})

		it("should handle refs with special chars", () => {
			const result = parseGitHubUrl("github:owner/repo@release-1.0_beta")
			expect(result).toEqual({
				owner: "owner",
				repo: "repo",
				ref: "release-1.0_beta",
			})
		})
	})

	describe("invalid URLs", () => {
		it("should throw for missing github: prefix", () => {
			expect(() => parseGitHubUrl("owner/repo")).toThrow(ValidationError)
			expect(() => parseGitHubUrl("owner/repo")).toThrow('must start with "github:"')
		})

		it("should throw for bare owner without repo", () => {
			expect(() => parseGitHubUrl("github:myorg")).toThrow(ValidationError)
			expect(() => parseGitHubUrl("github:myorg")).toThrow('must be "github:owner/repo[@ref]"')
		})

		it("should throw for subdirectory paths", () => {
			expect(() => parseGitHubUrl("github:owner/repo/subdir")).toThrow(ValidationError)
			expect(() => parseGitHubUrl("github:owner/repo/subdir")).toThrow(
				"subdirectory paths not supported",
			)
		})

		it("should throw for multiple subdirectories", () => {
			expect(() => parseGitHubUrl("github:owner/repo/sub1/sub2")).toThrow(ValidationError)
			expect(() => parseGitHubUrl("github:owner/repo/sub1/sub2")).toThrow(
				"subdirectory paths not supported",
			)
		})

		it("should throw for empty owner", () => {
			expect(() => parseGitHubUrl("github:/repo")).toThrow(ValidationError)
			expect(() => parseGitHubUrl("github:/repo")).toThrow("owner and repo cannot be empty")
		})

		it("should throw for empty repo", () => {
			expect(() => parseGitHubUrl("github:owner/")).toThrow(ValidationError)
			expect(() => parseGitHubUrl("github:owner/")).toThrow("owner and repo cannot be empty")
		})

		it("should throw for empty ref", () => {
			expect(() => parseGitHubUrl("github:owner/repo@")).toThrow(ValidationError)
			expect(() => parseGitHubUrl("github:owner/repo@")).toThrow("ref cannot be empty")
		})

		it("should throw for just github:", () => {
			expect(() => parseGitHubUrl("github:")).toThrow(ValidationError)
		})

		it("should throw for github:@ref", () => {
			expect(() => parseGitHubUrl("github:@ref")).toThrow(ValidationError)
		})
	})
})

describe("resolveGitHubBaseUrl", () => {
	it("should build raw.githubusercontent.com URL", () => {
		const parsed = { owner: "myorg", repo: "my-registry", ref: "main" }
		const result = resolveGitHubBaseUrl(parsed)
		expect(result).toBe("https://raw.githubusercontent.com/myorg/my-registry/main")
	})

	it("should handle different refs", () => {
		expect(resolveGitHubBaseUrl({ owner: "o", repo: "r", ref: "v1.0" })).toBe(
			"https://raw.githubusercontent.com/o/r/v1.0",
		)
		expect(resolveGitHubBaseUrl({ owner: "o", repo: "r", ref: "develop" })).toBe(
			"https://raw.githubusercontent.com/o/r/develop",
		)
	})

	it("should handle refs with slashes", () => {
		const parsed = { owner: "o", repo: "r", ref: "feature/branch" }
		const result = resolveGitHubBaseUrl(parsed)
		expect(result).toBe("https://raw.githubusercontent.com/o/r/feature/branch")
	})
})

describe("resolveGitHubAuthToken", () => {
	let originalEnv: string | undefined

	beforeEach(() => {
		originalEnv = process.env.GITHUB_TOKEN
		delete process.env.GITHUB_TOKEN
	})

	afterEach(() => {
		if (originalEnv !== undefined) {
			process.env.GITHUB_TOKEN = originalEnv
		} else {
			delete process.env.GITHUB_TOKEN
		}
	})

	it("should return token from GITHUB_TOKEN env var", async () => {
		process.env.GITHUB_TOKEN = "ghp_test_token_from_env"
		const token = await resolveGitHubAuthToken()
		expect(token).toBe("ghp_test_token_from_env")
	})

	it("should return null when no token available", async () => {
		delete process.env.GITHUB_TOKEN
		const spawnMock = spyOn(Bun, "spawn").mockReturnValue({
			exited: Promise.resolve(1),
			stdout: null,
			stderr: null,
			kill: () => {},
		} as any)

		const token = await resolveGitHubAuthToken()
		expect(token).toBeNull()

		spawnMock.mockRestore()
	})

	it("should return null on gh CLI timeout", async () => {
		delete process.env.GITHUB_TOKEN

		const spawnMock = spyOn(Bun, "spawn").mockReturnValue({
			exited: new Promise(() => {}),
			stdout: null,
			stderr: null,
			kill: mock(() => {}),
		} as any)

		const token = await resolveGitHubAuthToken()
		expect(token).toBeNull()

		spawnMock.mockRestore()
	}, 10000)

	it("should prefer GITHUB_TOKEN over gh CLI", async () => {
		process.env.GITHUB_TOKEN = "ghp_env_token"

		const spawnMock = spyOn(Bun, "spawn").mockReturnValue({
			exited: Promise.resolve(0),
			stdout: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("ghp_cli_token\n"))
					controller.close()
				},
			}),
			stderr: null,
			kill: () => {},
		} as any)

		const token = await resolveGitHubAuthToken()
		expect(token).toBe("ghp_env_token")

		spawnMock.mockRestore()
	})

	it("should handle gh CLI returning empty output", async () => {
		delete process.env.GITHUB_TOKEN

		const spawnMock = spyOn(Bun, "spawn").mockReturnValue({
			exited: Promise.resolve(0),
			stdout: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("   \n"))
					controller.close()
				},
			}),
			stderr: null,
			kill: () => {},
		} as any)

		const token = await resolveGitHubAuthToken()
		expect(token).toBeNull()

		spawnMock.mockRestore()
	})

	it("should handle gh CLI not installed", async () => {
		delete process.env.GITHUB_TOKEN

		const spawnMock = spyOn(Bun, "spawn").mockImplementation(() => {
			throw new Error("spawn ENOENT")
		})

		const token = await resolveGitHubAuthToken()
		expect(token).toBeNull()

		spawnMock.mockRestore()
	})

	it("should trim whitespace from token", async () => {
		process.env.GITHUB_TOKEN = "  ghp_token_with_spaces  "
		const token = await resolveGitHubAuthToken()
		expect(token).toBe("  ghp_token_with_spaces  ")
	})
})

describe("buildGitHubHeaders", () => {
	it("should build Authorization header with token prefix", () => {
		const headers = buildGitHubHeaders("ghp_mytoken123")
		expect(headers).toEqual({
			Authorization: "token ghp_mytoken123",
		})
	})

	it("should return empty object for null token", () => {
		const headers = buildGitHubHeaders(null)
		expect(headers).toEqual({})
	})

	it("should use token prefix not Bearer", () => {
		const headers = buildGitHubHeaders("ghp_test")
		expect(headers.Authorization).toBe("token ghp_test")
		expect(headers.Authorization).not.toContain("Bearer")
	})

	it("should handle various token formats", () => {
		expect(buildGitHubHeaders("ghp_xxxxxxxxxxxx").Authorization).toBe("token ghp_xxxxxxxxxxxx")
		expect(buildGitHubHeaders("gho_xxxxxxxxxxxx").Authorization).toBe("token gho_xxxxxxxxxxxx")
		expect(buildGitHubHeaders("github_pat_xxxxx").Authorization).toBe("token github_pat_xxxxx")
	})
})

describe("resolveGitHubRegistry", () => {
	let originalEnv: string | undefined

	beforeEach(() => {
		originalEnv = process.env.GITHUB_TOKEN
		delete process.env.GITHUB_TOKEN
	})

	afterEach(() => {
		if (originalEnv !== undefined) {
			process.env.GITHUB_TOKEN = originalEnv
		} else {
			delete process.env.GITHUB_TOKEN
		}
	})

	it("should resolve registry with env token", async () => {
		process.env.GITHUB_TOKEN = "ghp_test_token"

		const result = await resolveGitHubRegistry("github:myorg/my-registry")

		expect(result.baseUrl).toBe("https://raw.githubusercontent.com/myorg/my-registry/main")
		expect(result.headers).toEqual({ Authorization: "token ghp_test_token" })
		expect(result.source).toBe("env")
	})

	it("should resolve registry without token", async () => {
		delete process.env.GITHUB_TOKEN

		const spawnMock = spyOn(Bun, "spawn").mockReturnValue({
			exited: Promise.resolve(1),
			stdout: null,
			stderr: null,
			kill: () => {},
		} as any)

		const result = await resolveGitHubRegistry("github:owner/repo")

		expect(result.baseUrl).toBe("https://raw.githubusercontent.com/owner/repo/main")
		expect(result.headers).toEqual({})
		expect(result.source).toBe("none")

		spawnMock.mockRestore()
	})

	it("should resolve registry with custom ref", async () => {
		delete process.env.GITHUB_TOKEN

		const spawnMock = spyOn(Bun, "spawn").mockReturnValue({
			exited: Promise.resolve(1),
			stdout: null,
			stderr: null,
			kill: () => {},
		} as any)

		const result = await resolveGitHubRegistry("github:owner/repo@v2.0")

		expect(result.baseUrl).toBe("https://raw.githubusercontent.com/owner/repo/v2.0")
		expect(result.headers).toEqual({})
		expect(result.source).toBe("none")

		spawnMock.mockRestore()
	})

	it("should throw for invalid URL", async () => {
		await expect(resolveGitHubRegistry("github:invalid")).rejects.toThrow(ValidationError)
		await expect(resolveGitHubRegistry("https://example.com")).rejects.toThrow(ValidationError)
	})

	it("should combine all components correctly", async () => {
		process.env.GITHUB_TOKEN = "ghp_combined_test"

		const result = await resolveGitHubRegistry("github:test-org/test-repo@develop")

		expect(result.baseUrl).toBe("https://raw.githubusercontent.com/test-org/test-repo/develop")
		expect(result.headers).toEqual({ Authorization: "token ghp_combined_test" })
		expect(result.source).toBe("env")
	})
})

describe("token secrecy", () => {
	it("should never include token in error messages", () => {
		process.env.GITHUB_TOKEN = "ghp_super_secret_token_12345"

		try {
			parseGitHubUrl("github:invalid")
		} catch (error) {
			expect((error as Error).message).not.toContain("ghp_super_secret_token")
			expect((error as Error).message).not.toContain("12345")
		}

		delete process.env.GITHUB_TOKEN
	})

	it("should not expose token in ValidationError", () => {
		const sensitiveInput = "github:owner/repo@ghp_token_in_url"

		try {
			parseGitHubUrl(sensitiveInput)
		} catch (error) {
			expect((error as Error).message).toContain("github:owner/repo@ghp_token_in_url")
		}
	})
})

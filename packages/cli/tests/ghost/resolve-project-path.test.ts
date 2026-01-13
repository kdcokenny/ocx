/**
 * Tests for resolveProjectPath()
 *
 * Tests the project path resolution logic for `ocx ghost opencode`.
 * Covers parsing logic, path detection, real fs integration, and Windows path handling.
 */

import { describe, expect, it } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { type FsOperations, resolveProjectPath } from "../../src/commands/ghost/opencode.js"
import { NotFoundError, ValidationError } from "../../src/utils/errors.js"

// =============================================================================
// HELPERS
// =============================================================================

async function withTempDir<T>(name: string, fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = path.join(import.meta.dir, "fixtures", `tmp-${name}-${Date.now()}`)
	await mkdir(dir, { recursive: true })
	try {
		return await fn(dir)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

// =============================================================================
// 3.1 UNIT TESTS FOR PARSING LOGIC (no fs access)
// =============================================================================

describe("resolveProjectPath - parsing logic", () => {
	const cwd = "/home/user/projects"

	// Mock fs that always says "path exists and is a directory"
	const mockFsExists: FsOperations = {
		existsSync: () => true,
		statSync: () => ({ isDirectory: () => true }),
	}

	// Mock fs that always says "path does not exist"
	const mockFsNotExists: FsOperations = {
		existsSync: () => false,
		statSync: () => {
			throw new Error("stat called on non-existent path")
		},
	}

	describe("no arguments", () => {
		it("returns cwd when args is empty array", () => {
			const result = resolveProjectPath([], cwd, mockFsNotExists)

			expect(result.projectDir).toBe(cwd)
			expect(result.remainingArgs).toEqual([])
			expect(result.explicitPath).toBeNull()
		})
	})

	describe("flags only (no path)", () => {
		it("returns cwd with args when first arg is a flag", () => {
			const result = resolveProjectPath(["--debug"], cwd, mockFsNotExists)

			expect(result.projectDir).toBe(cwd)
			expect(result.remainingArgs).toEqual(["--debug"])
			expect(result.explicitPath).toBeNull()
		})

		it("returns cwd with all flags when multiple flags passed", () => {
			const result = resolveProjectPath(["--debug", "--verbose", "-q"], cwd, mockFsNotExists)

			expect(result.projectDir).toBe(cwd)
			expect(result.remainingArgs).toEqual(["--debug", "--verbose", "-q"])
			expect(result.explicitPath).toBeNull()
		})
	})

	describe("POSIX -- sentinel", () => {
		it("returns cwd when -- has no following path", () => {
			const result = resolveProjectPath(["--"], cwd, mockFsNotExists)

			expect(result.projectDir).toBe(cwd)
			expect(result.remainingArgs).toEqual([])
			expect(result.explicitPath).toBeNull()
		})

		it("parses path after -- sentinel", () => {
			const result = resolveProjectPath(["--", "/projects/foo"], cwd, mockFsExists)

			expect(result.projectDir).toBe("/projects/foo")
			expect(result.remainingArgs).toEqual([])
			expect(result.explicitPath).toBe("/projects/foo")
		})

		it("parses path and remaining flags after -- sentinel", () => {
			const result = resolveProjectPath(["--", "/projects/foo", "--help", "-v"], cwd, mockFsExists)

			expect(result.projectDir).toBe("/projects/foo")
			expect(result.remainingArgs).toEqual(["--help", "-v"])
			expect(result.explicitPath).toBe("/projects/foo")
		})

		it("resolves relative path after -- sentinel", () => {
			const result = resolveProjectPath(["--", "./myproject"], cwd, mockFsExists)

			expect(result.projectDir).toBe(path.resolve(cwd, "./myproject"))
			expect(result.explicitPath).toBe("./myproject")
		})
	})

	describe("path as first argument", () => {
		it("uses first arg as path when it exists as directory", () => {
			const result = resolveProjectPath(["/projects/foo", "--help"], cwd, mockFsExists)

			expect(result.projectDir).toBe("/projects/foo")
			expect(result.remainingArgs).toEqual(["--help"])
			expect(result.explicitPath).toBe("/projects/foo")
		})

		it("treats first arg as passthrough when path does not exist", () => {
			const result = resolveProjectPath(["nonexistent", "--help"], cwd, mockFsNotExists)

			expect(result.projectDir).toBe(cwd)
			expect(result.remainingArgs).toEqual(["nonexistent", "--help"])
			expect(result.explicitPath).toBeNull()
		})

		it("treats first arg as passthrough when path exists but is a file", () => {
			const mockFsIsFile: FsOperations = {
				existsSync: () => true,
				statSync: () => ({ isDirectory: () => false }),
			}

			const result = resolveProjectPath(["somefile.txt", "--help"], cwd, mockFsIsFile)

			expect(result.projectDir).toBe(cwd)
			expect(result.remainingArgs).toEqual(["somefile.txt", "--help"])
			expect(result.explicitPath).toBeNull()
		})
	})
})

// =============================================================================
// 3.2 UNIT TESTS FOR PATH DETECTION (uses isAbsolutePath)
// =============================================================================

describe("resolveProjectPath - path detection", () => {
	const cwd = "/home/user"

	// Mock fs that always says "path exists and is a directory"
	const mockFsExists: FsOperations = {
		existsSync: () => true,
		statSync: () => ({ isDirectory: () => true }),
	}

	describe("Unix paths", () => {
		it("detects Unix absolute path", () => {
			const result = resolveProjectPath(["/projects/myapp"], cwd, mockFsExists)

			expect(result.projectDir).toBe("/projects/myapp")
			expect(result.explicitPath).toBe("/projects/myapp")
		})

		it("resolves relative path against cwd", () => {
			const result = resolveProjectPath(["./subdir"], cwd, mockFsExists)

			expect(result.projectDir).toBe(path.resolve(cwd, "./subdir"))
			expect(result.explicitPath).toBe("./subdir")
		})

		it("resolves parent path against cwd", () => {
			const result = resolveProjectPath(["../sibling"], cwd, mockFsExists)

			expect(result.projectDir).toBe(path.resolve(cwd, "../sibling"))
			expect(result.explicitPath).toBe("../sibling")
		})
	})

	describe("Windows paths", () => {
		it("detects Windows drive letter path (backslash)", () => {
			const windowsPath = String.raw`C:\Users\project`
			const result = resolveProjectPath(["--", windowsPath], cwd, mockFsExists)

			// After -- sentinel, first arg is treated as path
			// isAbsolutePath should detect it as absolute via win32
			expect(result.projectDir).toBe(windowsPath)
			expect(result.explicitPath).toBe(windowsPath)
		})

		it("detects Windows drive letter path (forward slash)", () => {
			const result = resolveProjectPath(["--", "C:/Users/project"], cwd, mockFsExists)

			expect(result.projectDir).toBe("C:/Users/project")
			expect(result.explicitPath).toBe("C:/Users/project")
		})

		it("detects Windows UNC path", () => {
			const uncPath = String.raw`\\server\share\project`
			const result = resolveProjectPath(["--", uncPath], cwd, mockFsExists)

			expect(result.projectDir).toBe(uncPath)
			expect(result.explicitPath).toBe(uncPath)
		})
	})
})

// =============================================================================
// 3.3 INTEGRATION TESTS WITH REAL FS (temp directories)
// =============================================================================

describe("resolveProjectPath - real fs integration", () => {
	it("resolves existing directory", async () => {
		await withTempDir("resolve-existing", async (tempDir) => {
			const result = resolveProjectPath([tempDir], "/fallback" /* uses real fs */)

			expect(result.projectDir).toBe(tempDir)
			expect(result.explicitPath).toBe(tempDir)
			expect(result.remainingArgs).toEqual([])
		})
	})

	it("throws NotFoundError for non-existent path after -- sentinel", async () => {
		// Use a cross-platform path that definitely doesn't exist
		const nonExistentPath = path.join(tmpdir(), `ocx-nonexistent-${Date.now()}-${Math.random()}`)

		expect(() => {
			resolveProjectPath(["--", nonExistentPath], "/fallback")
		}).toThrow(NotFoundError)

		try {
			resolveProjectPath(["--", nonExistentPath], "/fallback")
		} catch (error) {
			expect(error).toBeInstanceOf(NotFoundError)
			expect((error as NotFoundError).message).toContain("does not exist")
		}
	})

	it("throws ValidationError for file path after -- sentinel", async () => {
		await withTempDir("resolve-file", async (tempDir) => {
			const filePath = path.join(tempDir, "somefile.txt")
			await Bun.write(filePath, "content")

			expect(() => {
				resolveProjectPath(["--", filePath], "/fallback")
			}).toThrow(ValidationError)

			try {
				resolveProjectPath(["--", filePath], "/fallback")
			} catch (error) {
				expect(error).toBeInstanceOf(ValidationError)
				expect((error as ValidationError).message).toContain("not a directory")
			}
		})
	})

	it("resolves relative path against cwd", async () => {
		await withTempDir("resolve-relative", async (tempDir) => {
			// Create a subdirectory
			const subdir = path.join(tempDir, "myproject")
			await mkdir(subdir, { recursive: true })

			// Use tempDir as cwd and resolve relative path
			const result = resolveProjectPath(["myproject"], tempDir)

			expect(result.projectDir).toBe(subdir)
			expect(result.explicitPath).toBe("myproject")
		})
	})

	it("returns cwd when first arg is not a valid directory", async () => {
		await withTempDir("resolve-fallback", async (tempDir) => {
			// First arg doesn't exist, should fall back to cwd
			const result = resolveProjectPath(["nonexistent", "--flag"], tempDir)

			expect(result.projectDir).toBe(tempDir)
			expect(result.remainingArgs).toEqual(["nonexistent", "--flag"])
			expect(result.explicitPath).toBeNull()
		})
	})
})

// =============================================================================
// 3.4 WINDOWS PATH TESTS (mocked fs via dependency injection)
// =============================================================================

describe("resolveProjectPath - Windows paths (mocked fs)", () => {
	const mockFs: FsOperations = {
		existsSync: () => true,
		statSync: () => ({ isDirectory: () => true }),
	}

	const cwd = String.raw`C:\Users\developer`

	it("handles Windows absolute path with backslash via -- sentinel", () => {
		const windowsPath = String.raw`D:\Projects\myapp`
		const result = resolveProjectPath(["--", windowsPath], cwd, mockFs)

		expect(result.projectDir).toBe(windowsPath)
		expect(result.explicitPath).toBe(windowsPath)
		expect(result.remainingArgs).toEqual([])
	})

	it("handles Windows path with forward slash via -- sentinel", () => {
		const windowsPath = "D:/Projects/myapp"
		const result = resolveProjectPath(["--", windowsPath], cwd, mockFs)

		expect(result.projectDir).toBe(windowsPath)
		expect(result.explicitPath).toBe(windowsPath)
	})

	it("handles Windows UNC path via -- sentinel", () => {
		const uncPath = String.raw`\\fileserver\shared\project`
		const result = resolveProjectPath(["--", uncPath], cwd, mockFs)

		expect(result.projectDir).toBe(uncPath)
		expect(result.explicitPath).toBe(uncPath)
	})

	it("handles Windows path with remaining args", () => {
		const windowsPath = String.raw`E:\Code\project`
		const result = resolveProjectPath(["--", windowsPath, "--debug", "--port", "3000"], cwd, mockFs)

		expect(result.projectDir).toBe(windowsPath)
		expect(result.remainingArgs).toEqual(["--debug", "--port", "3000"])
		expect(result.explicitPath).toBe(windowsPath)
	})

	it("detects lowercase Windows drive letter", () => {
		const windowsPath = "c:/users/project"
		const result = resolveProjectPath(["--", windowsPath], cwd, mockFs)

		expect(result.projectDir).toBe(windowsPath)
		expect(result.explicitPath).toBe(windowsPath)
	})
})

// =============================================================================
// EDGE CASES
// =============================================================================

describe("resolveProjectPath - edge cases", () => {
	const mockFs: FsOperations = {
		existsSync: () => true,
		statSync: () => ({ isDirectory: () => true }),
	}

	it("handles empty string in args array", () => {
		// Empty string is not a valid path, should fall through to passthrough
		const mockFsNotExists: FsOperations = {
			existsSync: () => false,
			statSync: () => {
				throw new Error("not found")
			},
		}

		const result = resolveProjectPath([""], "/cwd", mockFsNotExists)

		expect(result.projectDir).toBe("/cwd")
		expect(result.remainingArgs).toEqual([""])
	})

	it("handles path with spaces", () => {
		const pathWithSpaces = "/home/user/my project"
		const result = resolveProjectPath(["--", pathWithSpaces], "/cwd", mockFs)

		expect(result.projectDir).toBe(pathWithSpaces)
		expect(result.explicitPath).toBe(pathWithSpaces)
	})

	it("handles multiple -- in args (only first is sentinel)", () => {
		const result = resolveProjectPath(["--", "/project", "--", "extra"], "/cwd", mockFs)

		expect(result.projectDir).toBe("/project")
		// Everything after the path is remaining args, including another --
		expect(result.remainingArgs).toEqual(["--", "extra"])
	})

	it("returns immutable result object", () => {
		const result = resolveProjectPath([], "/cwd", mockFs)

		// TypeScript readonly should prevent mutation, but verify structure
		expect(Object.isFrozen(result)).toBe(false) // Plain object, not frozen
		expect(result.projectDir).toBe("/cwd")
		expect(result.remainingArgs).toEqual([])
		expect(result.explicitPath).toBeNull()
	})
})

/**
 * Pattern Filter Utilities
 *
 * Filters excluded paths based on include/exclude glob patterns
 * for ghost mode symlink farm customization.
 */

import path from "node:path"
import { Glob } from "bun"

/**
 * Discriminated union for path disposition.
 * Determines how a path should be handled based on include/exclude patterns.
 */
export type PathDisposition =
	| { type: "excluded" }
	| { type: "included" }
	| { type: "partial"; patterns: string[] }

/**
 * Check if a path matches any of the pre-compiled glob patterns.
 *
 * @param filePath - The path to test (relative to git root)
 * @param globs - Array of pre-compiled Glob objects
 * @returns true if path matches any pattern
 */
function matchesAnyGlob(filePath: string, globs: Glob[]): boolean {
	return globs.some((g) => g.match(filePath))
}

/**
 * Filter excluded paths based on include/exclude glob patterns.
 *
 * Mental model (TypeScript-style, no double negatives):
 * 1. Start with all excluded paths
 * 2. Include patterns specify which to bring back (remove from exclusions)
 * 3. Exclude patterns filter out exceptions from include results
 *
 * NOTE: This function recompiles globs on each call. For repeated filtering
 * of many paths, prefer `createPathMatcher()` which pre-compiles patterns once.
 * This function is preserved for backward compatibility with existing callers.
 *
 * @param excludedPaths - Set of paths currently excluded from symlink farm
 * @param includePatterns - Globs for files to include (remove from exclusions)
 * @param excludePatterns - Globs for exceptions (keep in exclusions)
 * @returns New Set with filtered exclusions
 *
 * @example
 * ```ts
 * const excluded = new Set(["AGENTS.md", ".opencode/skills/foo.md", ".opencode/config.json"])
 *
 * // Include all .md files, but exclude AGENTS.md specifically
 * filterExcludedPaths(excluded, ["**\/*.md"], ["AGENTS.md"])
 * // Returns: Set(["AGENTS.md", ".opencode/config.json"])
 * // (foo.md was included, but AGENTS.md stayed excluded)
 * ```
 */
export function filterExcludedPaths(
	excludedPaths: Set<string>,
	includePatterns?: string[],
	excludePatterns?: string[],
): Set<string> {
	// Law 1: Guard clause - no patterns means no filtering
	if (!includePatterns || includePatterns.length === 0) {
		return new Set(excludedPaths)
	}

	// Pre-compile globs once (patterns are validated at schema boundary)
	const includeGlobs = includePatterns.map((p) => new Glob(p))
	const excludeGlobs = excludePatterns?.map((p) => new Glob(p)) ?? []

	const filteredExclusions = new Set<string>()

	// Law 3: Pure function - iterate and build new Set
	for (const path of excludedPaths) {
		const matchesInclude = matchesAnyGlob(path, includeGlobs)
		const matchesExclude = matchesAnyGlob(path, excludeGlobs)

		// Include pattern matched AND not excepted → remove from exclusions (include it)
		// Otherwise → keep in exclusions
		if (matchesInclude && !matchesExclude) {
			// This path is being included, don't add to exclusions
			continue
		}

		filteredExclusions.add(path)
	}

	return filteredExclusions
}

/**
 * Normalize a path for pattern matching.
 * - Strips project root to get relative path
 * - Converts to POSIX separators (forward slashes)
 * - Removes leading ./
 *
 * @param absolutePath - The absolute path to normalize
 * @param projectRoot - The project root directory
 * @returns Normalized relative path for pattern matching
 *
 * @example
 * ```ts
 * normalizeForMatching("/home/user/project/.opencode/config.json", "/home/user/project")
 * // Returns: ".opencode/config.json"
 *
 * normalizeForMatching("/home/user/project/src/index.ts", "/home/user/project")
 * // Returns: "src/index.ts"
 * ```
 */
export function normalizeForMatching(absolutePath: string, projectRoot: string): string {
	// Law 2: Parse at boundary - convert to relative POSIX path immediately
	const relativePath = path.relative(projectRoot, absolutePath)

	// Convert Windows separators to POSIX and strip leading ./
	return relativePath.split(path.sep).join("/").replace(/^\.\//, "")
}

/**
 * Determine how to handle a path based on include/exclude patterns.
 * Follows Vite/Rollup algorithm: exclude first → include second → fallback.
 *
 * Algorithm:
 * 1. If ANY exclude pattern matches → return "excluded"
 * 2. If ANY include pattern matches → return "included"
 * 3. If patterns target inside this dir → return "partial" with those patterns
 * 4. If include patterns exist but none matched → return "excluded"
 * 5. If NO include patterns → return "included" (include all by default)
 *
 * @param relativePath - The relative path to check (POSIX format)
 * @param includePatterns - Patterns for files to include
 * @param excludePatterns - Patterns for files to exclude (takes precedence)
 * @returns PathDisposition indicating how to handle this path
 *
 * @example
 * ```ts
 * // File explicitly excluded
 * getPathDisposition("AGENTS.md", ["**\/*.md"], ["AGENTS.md"])
 * // Returns: { type: "excluded" }
 *
 * // File explicitly included
 * getPathDisposition(".opencode/skills/foo.md", ["**\/*.md"], [])
 * // Returns: { type: "included" }
 *
 * // Directory needs partial expansion
 * getPathDisposition(".opencode", [".opencode/skills/**"], [])
 * // Returns: { type: "partial", patterns: [".opencode/skills/**"] }
 *
 * // No patterns = include all
 * getPathDisposition("src/index.ts", [], [])
 * // Returns: { type: "included" }
 * ```
 */
export function getPathDisposition(
	relativePath: string,
	includePatterns: string[],
	excludePatterns: string[],
): PathDisposition {
	// Pre-compile globs once
	const excludeGlobs = excludePatterns.map((p) => new Glob(p))
	const includeGlobs = includePatterns.map((p) => new Glob(p))

	// Step 1: Exclude takes precedence
	if (matchesAnyGlob(relativePath, excludeGlobs)) {
		return { type: "excluded" }
	}

	// Step 2: Direct include match
	if (matchesAnyGlob(relativePath, includeGlobs)) {
		return { type: "included" }
	}

	// Step 3: Check if patterns target inside this directory (for partial expansion)
	// This applies when the path is a directory that might contain matching files
	const patternsInsideDir = includePatterns.filter((pattern) => {
		// Pattern starts with this path → targets inside
		if (pattern.startsWith(`${relativePath}/`)) return true
		// Pattern with ** could match inside
		if (pattern.startsWith("**/")) return true
		return false
	})

	if (patternsInsideDir.length > 0) {
		return { type: "partial", patterns: patternsInsideDir }
	}

	// Step 4: Include patterns exist but none matched → excluded
	if (includePatterns.length > 0) {
		return { type: "excluded" }
	}

	// Step 5: No include patterns → include everything by default
	return { type: "included" }
}

/**
 * Pre-compiled pattern matcher for efficient path filtering.
 * Compiles glob patterns once at construction, reuses for all matches.
 * Follows Vite/Rollup createFilter pattern.
 *
 * @example
 * ```ts
 * const matcher = createPathMatcher([".opencode/skills/**"], ["AGENTS.md"])
 *
 * // Reuse the same matcher for many paths (patterns compiled once)
 * matcher.getDisposition("AGENTS.md")         // { type: "excluded" }
 * matcher.getDisposition(".opencode/skills/foo.md")  // { type: "included" }
 * matcher.getDisposition(".opencode")         // { type: "partial", patterns: [...] }
 * ```
 */
export class PathMatcher {
	private readonly includeGlobs: { pattern: string; glob: Glob }[]
	private readonly excludeGlobs: { pattern: string; glob: Glob }[]
	private readonly includePatterns: string[]
	private readonly excludePatterns: string[]

	constructor(includePatterns: string[] = [], excludePatterns: string[] = []) {
		this.includePatterns = includePatterns
		this.excludePatterns = excludePatterns
		// Compile patterns ONCE at construction (Law 2: Parse at boundary)
		this.includeGlobs = includePatterns.map((p) => ({ pattern: p, glob: new Glob(p) }))
		this.excludeGlobs = excludePatterns.map((p) => ({ pattern: p, glob: new Glob(p) }))
	}

	/**
	 * Get disposition for a path using pre-compiled globs.
	 * Algorithm: exclude first → include second → check nested → fallback.
	 *
	 * @param relativePath - The relative path to check (POSIX format)
	 * @returns PathDisposition indicating how to handle this path
	 */
	getDisposition(relativePath: string): PathDisposition {
		const matchesExclude = this.excludeGlobs.some((g) => g.glob.match(relativePath))
		const matchesInclude = this.includeGlobs.some((g) => g.glob.match(relativePath))

		// Case 1: Both include AND exclude patterns exist
		// Include "re-adds from excluded set" - so include overrides exclude when both match
		if (this.includePatterns.length > 0 && this.excludePatterns.length > 0) {
			// Include pattern matches → include (overrides exclude per schema semantics)
			if (matchesInclude) {
				return { type: "included" }
			}

			// Excluded and not re-included → excluded
			if (matchesExclude) {
				return { type: "excluded" }
			}

			// Check if patterns target inside this directory
			const hasIncludesInside = this.includePatterns.some((pattern) => {
				if (pattern.startsWith(`${relativePath}/`)) return true
				if (pattern.startsWith("**/")) return true
				return false
			})

			const hasExcludesInside = this.excludePatterns.some((pattern) => {
				if (pattern.startsWith(`${relativePath}/`)) return true
				if (pattern.startsWith("**/")) return true
				return false
			})

			if (hasIncludesInside || hasExcludesInside) {
				return { type: "partial", patterns: this.includePatterns }
			}

			// Not matched by any pattern → include by default
			return { type: "included" }
		}

		// Case 2: Only include patterns exist (whitelist mode)
		// Only included paths are visible
		if (this.includePatterns.length > 0) {
			// Matches include → included
			if (matchesInclude) {
				return { type: "included" }
			}

			// Check if include patterns target inside this directory
			const hasIncludesInside = this.includePatterns.some((pattern) => {
				if (pattern.startsWith(`${relativePath}/`)) return true
				if (pattern.startsWith("**/")) return true
				return false
			})

			if (hasIncludesInside) {
				return { type: "partial", patterns: this.includePatterns }
			}

			// Not matched → excluded (whitelist mode)
			return { type: "excluded" }
		}

		// Case 3: Only exclude patterns exist (default ghost mode)
		// Include everything except excluded paths
		if (matchesExclude) {
			return { type: "excluded" }
		}

		// Check if exclude patterns target inside this directory
		const hasExcludesInside = this.excludePatterns.some((pattern) => {
			if (pattern.startsWith(`${relativePath}/`)) return true
			if (pattern.startsWith("**/")) return true
			return false
		})

		if (hasExcludesInside) {
			return { type: "partial", patterns: [] }
		}

		// Not excluded → include
		return { type: "included" }
	}

	/**
	 * Check if any include pattern targets inside a directory.
	 * Uses string prefix matching (no glob needed).
	 *
	 * @param dirPath - Directory path to check
	 * @returns true if any include pattern starts with this directory
	 */
	targetsInside(dirPath: string): boolean {
		const normalizedDir = dirPath.endsWith("/") ? dirPath : `${dirPath}/`
		return this.includePatterns.some((p) => p.startsWith(normalizedDir))
	}

	/**
	 * Get include patterns that target inside a specific directory.
	 *
	 * @param dirPath - Directory path to check
	 * @returns Array of patterns that start with this directory path
	 */
	getInnerPatterns(dirPath: string): string[] {
		const normalizedDir = dirPath.endsWith("/") ? dirPath : `${dirPath}/`
		return this.includePatterns.filter((p) => p.startsWith(normalizedDir))
	}

	/**
	 * Check if this matcher has any include patterns configured.
	 */
	hasIncludePatterns(): boolean {
		return this.includePatterns.length > 0
	}
}

/**
 * Create a PathMatcher instance.
 * Factory function matching Vite's createFilter API style.
 *
 * @param includePatterns - Glob patterns for files to include
 * @param excludePatterns - Glob patterns for files to exclude (takes precedence)
 * @returns PathMatcher instance with pre-compiled globs
 *
 * @example
 * ```ts
 * const matcher = createPathMatcher([".opencode/**\/*.md"], ["AGENTS.md"])
 * ```
 */
export function createPathMatcher(
	includePatterns: string[] = [],
	excludePatterns: string[] = [],
): PathMatcher {
	return new PathMatcher(includePatterns, excludePatterns)
}

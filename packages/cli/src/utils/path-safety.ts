/**
 * Path Safety Utilities
 *
 * Two-layer protection against path traversal attacks:
 * 1. Schema validation at parse boundary (rejects malicious patterns)
 * 2. Runtime containment before file writes (verifies resolved paths)
 *
 * Following the 5 Laws:
 * - Parse at boundary: safeRelativePathSchema validates input structure
 * - Fail fast: assertPathInside throws immediately on escape attempts
 * - Intentional naming: isPathInside/assertPathInside are self-documenting
 */

import path from "node:path"
import { ValidationError } from "./errors"
import { isAbsolutePath } from "./path-helpers"

/**
 * Check if a resolved path is inside the allowed parent directory.
 * Handles symlinks by using path.resolve().
 *
 * Edge case: When childPath resolves to the same directory as parentPath
 * (e.g., childPath="" or childPath="."), we return true because installing
 * to the project root is explicitly within the project directory.
 *
 * @param childPath - The path to check
 * @param parentPath - The allowed parent directory
 * @returns true if childPath is inside or equal to parentPath
 */
export function isPathInside(childPath: string, parentPath: string): boolean {
	const resolvedChild = path.resolve(childPath)
	const resolvedParent = path.resolve(parentPath)

	// Edge case: same directory is considered "inside" (root-level installation)
	// This handles componentPath="" or "." which resolves to the same path
	if (resolvedChild === resolvedParent) {
		return true
	}

	// Get relative path from parent to child
	const relative = path.relative(resolvedParent, resolvedChild)

	// Path is inside if:
	// 1. relative is not empty (handled above for same-path case)
	// 2. relative doesn't start with '..' (not escaping)
	// 3. relative is not absolute (edge case on Windows)
	return !!relative && !relative.startsWith("..") && !isAbsolutePath(relative)
}

/**
 * Assert that a path is inside the allowed parent directory.
 * Throws ValidationError if path escapes.
 *
 * @param childPath - The path to check
 * @param parentPath - The allowed parent directory
 * @throws ValidationError if path is outside parent
 */
export function assertPathInside(childPath: string, parentPath: string): void {
	if (!isPathInside(childPath, parentPath)) {
		throw new ValidationError(`Path "${childPath}" is outside allowed directory "${parentPath}"`)
	}
}

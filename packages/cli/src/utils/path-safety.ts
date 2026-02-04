/**
 * Path Safety Utilities
 *
 * @deprecated This module is deprecated. Use path-security.ts instead.
 * These functions are kept as compatibility wrappers.
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
import { isPathSafe, PathValidationError, validatePath } from "./path-security"

/**
 * Check if a resolved path is inside the allowed parent directory.
 * Handles symlinks by using path.resolve().
 *
 * @deprecated Use validatePath from path-security.ts instead
 * @param childPath - The path to check
 * @param parentPath - The allowed parent directory
 * @returns true if childPath is inside or equal to parentPath
 */
export function isPathInside(childPath: string, parentPath: string): boolean {
	const resolvedChild = path.resolve(childPath)
	const resolvedParent = path.resolve(parentPath)
	let relative = path.relative(resolvedParent, resolvedChild)
	if (relative === "") relative = "."
	return isPathSafe(resolvedParent, relative)
}

/**
 * Assert that a path is inside the allowed parent directory.
 * Throws ValidationError if path escapes.
 *
 * @deprecated Use validatePath from path-security.ts instead
 * @param childPath - The path to check
 * @param parentPath - The allowed parent directory
 * @throws ValidationError if path is outside parent
 */
export function assertPathInside(childPath: string, parentPath: string): void {
	const resolvedChild = path.resolve(childPath)
	const resolvedParent = path.resolve(parentPath)
	let relative = path.relative(resolvedParent, resolvedChild)
	if (relative === "") relative = "."

	try {
		validatePath(resolvedParent, relative)
	} catch (error) {
		if (error instanceof PathValidationError) {
			throw new ValidationError(`Path "${childPath}" is unsafe: ${error.message}`)
		}
		throw error
	}
}

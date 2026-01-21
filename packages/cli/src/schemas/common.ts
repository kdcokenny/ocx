/**
 * Common Schemas
 *
 * Reusable Zod schemas for validation across the codebase.
 * Following Law 2: Parse at boundary - validate once, trust internally.
 */

import { z } from "zod"
import { isAbsolutePath } from "../utils/path-helpers"

/**
 * Schema for a safe relative path that cannot escape the project root.
 * Layer 1 of path traversal protection (schema validation at parse boundary).
 *
 * Rejects:
 * - Null bytes (security - prevents null byte injection attacks)
 * - Path traversal segments (..)
 * - Absolute paths (Unix and Windows, including UNC paths)
 */
export const safeRelativePathSchema = z
	.string()
	.refine((val) => !val.includes("\0"), "Path cannot contain null bytes")
	.refine((val) => !val.split(/[/\\]/).some((seg) => seg === ".."), "Path cannot contain '..'")
	.refine((val) => !isAbsolutePath(val), "Path must be relative, not absolute")

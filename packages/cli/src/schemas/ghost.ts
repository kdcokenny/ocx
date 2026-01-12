/**
 * Ghost Mode Config Schema
 *
 * Schema for ghost.jsonc - the global OCX configuration file
 * stored at ~/.config/ocx/ghost.jsonc (XDG-compliant).
 *
 * Ghost mode allows OCX to work without project-local config files
 * by storing registries globally.
 */

import { Glob } from "bun"
import { z } from "zod"
import { safeRelativePathSchema } from "./common.js"
import { registryConfigSchema } from "./config.js"

// =============================================================================
// GLOB PATTERN SCHEMA
// =============================================================================

/**
 * Valid glob pattern - validated at parse boundary (Law 2).
 * Uses Bun's Glob constructor as the authoritative parser.
 */
const globPatternSchema = z
	.string()
	.min(1, "Pattern cannot be empty")
	.refine((val) => !val.includes("\0"), "Pattern cannot contain null bytes")
	.refine((val) => val.trim() === val, "Pattern cannot have leading/trailing whitespace")
	.refine(
		(val) => {
			try {
				new Glob(val)
				return true
			} catch {
				return false
			}
		},
		(val) => ({ message: `Invalid glob pattern: "${val}"` }),
	)

// =============================================================================
// GHOST CONFIG SCHEMA (ghost.jsonc)
// =============================================================================

/**
 * Ghost mode configuration schema
 *
 * Contains OCX-specific settings (registries, componentPath).
 * OpenCode configuration is stored separately in opencode.jsonc.
 */
export const ghostConfigSchema = z.object({
	/** Schema URL for IDE support */
	$schema: z.string().optional(),

	/**
	 * Configured registries for ghost mode
	 * Same format as ocx.jsonc registries
	 */
	registries: z.record(registryConfigSchema).default({}),

	/**
	 * Optional default component path for installations
	 * If not set, uses the standard .opencode directory
	 * Uses safeRelativePathSchema to prevent path traversal attacks
	 */
	componentPath: safeRelativePathSchema.optional(),

	/**
	 * Glob patterns to exclude from the symlink farm.
	 *
	 * **Semantics (TypeScript-style):**
	 * 1. `exclude` is applied first — matching files are hidden
	 * 2. `include` re-adds files from the excluded set (for power users)
	 *
	 * Default excludes all OpenCode project files so ghost mode provides
	 * a clean slate. Override to keep specific files visible.
	 */
	exclude: z
		.array(globPatternSchema)
		.default([
			// Rule files - recursive (can exist at any depth)
			"**/AGENTS.md",
			"**/CLAUDE.md",
			"**/CONTEXT.md",
			// Config - root only (one per project)
			".opencode",
			"opencode.jsonc",
			"opencode.json",
		])
		.describe("Glob patterns to exclude from the symlink farm"),

	/**
	 * Glob patterns to re-include from the excluded set.
	 *
	 * Use this to selectively restore files that were excluded.
	 * Only matches files that were first matched by `exclude`.
	 *
	 * Example: ["AGENTS.md"] keeps root AGENTS.md visible while
	 * still hiding nested ones matched by the recursive pattern.
	 */
	include: z
		.array(globPatternSchema)
		.default([])
		.describe("Glob patterns to re-include from excluded set (for power users)"),

	/**
	 * Whether to set terminal/tmux window name when launching OpenCode.
	 * Set to false to preserve your existing terminal title.
	 */
	renameWindow: z
		.boolean()
		.default(true)
		.describe("Set terminal/tmux window name when launching OpenCode"),

	/**
	 * Maximum number of files to process when creating the symlink farm.
	 * Acts as a safety check against accidentally running in massive directories.
	 * Set to 0 to disable the limit entirely.
	 */
	maxFiles: z
		.number()
		.int()
		.min(0, "maxFiles must be non-negative")
		.default(10000)
		.describe("Maximum files to process (0 = unlimited)"),
})

export type GhostConfig = z.infer<typeof ghostConfigSchema>

/**
 * OCX Profile Config Schema
 *
 * V2: Schema for ocx.jsonc (within profiles) - the OCX configuration file
 * stored at ~/.config/opencode/profiles/<name>/ocx.jsonc (XDG-compliant).
 *
 * Profiles layer with local configs of the same name.
 * Visibility is controlled by include/exclude patterns (no isolation flag).
 */

import { Glob } from "bun"
import type { infer as ZodInfer } from "zod"
import { array, boolean, object, record, string } from "zod"
import { safeRelativePathSchema } from "./common"
import { registryConfigSchema } from "./config"

/**
 * Validates that a string is a valid glob pattern.
 */
const globPatternSchema = string().refine(
	(pattern) => {
		try {
			new Glob(pattern)
			return true
		} catch {
			return false
		}
	},
	{ message: "Invalid glob pattern" },
)

// =============================================================================
// PROFILE OCX CONFIG SCHEMA (ocx.jsonc in profiles)
// =============================================================================

/**
 * V2: OCX profile configuration schema
 *
 * Contains OCX-specific settings (registries, componentPath).
 * OpenCode configuration is stored separately in opencode.jsonc.
 * Profiles layer: global base + local overlay of same name (overlay wins).
 */
export const profileOcxConfigSchema = object({
	/** Schema URL for IDE support */
	$schema: string().optional(),

	/** Path to OpenCode binary. Falls back to OPENCODE_BIN env var, then "opencode". */
	bin: string().optional(),

	/**
	 * Configured registries for OCX profiles
	 * Same format as ocx.jsonc registries
	 */
	registries: record(string(), registryConfigSchema).default({}),

	/**
	 * Optional default component path for installations
	 * If not set, uses the standard .opencode directory
	 * Uses safeRelativePathSchema to prevent path traversal attacks
	 */
	componentPath: safeRelativePathSchema.optional(),

	/**
	 * Whether to set terminal/tmux window name when launching OpenCode.
	 * Set to false to preserve your existing terminal title.
	 */
	renameWindow: boolean()
		.default(true)
		.describe("Set terminal/tmux window name when launching OpenCode"),

	/**
	 * V2: Glob patterns for project files to exclude from OpenCode discovery.
	 * Controls visibility of local config files.
	 * Note: AGENTS.md is NOT excluded by default - uncomment in ocx.jsonc to exclude.
	 */
	exclude: array(globPatternSchema)
		.default([
			"**/CLAUDE.md",
			"**/CONTEXT.md",
			"**/.opencode/**",
			"**/opencode.jsonc",
			"**/opencode.json",
		])
		.describe("Glob patterns for project files to exclude from OpenCode discovery"),

	/**
	 * V2: Glob patterns for project files to include (overrides exclude).
	 * Use when you need specific files from otherwise excluded patterns.
	 */
	include: array(globPatternSchema)
		.default([])
		.describe("Glob patterns for project files to include (overrides exclude)"),
})

export type ProfileOcxConfig = ZodInfer<typeof profileOcxConfigSchema>

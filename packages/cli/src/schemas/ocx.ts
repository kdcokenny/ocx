/**
 * OCX Profile Config Schema
 *
 * Schema for ocx.jsonc (within profiles) - the global OCX configuration file
 * stored at ~/.config/opencode/profiles/<name>/ocx.jsonc (XDG-compliant).
 *
 * OCX profiles allow working without project-local config files
 * by storing registries globally.
 */

import { Glob } from "bun"
import { z } from "zod"
import { safeRelativePathSchema } from "./common"
import { registryConfigSchema } from "./config"

/**
 * Validates that a string is a valid glob pattern.
 */
const globPatternSchema = z.string().refine(
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
 * OCX profile configuration schema
 *
 * Contains OCX-specific settings (registries, componentPath).
 * OpenCode configuration is stored separately in opencode.jsonc.
 */
export const profileOcxConfigSchema = z.object({
	/** Schema URL for IDE support */
	$schema: z.string().optional(),

	/** Path to OpenCode binary. Falls back to OPENCODE_BIN env var, then "opencode". */
	bin: z.string().optional(),

	/**
	 * Configured registries for OCX profiles
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
	 * Whether to set terminal/tmux window name when launching OpenCode.
	 * Set to false to preserve your existing terminal title.
	 */
	renameWindow: z
		.boolean()
		.default(true)
		.describe("Set terminal/tmux window name when launching OpenCode"),

	/**
	 * Glob patterns for project files to exclude from OpenCode discovery.
	 * Prevents OCX profiles from loading project-local configuration files.
	 */
	exclude: z
		.array(globPatternSchema)
		.default([
			"**/AGENTS.md",
			"**/CLAUDE.md",
			"**/CONTEXT.md",
			"**/.opencode/**",
			"**/opencode.jsonc",
			"**/opencode.json",
		])
		.describe("Glob patterns for project files to exclude from OpenCode discovery"),

	/**
	 * Glob patterns for project files to include (overrides exclude).
	 * Use when you need specific files from otherwise excluded patterns.
	 */
	include: z
		.array(globPatternSchema)
		.default([])
		.describe("Glob patterns for project files to include (overrides exclude)"),
})

export type ProfileOcxConfig = z.infer<typeof profileOcxConfigSchema>

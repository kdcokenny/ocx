import type { infer as ZodInfer } from "zod"
import { boolean, object, record, string, unknown } from "zod"
import { profileOcxConfigSchema } from "../schemas/ocx"

/**
 * Profile name validation schema.
 * - Must start with a letter
 * - Can contain alphanumeric, dots, underscores, hyphens
 * - 1-32 characters
 * Based on CCS variant-service.ts pattern.
 */
export const profileNameSchema = string()
	.min(1, "Profile name is required")
	.max(32, "Profile name must be 32 characters or less")
	.regex(
		/^[a-zA-Z][a-zA-Z0-9._-]*$/,
		"Profile name must start with a letter and contain only alphanumeric characters, dots, underscores, or hyphens",
	)

export type ProfileName = ZodInfer<typeof profileNameSchema>

/**
 * Represents a loaded profile with all its data.
 */
export const profileSchema = object({
	/** Profile name (directory name) */
	name: profileNameSchema,
	/** OCX configuration from ocx.jsonc */
	ocx: profileOcxConfigSchema,
	/** OpenCode configuration from opencode.jsonc (optional, passthrough) */
	opencode: record(string(), unknown()).optional(),
	/** Whether AGENTS.md exists in this profile */
	hasAgents: boolean(),
})

export type Profile = ZodInfer<typeof profileSchema>

import type { infer as ZodInfer } from "zod"
import { boolean, object, record, string, unknown } from "zod"
import { profileOcxConfigSchema } from "../schemas/ocx"

export { type ProfileName, profileNameSchema } from "./paths"

import { profileNameSchema } from "./paths"

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

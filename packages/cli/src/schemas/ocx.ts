import { type infer as Infer, object, record, string, enum as zEnum } from "zod"
import { registryConfigSchema } from "./config"

/** OCX owns this metadata; OpenCode owns every native configuration field. */
export const profileOcxConfigSchema = object({
	$schema: string().optional(),
	bin: string().trim().min(1).optional(),
	registries: record(string(), registryConfigSchema).default({}),
	projectConfig: zEnum(["ignore", "inherit"]).default("ignore"),
}).strict()

export type ProfileOcxConfig = Infer<typeof profileOcxConfigSchema>

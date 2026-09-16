import { type ParseError, parse } from "jsonc-parser"
import { getGlobalConfig } from "../profile/paths"
import { ocxConfigSchema } from "../schemas/config"
import { ConfigError } from "../utils/errors"

export async function readJsoncObject(filePath: string): Promise<Record<string, unknown>> {
	const errors: ParseError[] = []
	const value: unknown = parse(await Bun.file(filePath).text(), errors, {
		allowTrailingComma: true,
	})
	if (errors.length > 0 || !value || typeof value !== "object" || Array.isArray(value)) {
		throw new ConfigError(`Invalid JSONC object in ${filePath}`)
	}
	return value as Record<string, unknown>
}

export async function readGlobalConfig() {
	const filePath = getGlobalConfig()
	if (!(await Bun.file(filePath).exists())) return ocxConfigSchema.parse({})
	return ocxConfigSchema.parse(await readJsoncObject(filePath))
}

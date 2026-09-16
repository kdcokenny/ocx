import { isAbsolute, posix } from "node:path"
import {
	array,
	literal,
	object,
	record,
	string,
	union,
	type infer as ZodInfer,
	enum as zEnum,
} from "zod"
import { OCX_DOMAIN, REGISTRY_SCHEMA_LATEST_MAJOR, REGISTRY_SCHEMA_LATEST_URL } from "../constants"
import { type RegistryCompatIssue, ValidationError } from "../utils/errors"
import { PathValidationError, validatePath } from "../utils/path-security"

export const openCodeNameSchema = string()
	.min(1)
	.max(64)
	.regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase alphanumeric names with single hyphens")
export const aliasSchema = openCodeNameSchema
export const namespaceSchema = aliasSchema
export const qualifiedComponentSchema = string()
	.regex(
		/^[a-z0-9]+(-[a-z0-9]+)*\/[a-z0-9]+(-[a-z0-9]+)*$/,
		'Use "alias/component" (for example "team/reviewer")',
	)
	.refine(
		(value) => value.split("/").every((part) => openCodeNameSchema.safeParse(part).success),
		"Registry alias and component name must each be at most 64 characters",
	)

export function parseQualifiedComponent(ref: string): { namespace: string; component: string } {
	const parsed = qualifiedComponentSchema.safeParse(ref)
	if (!parsed.success)
		throw new ValidationError(`Invalid component reference "${ref}". Use alias/component.`)
	const [namespace, component] = parsed.data.split("/")
	if (!namespace || !component) throw new ValidationError(`Invalid component reference "${ref}"`)
	return { namespace, component }
}

export function createQualifiedComponent(namespace: string, component: string): string {
	return `${namespace}/${component}`
}
export const dependencyRefSchema = union([openCodeNameSchema, qualifiedComponentSchema])
// Types describe copied files; they never enable package installation or runtime hooks.
export const componentTypeSchema = zEnum([
	"agent",
	"skill",
	"command",
	"bundle",
	"profile",
	"plugin",
	"tool",
])
export type ComponentType = ZodInfer<typeof componentTypeSchema>

const PROFILE_CONFIG_FILES = new Set([
	"ocx.jsonc",
	"opencode.json",
	"opencode.jsonc",
	"cli.json",
	"agents.md",
])
const PROTECTED_ROOTS = new Set([".ocx", ".git", ".opencode", "node_modules"])
const PROTECTED_FILES = new Set([
	"ocx.lock",
	"package.json",
	"package-lock.json",
	"bun.lock",
	"bun.lockb",
	"pnpm-lock.yaml",
	"yarn.lock",
])

export function validateSafePath(filePath: string): void {
	const unified = filePath.normalize("NFC").replace(/\\/g, "/")
	if (
		!unified ||
		isAbsolute(filePath) ||
		/^[a-zA-Z]:/.test(unified) ||
		unified.startsWith("~") ||
		unified.includes("\0")
	) {
		throw new ValidationError(`Invalid path "${filePath}": expected a relative file path`)
	}
	if (
		unified
			.split("/")
			.some(
				(segment) =>
					!segment ||
					segment === "." ||
					segment === ".." ||
					/[. ]$|[<>:"|?*]/.test(segment) ||
					Array.from(segment).some((character) => character.charCodeAt(0) < 32) ||
					/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment),
			)
	) {
		throw new ValidationError(
			`Invalid path "${filePath}": empty and traversal segments are not allowed`,
		)
	}
}

export function validateFileTarget(target: string, componentType?: ComponentType): void {
	validateSafePath(target)
	const normalized = posix.normalize(target.replace(/\\/g, "/"))
	const root = normalized.split("/")[0]?.toLowerCase() ?? ""
	if (
		PROTECTED_ROOTS.has(root) ||
		PROTECTED_FILES.has(normalized.toLowerCase()) ||
		root === ".env" ||
		root.startsWith(".env.")
	) {
		throw new ValidationError(`Target "${target}" is reserved and cannot be installed`)
	}
	if (PROFILE_CONFIG_FILES.has(normalized.toLowerCase()) && componentType !== "profile") {
		throw new ValidationError(
			`Only a profile may own "${target}". Components copy files; they do not patch configuration.`,
		)
	}
	try {
		validatePath("/ocx-validation-root", normalized)
	} catch (error) {
		if (error instanceof PathValidationError)
			throw new ValidationError(`Invalid target "${target}": ${error.message}`)
		throw error
	}
}

const caseInsensitive = (text: string) =>
	Array.from(text)
		.map((character) =>
			/[a-z]/i.test(character)
				? `[${character.toLowerCase()}${character.toUpperCase()}]`
				: character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
		)
		.join("")
const reservedNames = [
	"con",
	"prn",
	"aux",
	"nul",
	...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
	...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]
	.map(caseInsensitive)
	.join("|")
const segmentPattern = String.raw`(?!(?:${reservedNames})(?:\.|[/\\]|$))[^\x00-\x1f<>:"|?*/\\]+(?<![. ])`
const safePathPattern = new RegExp(String.raw`^(?!~)${segmentPattern}(?:[/\\]${segmentPattern})*$`)
const protectedPathPattern = new RegExp(
	String.raw`^(?!(?:${[...PROTECTED_ROOTS].map(caseInsensitive).join("|")})(?:[/\\]|$))(?!(?:${[...PROTECTED_FILES].map(caseInsensitive).join("|")})$)(?!${caseInsensitive(".env")}(?:\.|[/\\]|$))`,
)

const relativeFileSchema = string()
	.regex(safePathPattern, "Expected a portable relative file path")
	.superRefine((value, context) => {
		try {
			validateSafePath(value)
		} catch (error) {
			context.addIssue({
				code: "custom",
				message: error instanceof Error ? error.message : String(error),
			})
		}
	})
export const targetPathSchema = relativeFileSchema.regex(
	protectedPathPattern,
	"Target is reserved and cannot be installed",
)
export const componentFileObjectSchema = object({
	path: relativeFileSchema,
	target: targetPathSchema,
}).strict()
export const componentFileSchema = union([targetPathSchema, componentFileObjectSchema])
export type ComponentFileObject = ZodInfer<typeof componentFileObjectSchema>
export type ComponentFile = ZodInfer<typeof componentFileSchema>
export function inferTargetPath(sourcePath: string): string {
	return sourcePath
}

export function normalizeFile(
	file: ComponentFile,
	componentType?: ComponentType,
): ComponentFileObject {
	const entry = typeof file === "string" ? { path: file, target: file } : file
	validateSafePath(entry.path)
	validateFileTarget(entry.target, componentType)
	return {
		path: entry.path.normalize("NFC").replace(/\\/g, "/"),
		target: entry.target.normalize("NFC").replace(/\\/g, "/"),
	}
}

const semverSchema = string().regex(
	/^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/,
	"Expected a semantic version",
)
export const componentManifestSchema = object({
	name: openCodeNameSchema,
	type: componentTypeSchema,
	description: string().min(1).max(1024),
	version: semverSchema.optional(),
	files: array(componentFileSchema).default([]),
	dependencies: array(dependencyRefSchema).default([]),
})
	.strict()
	.superRefine((component, context) => {
		for (const [index, file] of component.files.entries()) {
			try {
				normalizeFile(file, component.type)
			} catch (error) {
				context.addIssue({
					code: "custom",
					path: ["files", index],
					message: error instanceof Error ? error.message : String(error),
				})
			}
		}
	})
export type ComponentManifest = ZodInfer<typeof componentManifestSchema>
export interface NormalizedComponentManifest extends Omit<ComponentManifest, "files"> {
	files: ComponentFileObject[]
}
export function normalizeComponentManifest(
	manifest: ComponentManifest,
): NormalizedComponentManifest {
	return { ...manifest, files: manifest.files.map((file) => normalizeFile(file, manifest.type)) }
}

export interface RegistrySchemaUrlIssue {
	issue: Exclude<RegistryCompatIssue, "invalid-format">
	remediation: string
	schemaUrl?: string
	supportedMajor: number
	detectedMajor?: number
}

export function classifyRegistrySchemaIssue(document: unknown): RegistrySchemaUrlIssue | null {
	if (!document || typeof document !== "object") return null
	const value = (document as Record<string, unknown>).$schema
	if (value === REGISTRY_SCHEMA_LATEST_URL) return null
	const schemaUrl = typeof value === "string" ? value : undefined
	const prefix = `https://${OCX_DOMAIN}/schemas/v`
	const version = schemaUrl?.startsWith(prefix)
		? schemaUrl.slice(prefix.length).match(/^(\d+)\/registry\.json$/)?.[1]
		: undefined
	const detectedMajor = version ? Number(version) : undefined
	return {
		issue:
			value === undefined
				? "legacy-schema-v1"
				: detectedMajor
					? "unsupported-schema-version"
					: "invalid-schema-url",
		remediation: `OCX 3 requires the file-only registry schema ${REGISTRY_SCHEMA_LATEST_URL}. Use OCX 2 for legacy registries; changing the URL alone does not migrate config patches or npm dependencies.`,
		...(schemaUrl !== undefined && { schemaUrl }),
		supportedMajor: REGISTRY_SCHEMA_LATEST_MAJOR,
		...(detectedMajor !== undefined && { detectedMajor }),
	}
}

export const registrySchema = object({
	$schema: literal(REGISTRY_SCHEMA_LATEST_URL),
	name: string().min(1),
	version: semverSchema,
	author: string().min(1),
	opencode: semverSchema.optional(),
	ocx: semverSchema.optional(),
	components: array(componentManifestSchema),
})
	.strict()
	.superRefine((registry, context) => {
		const issue = classifyRegistrySchemaIssue(registry)
		if (issue) context.addIssue({ code: "custom", path: ["$schema"], message: issue.remediation })
		const names = new Set<string>()
		for (const [index, component] of registry.components.entries()) {
			if (names.has(component.name))
				context.addIssue({
					code: "custom",
					path: ["components", index, "name"],
					message: "Duplicate component name",
				})
			names.add(component.name)
		}
		for (const [index, component] of registry.components.entries()) {
			for (const dependency of component.dependencies) {
				if (!dependency.includes("/") && !names.has(dependency))
					context.addIssue({
						code: "custom",
						path: ["components", index, "dependencies"],
						message: `Unknown component dependency "${dependency}"`,
					})
			}
		}
	})
export type Registry = ZodInfer<typeof registrySchema>
export const packumentSchema = object({
	name: openCodeNameSchema,
	"dist-tags": object({ latest: semverSchema }),
	versions: record(string(), componentManifestSchema),
})
export type Packument = ZodInfer<typeof packumentSchema>
export const registryIndexSchema = object({
	$schema: literal(REGISTRY_SCHEMA_LATEST_URL),
	name: string().optional(),
	version: semverSchema.optional(),
	author: string(),
	opencode: semverSchema.optional(),
	ocx: semverSchema.optional(),
	components: array(
		object({ name: openCodeNameSchema, type: componentTypeSchema, description: string() }),
	),
})
export type RegistryIndex = ZodInfer<typeof registryIndexSchema>

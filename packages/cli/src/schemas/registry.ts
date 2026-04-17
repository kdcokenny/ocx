/**
 * Registry & Component Schemas
 *
 * Zod schemas with fail-fast validation following the 5 Laws of Elegant Defense.
 * Uses Cargo-style union types: string for simple defaults, object for full control.
 */

import { isAbsolute, normalize } from "node:path"
import type { infer as ZodInfer } from "zod"
import { any, array, boolean, number, object, record, string, union, enum as zEnum } from "zod"
import {
	OCX_DOMAIN,
	REGISTRY_SCHEMA_LATEST_MAJOR,
	REGISTRY_SCHEMA_LATEST_URL,
	REGISTRY_SCHEMA_UNVERSIONED_URL,
} from "../constants"
import type { RegistryCompatIssue } from "../utils/errors"
import { ValidationError } from "../utils/errors"
import { PathValidationError, validatePath } from "../utils/path-security"

// =============================================================================
// NPM SPECIFIER SCHEMA
// =============================================================================

/**
 * npm specifier schema for "npm:package@version" syntax.
 * Validates the format at boundary (Law 2: Parse Don't Validate).
 *
 * Valid formats:
 * - npm:lodash
 * - npm:lodash@4.0.0
 * - npm:@scope/pkg
 * - npm:@scope/pkg@1.0.0
 */
export const npmSpecifierSchema = string()
	.refine((val) => val.startsWith("npm:"), {
		message: 'npm specifier must start with "npm:" prefix',
	})
	.refine(
		(val) => {
			const remainder = val.slice(4)
			// Must have something after npm:
			if (!remainder) return false
			// Cannot contain path traversal
			if (remainder.includes("..") || remainder.includes("/./")) return false
			return true
		},
		{
			message: "Invalid npm specifier format",
		},
	)

export type NpmSpecifier = ZodInfer<typeof npmSpecifierSchema>

// =============================================================================
// OPENCODE NAMING CONSTRAINTS (from OpenCode docs)
// =============================================================================

/**
 * OpenCode name schema following official constraints:
 * - 1-64 characters
 * - Lowercase alphanumeric with single hyphen separators
 * - Cannot start or end with hyphen
 * - Cannot contain consecutive hyphens
 *
 * Regex: ^[a-z0-9]+(-[a-z0-9]+)*$
 */
export const openCodeNameSchema = string()
	.min(1, "Name cannot be empty")
	.max(64, "Name cannot exceed 64 characters")
	.regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
		message:
			"Must be lowercase alphanumeric with single hyphen separators (e.g., 'my-component', 'my-plugin'). Cannot start/end with hyphen or have consecutive hyphens.",
	})

/**
 * Alias schema — validates a user-chosen registry alias token.
 * An alias is the left-hand side of an `alias/component` qualified reference
 * (e.g. "kdco" in "kdco/researcher"). Same naming rules as openCodeNameSchema.
 */
export const aliasSchema = openCodeNameSchema

/** @deprecated Use `aliasSchema` instead. Kept for backward compatibility. */
export const namespaceSchema = aliasSchema

/**
 * Qualified component reference: alias/component
 * Used in CLI commands and lockfile keys
 */
export const qualifiedComponentSchema = string().regex(
	/^[a-z0-9]+(-[a-z0-9]+)*\/[a-z0-9]+(-[a-z0-9]+)*$/,
	{
		message:
			'Must be in format "alias/component" (e.g., "kdco/researcher"). Both parts must be lowercase alphanumeric with hyphens.',
	},
)

/**
 * Parse a qualified component reference into its alias and component tokens.
 *
 * The returned `namespace` field is the user-chosen registry **alias** token
 * from the `alias/component` syntax — it is NOT a registry index authority.
 * The alias is resolved to a concrete registry URL at install time via ocx.jsonc.
 *
 * @throws Error if format is invalid (Law 4: Fail Fast, Fail Loud).
 */
export function parseQualifiedComponent(ref: string): { namespace: string; component: string } {
	if (!ref.includes("/")) {
		throw new Error(`Invalid component reference: "${ref}". Use format: alias/component`)
	}
	const parts = ref.split("/")
	if (parts.length > 2) {
		throw new Error(
			`Invalid component reference: "${ref}". Too many "/" separators. Use format: alias/component`,
		)
	}
	const [namespace, component] = parts
	if (!namespace || !component) {
		throw new Error(`Invalid component reference: "${ref}". Both alias and component are required.`)
	}
	return { namespace, component }
}

/**
 * Create a qualified component reference from alias and component name.
 */
export function createQualifiedComponent(namespace: string, component: string): string {
	return `${namespace}/${component}`
}

/**
 * Dependency reference schema (Cargo-style):
 * - Bare string: "utils" -> same registry alias (implicit)
 * - Qualified: "acme/utils" -> cross-registry (explicit)
 */
export const dependencyRefSchema = string().refine(
	(dep) => {
		// Either a bare component name or a qualified alias/component
		const barePattern = /^[a-z0-9]+(-[a-z0-9]+)*$/
		const qualifiedPattern = /^[a-z0-9]+(-[a-z0-9]+)*\/[a-z0-9]+(-[a-z0-9]+)*$/
		return barePattern.test(dep) || qualifiedPattern.test(dep)
	},
	{
		message:
			'Dependency must be either a bare name (e.g., "utils") or qualified (e.g., "acme/utils")',
	},
)

// =============================================================================
// FILE TARGET SCHEMAS
// =============================================================================

export const componentTypeSchema = zEnum([
	"agent",
	"skill",
	"plugin",
	"command",
	"tool",
	"bundle",
	"profile",
])

export type ComponentType = ZodInfer<typeof componentTypeSchema>

/** Reserved targets (installer-owned files) */
const RESERVED_TARGETS = new Set([".ocx", "ocx.lock"])

/**
 * Paths that registry components cannot target.
 * These are either OCX-managed files or dangerous paths.
 */
const BLOCKED_PATHS = [
	// OCX-managed files
	".ocx/", // Receipt, state (covers receipt.jsonc)
	"ocx.jsonc", // OCX config
	"package.json", // We generate this in .opencode/

	// Dangerous paths
	".git/", // Git internals
	".env", // Secrets
	"node_modules/", // Dependencies
] as const

/**
 * V2: Target paths are root-relative (no .opencode/ prefix).
 * Blocks protected paths that could compromise security or OCX functionality.
 * Validates path safety using schema-level checks.
 */
export const targetPathSchema = string()
	.min(1, "Target path cannot be empty")
	.refine(
		(path) => {
			// No absolute paths
			if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return false
			// No null bytes
			if (path.includes("\0")) return false
			return true
		},
		{
			message: "Target path must be relative and safe (no absolute paths or null bytes)",
		},
	)
	.refine(
		(path) => {
			// Check if path is blocked
			return !BLOCKED_PATHS.some((blocked) => path === blocked || path.startsWith(blocked))
		},
		{
			message: "Target path is protected and cannot be overwritten by registry components",
		},
	)

// =============================================================================
// MCP SERVER SCHEMA (Cargo-style: string URL or full object)
// =============================================================================

/**
 * OAuth configuration for MCP servers.
 * Supports advanced OAuth flows with custom client configuration.
 */
export const oauthConfigSchema = object({
	/** OAuth client ID */
	clientId: string().optional(),
	/** OAuth scopes to request */
	scopes: array(string()).optional(),
	/** OAuth authorization URL */
	authUrl: string().optional(),
	/** OAuth token URL */
	tokenUrl: string().optional(),
})

export type OAuthConfig = ZodInfer<typeof oauthConfigSchema>

/**
 * Full MCP server configuration object
 */
export const mcpServerObjectSchema = object({
	type: zEnum(["remote", "local"]),
	/** Server URL (relaxed validation - allows non-URL strings) */
	url: string().optional(),
	/**
	 * Command to run for local servers.
	 * Can be a single string (e.g., "npx foo") or array (e.g., ["npx", "foo"])
	 */
	command: union([string(), array(string())]).optional(),
	environment: record(string(), string()).optional(),
	headers: record(string(), string()).optional(),
	/**
	 * OAuth configuration.
	 * - true: Enable OAuth with defaults
	 * - object: Enable OAuth with custom configuration
	 */
	oauth: union([boolean(), oauthConfigSchema]).optional(),
	enabled: boolean().default(true),
}).refine(
	(data) => {
		if (data.type === "remote" && !data.url) {
			return false
		}
		if (data.type === "local" && !data.command) {
			return false
		}
		return true
	},
	{
		message: "Remote MCP servers require 'url', local servers require 'command'",
	},
)

export type McpServer = ZodInfer<typeof mcpServerObjectSchema>

/**
 * Cargo-style MCP server reference:
 * - String: URL shorthand for remote server (e.g., "https://mcp.example.com")
 * - Object: Full configuration
 */
export const mcpServerRefSchema = union([string(), mcpServerObjectSchema])

export type McpServerRef = ZodInfer<typeof mcpServerRefSchema>

// =============================================================================
// COMPONENT FILE SCHEMA (Cargo-style: string path or full object)
// =============================================================================

/**
 * Full file configuration object.
 * Target validation is deferred to normalizeFile() where component type is known.
 */
export const componentFileObjectSchema = object({
	/** Source path in registry */
	path: string().min(1, "File path cannot be empty"),
	/** Target path - validation deferred to normalizeFile() for type-aware checking */
	target: string().min(1, "Target path cannot be empty"),
})

export type ComponentFileObject = ZodInfer<typeof componentFileObjectSchema>

/**
 * Cargo-style file schema:
 * - String: Path shorthand, target auto-inferred (e.g., "plugins/foo.ts" -> "plugins/foo.ts")
 * - Object: Full configuration with explicit target
 */
export const componentFileSchema = union([
	string().min(1, "File path cannot be empty"),
	componentFileObjectSchema,
])

export type ComponentFile = ZodInfer<typeof componentFileSchema>

// =============================================================================
// OPENCODE CONFIG BLOCK SCHEMA
// =============================================================================

// -----------------------------------------------------------------------------
// Provider Configuration
// -----------------------------------------------------------------------------

/**
 * Provider configuration for AI model providers.
 * Supports custom API endpoints, headers, and environment variables.
 */
export const providerConfigSchema = object({
	/** API base URL */
	api: string().optional(),
	/** Custom headers */
	headers: record(string(), string()).optional(),
	/** Environment variables for API keys */
	env: record(string(), string()).optional(),
	/** Whether provider is enabled */
	enabled: boolean().optional(),
}).passthrough()

export type ProviderConfig = ZodInfer<typeof providerConfigSchema>

// -----------------------------------------------------------------------------
// LSP, Formatter, Command Configuration
// -----------------------------------------------------------------------------

/**
 * Language Server Protocol configuration.
 * Defines how to start and configure LSP servers.
 */
export const lspConfigSchema = object({
	/** Command to run (string or array of args) */
	command: union([string(), array(string())]).optional(),
	/** Whether LSP is enabled */
	enabled: boolean().optional(),
}).passthrough()

export type LspConfig = ZodInfer<typeof lspConfigSchema>

/**
 * Formatter configuration for code formatting.
 * Defines the command and file patterns to format.
 */
export const formatterConfigSchema = object({
	/** Command to run (string or array of args) */
	command: union([string(), array(string())]).optional(),
	/** Glob pattern for files to format */
	glob: string().optional(),
}).passthrough()

export type FormatterConfig = ZodInfer<typeof formatterConfigSchema>

/**
 * Custom command configuration.
 * Defines executable commands with descriptions.
 */
export const commandConfigSchema = object({
	/** Command description */
	description: string().optional(),
	/** The command to run */
	run: string().optional(),
}).passthrough()

export type CommandConfig = ZodInfer<typeof commandConfigSchema>

// -----------------------------------------------------------------------------
// TUI, Server, Keybind, Watcher Configuration
// -----------------------------------------------------------------------------

/**
 * TUI (Terminal User Interface) configuration.
 */
export const tuiConfigSchema = object({
	/** Disable TUI features */
	disabled: boolean().optional(),
}).passthrough()

export type TuiConfig = ZodInfer<typeof tuiConfigSchema>

/**
 * Server configuration for OpenCode server mode.
 */
export const serverConfigSchema = object({
	/** Server host */
	host: string().optional(),
	/** Server port */
	port: number().optional(),
}).passthrough()

export type ServerConfig = ZodInfer<typeof serverConfigSchema>

/**
 * Keybind configuration - maps action names to key combinations.
 */
export const keybindConfigSchema = record(string(), string())

export type KeybindConfig = ZodInfer<typeof keybindConfigSchema>

/**
 * File watcher configuration for automatic reloads.
 */
export const watcherConfigSchema = object({
	/** Patterns to include */
	include: array(string()).optional(),
	/** Patterns to exclude */
	exclude: array(string()).optional(),
}).passthrough()

export type WatcherConfig = ZodInfer<typeof watcherConfigSchema>

// -----------------------------------------------------------------------------
// Agent Configuration
// -----------------------------------------------------------------------------

/**
 * Agent configuration options (matches opencode.json agent schema)
 */
export const agentConfigSchema = object({
	/** Per-agent model override */
	model: string().optional(),

	/** Agent description for self-documentation */
	description: string().optional(),

	/** Maximum iterations/steps for the agent (must be positive integer) */
	steps: number().int().positive().optional(),

	/** @deprecated Use `steps` instead (must be positive integer) */
	maxSteps: number().int().positive().optional(),

	/** Agent mode */
	mode: zEnum(["primary", "subagent", "all"]).optional(),

	/** Tool enable/disable patterns */
	tools: record(string(), boolean()).optional(),

	/** Sampling temperature (provider-specific limits) */
	temperature: number().optional(),

	/** Nucleus sampling parameter */
	top_p: number().optional(),

	/** Additional prompt text */
	prompt: string().optional(),

	/**
	 * Permission matrix for agent operations.
	 * Use `{ "*": "deny" }` for bash to enable read-only agent detection.
	 */
	permission: record(
		string(),
		union([zEnum(["ask", "allow", "deny"]), record(string(), zEnum(["ask", "allow", "deny"]))]),
	).optional(),

	/** UI color for the agent */
	color: string().optional(),

	/** Whether the agent is disabled */
	disable: boolean().optional(),

	/** Custom options for the agent */
	options: record(string(), any()).optional(),
})

export type AgentConfig = ZodInfer<typeof agentConfigSchema>

/**
 * Permission configuration schema (matches opencode.json permission schema)
 * Supports both simple values and per-path patterns
 */
export const permissionConfigSchema = object({
	/**
	 * Bash command permissions.
	 * - Use `"allow"` for full bash access
	 * - Use `{ "*": "deny" }` to deny all bash (required for read-only agent detection)
	 * - Use patterns like `{ "git *": "allow", "*": "deny" }` for partial access
	 */
	bash: union([
		zEnum(["ask", "allow", "deny"]),
		record(string(), zEnum(["ask", "allow", "deny"])),
	]).optional(),
	/** File edit permissions */
	edit: union([
		zEnum(["ask", "allow", "deny"]),
		record(string(), zEnum(["ask", "allow", "deny"])),
	]).optional(),
	/** MCP server permissions */
	mcp: record(string(), zEnum(["ask", "allow", "deny"])).optional(),
}).catchall(
	union([zEnum(["ask", "allow", "deny"]), record(string(), zEnum(["ask", "allow", "deny"]))]),
)

export type PermissionConfig = ZodInfer<typeof permissionConfigSchema>

/**
 * OpenCode configuration block
 * Mirrors opencode.json structure exactly for 1:1 mapping
 */
export const opencodeConfigSchema = object({
	/** JSON Schema URL for IDE support */
	$schema: string().optional(),

	/** UI theme name */
	theme: string().optional(),

	/** Logging level */
	logLevel: string().optional(),

	/** Username for display */
	username: string().optional(),

	/** Default model to use */
	model: string().optional(),

	/** Small/fast model for simple tasks */
	small_model: string().optional(),

	/** Default agent to use */
	default_agent: string().optional(),

	/** MCP servers (matches opencode.json 'mcp' field) */
	mcp: record(string(), mcpServerRefSchema).optional(),

	/** NPM plugin packages to add to opencode.json 'plugin' array */
	plugin: array(string()).optional(),

	/** Tool enable/disable patterns */
	tools: record(string(), boolean()).optional(),

	/** Per-agent configuration */
	agent: record(string(), agentConfigSchema).optional(),

	/** Global instructions to append */
	instructions: array(string()).optional(),

	/** Permission configuration */
	permission: permissionConfigSchema.optional(),

	/** Provider configurations */
	provider: record(string(), providerConfigSchema).optional(),

	/** LSP configurations */
	lsp: record(string(), lspConfigSchema).optional(),

	/** Formatter configurations */
	formatter: record(string(), formatterConfigSchema).optional(),

	/** Custom command configurations */
	command: record(string(), commandConfigSchema).optional(),

	/** TUI configuration */
	tui: tuiConfigSchema.optional(),

	/** Server configuration */
	server: serverConfigSchema.optional(),

	/** Keybind configuration */
	keybind: keybindConfigSchema.optional(),

	/** File watcher configuration */
	watcher: watcherConfigSchema.optional(),

	/** Enable auto-updates */
	auto_update: boolean().optional(),

	/** Enable auto-compaction */
	auto_compact: boolean().optional(),

	/** Share configuration (boolean or URL string) */
	share: union([boolean(), string()]).optional(),
})

export type OpencodeConfig = ZodInfer<typeof opencodeConfigSchema>

// =============================================================================
// COMPONENT MANIFEST SCHEMA
// =============================================================================

export const componentManifestSchema = object({
	/** Component name (clean, no alias prefix) */
	name: openCodeNameSchema,

	/** Component type */
	type: componentTypeSchema,

	/** Human-readable description */
	description: string().min(1).max(1024),

	/**
	 * Files to install (Cargo-style)
	 * - String: "plugins/foo.ts" -> auto-infers target as "plugins/foo.ts"
	 * - Object: { path: "...", target: "..." } for explicit control
	 * - Optional: bundles (deps-only) may have no files
	 */
	files: array(componentFileSchema).default([]),

	/**
	 * Dependencies on other components (Cargo-style)
	 * - Bare string: "utils" -> same registry alias (implicit)
	 * - Qualified: "acme/utils" -> cross-registry (explicit)
	 */
	dependencies: array(dependencyRefSchema).default([]),

	/** NPM dependencies to install (supports pkg@version syntax) */
	npmDependencies: array(string()).optional(),

	/** NPM dev dependencies to install (supports pkg@version syntax) */
	npmDevDependencies: array(string()).optional(),

	/**
	 * OpenCode configuration to merge into opencode.json
	 * Use this for: mcp servers, plugins, tools, agent config, instructions, permissions
	 */
	opencode: opencodeConfigSchema.optional(),
})

export type ComponentManifest = ZodInfer<typeof componentManifestSchema>

// =============================================================================
// NORMALIZER FUNCTIONS (Parse, Don't Validate - Law 2)
// =============================================================================

/**
 * Validates path doesn't contain traversal attacks.
 * Fails fast with descriptive error (Law 4: Fail Fast, Fail Loud).
 * Uses path.normalize for proper traversal detection.
 * @param filePath - The path to validate
 * @throws ValidationError if path contains traversal patterns
 */
export function validateSafePath(filePath: string): void {
	if (isAbsolute(filePath)) {
		throw new ValidationError(`Invalid path: "${filePath}" - absolute paths not allowed`)
	}
	if (filePath.startsWith("~")) {
		throw new ValidationError(`Invalid path: "${filePath}" - home directory paths not allowed`)
	}
	const normalized = normalize(filePath)
	if (normalized.startsWith("..")) {
		throw new ValidationError(`Invalid path: "${filePath}" - path traversal not allowed`)
	}
}

/**
 * V2: Infer target path from source path (root-relative, no prefix).
 * The path is used as-is since targets are now root-relative.
 * e.g., "plugins/foo.ts" -> "plugins/foo.ts"
 */
export function inferTargetPath(sourcePath: string): string {
	return sourcePath
}

/**
 * V2: Validate a file target path.
 * Checks for reserved paths, blocked paths, and uses runtime containment validation.
 * Component type is inferred from target path (behavior-based, not explicit).
 * @param target - The target path to validate
 * @param componentType - Optional type hint for additional validation context
 * @throws ValidationError if target is invalid
 */
export function validateFileTarget(target: string, componentType?: ComponentType): void {
	// Check reserved targets
	if (RESERVED_TARGETS.has(target)) {
		throw new ValidationError(`Target "${target}" is reserved for installer use`)
	}

	// Validate path safety using battle-tested validation
	try {
		validatePath("/dummy/base", target) // Just validates the path structure
	} catch (error) {
		if (error instanceof PathValidationError) {
			throw new ValidationError(`Invalid target "${target}": ${error.message}`)
		}
		throw error
	}

	// Check blocked paths (except for profiles, which install to their own directory)
	const isProfile = componentType === "profile"
	if (!isProfile) {
		// Normalize the target path to evaluate the cleaned/resolved segments
		// This prevents bypass via paths like "foo/../.git/config"
		const normalized = normalize(target)

		// After normalization, check if path lands in blocked prefixes
		const isBlocked = BLOCKED_PATHS.some(
			(blocked) => normalized === blocked || normalized.startsWith(blocked),
		)
		if (isBlocked) {
			throw new ValidationError(
				`Target path '${target}' is protected and cannot be overwritten by registry components`,
			)
		}
	}
}

/**
 * V2: Normalize a file entry from string shorthand to full object.
 * All targets are root-relative (no .opencode/ prefix logic).
 * @param file - The file entry to normalize
 * @param componentType - Optional component type for validation context
 */
export function normalizeFile(
	file: ComponentFile,
	componentType?: ComponentType,
): ComponentFileObject {
	if (typeof file === "string") {
		validateSafePath(file)
		const target = inferTargetPath(file)
		validateFileTarget(target, componentType)
		return {
			path: file,
			target,
		}
	}

	validateSafePath(file.path)
	validateSafePath(file.target)
	validateFileTarget(file.target, componentType)
	return file
}

/**
 * Normalize an MCP server entry from URL shorthand to full object
 */
export function normalizeMcpServer(server: McpServerRef): McpServer {
	if (typeof server === "string") {
		return {
			type: "remote",
			url: server,
			enabled: true,
		}
	}
	return server
}

/**
 * Normalized opencode config with MCP servers expanded
 */
export interface NormalizedOpencodeConfig extends Omit<OpencodeConfig, "mcp"> {
	mcp?: Record<string, McpServer>
}

/**
 * Normalized component manifest with all shorthands expanded
 */
export interface NormalizedComponentManifest extends Omit<ComponentManifest, "files" | "opencode"> {
	files: ComponentFileObject[]
	opencode?: NormalizedOpencodeConfig
}

/**
 * Normalize all Cargo-style shorthands in a component manifest
 * Call this at the parse boundary to get fully-typed objects
 */
export function normalizeComponentManifest(
	manifest: ComponentManifest,
): NormalizedComponentManifest {
	// Normalize MCP servers inside opencode block
	let normalizedOpencode: NormalizedOpencodeConfig | undefined
	if (manifest.opencode) {
		// Destructure to exclude mcp from spread (Law 2: Parse, Don't Validate)
		// Only include mcp if present - avoid setting undefined (which would overwrite during mergeDeep)
		const { mcp, ...rest } = manifest.opencode
		normalizedOpencode = {
			...rest,
			...(mcp && {
				mcp: Object.fromEntries(
					Object.entries(mcp).map(([name, server]) => [name, normalizeMcpServer(server)]),
				),
			}),
		}
	}

	return {
		...manifest,
		files: manifest.files.map((file) => normalizeFile(file, manifest.type)),
		opencode: normalizedOpencode,
	}
}

// =============================================================================
// REGISTRY SCHEMA
// =============================================================================

const REGISTRY_SCHEMA_VERSIONED_URL_REGEX = new RegExp(
	`^https://${OCX_DOMAIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/schemas/v([1-9]\\d*)/registry\\.json$`,
)

export interface RegistrySchemaUrlIssue {
	issue: Exclude<RegistryCompatIssue, "invalid-format">
	remediation: string
	schemaUrl?: string
	supportedMajor: number
	detectedMajor?: number
}

/**
 * Classify registry schema URL compatibility.
 * Single source of truth for local manifests and remote index payloads.
 */
export function classifyRegistrySchemaIssue(document: unknown): RegistrySchemaUrlIssue | null {
	if (document === null || document === undefined || typeof document !== "object") {
		return null
	}

	const documentRecord = document as Record<string, unknown>
	const hasSchemaField = Object.hasOwn(documentRecord, "$schema")
	if (!hasSchemaField) {
		return {
			issue: "legacy-schema-v1",
			remediation:
				`This registry uses legacy schema v1 (missing $schema). ` +
				`Set "$schema" to "${REGISTRY_SCHEMA_LATEST_URL}".`,
			supportedMajor: REGISTRY_SCHEMA_LATEST_MAJOR,
		}
	}

	const schemaUrl = documentRecord.$schema

	if (typeof schemaUrl !== "string") {
		return {
			issue: "invalid-schema-url",
			remediation: `Registry $schema must be a canonical URL like "${REGISTRY_SCHEMA_LATEST_URL}".`,
			schemaUrl: String(schemaUrl),
			supportedMajor: REGISTRY_SCHEMA_LATEST_MAJOR,
		}
	}

	if (!schemaUrl) {
		return {
			issue: "invalid-schema-url",
			remediation: `Registry $schema must be a canonical URL like "${REGISTRY_SCHEMA_LATEST_URL}".`,
			schemaUrl,
			supportedMajor: REGISTRY_SCHEMA_LATEST_MAJOR,
		}
	}

	if (schemaUrl === REGISTRY_SCHEMA_UNVERSIONED_URL) {
		return {
			issue: "legacy-schema-v1",
			remediation:
				`Schema URL "${REGISTRY_SCHEMA_UNVERSIONED_URL}" is legacy v1. ` +
				`Use "${REGISTRY_SCHEMA_LATEST_URL}" instead.`,
			schemaUrl,
			supportedMajor: REGISTRY_SCHEMA_LATEST_MAJOR,
		}
	}

	const versionMatch = schemaUrl.match(REGISTRY_SCHEMA_VERSIONED_URL_REGEX)
	if (!versionMatch) {
		return {
			issue: "invalid-schema-url",
			remediation: `Registry $schema must be a canonical URL like "${REGISTRY_SCHEMA_LATEST_URL}".`,
			schemaUrl,
			supportedMajor: REGISTRY_SCHEMA_LATEST_MAJOR,
		}
	}

	const majorToken = versionMatch[1]
	if (!majorToken) {
		return {
			issue: "invalid-schema-url",
			remediation: `Registry $schema must be a canonical URL like "${REGISTRY_SCHEMA_LATEST_URL}".`,
			schemaUrl,
			supportedMajor: REGISTRY_SCHEMA_LATEST_MAJOR,
		}
	}

	const major = Number.parseInt(majorToken, 10)
	if (major !== REGISTRY_SCHEMA_LATEST_MAJOR) {
		return {
			issue: "unsupported-schema-version",
			remediation:
				`Schema major v${major} is unsupported. ` +
				`Use "${REGISTRY_SCHEMA_LATEST_URL}" (v${REGISTRY_SCHEMA_LATEST_MAJOR}).`,
			schemaUrl,
			supportedMajor: REGISTRY_SCHEMA_LATEST_MAJOR,
			detectedMajor: major,
		}
	}

	return null
}

/**
 * Semver regex for version validation
 */
const semverRegex = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/

/**
 * Registry manifest schema.
 *
 * `name`, `version`, and `author` are **required** metadata.
 * This is intentional — every published registry must be identifiable and
 * versioned so that OCX can resolve, cache, and diff registries reliably.
 * Omitting `name` or `version` is a validation error at parse time
 * (Law 4: Fail Fast, Fail Loud).
 */
export const registrySchema = object({
	/** JSON Schema URL for IDE support */
	$schema: string().optional(),

	/** Registry display name (required — identifies the registry to users and tooling) */
	name: string().min(1, "Registry name cannot be empty"),

	/** Registry version, semver (required — enables deterministic resolution and caching) */
	version: string().regex(semverRegex, { message: "Version must be valid semver" }),

	/** Registry author (required) */
	author: string().min(1, "Author cannot be empty"),

	/** Minimum OpenCode version required (semver, e.g., "1.0.0") */
	opencode: string()
		.regex(semverRegex, {
			message: "OpenCode version must be valid semver",
		})
		.optional(),

	/** Minimum OCX CLI version required (semver, e.g., "1.0.0") */
	ocx: string()
		.regex(semverRegex, {
			message: "OCX version must be valid semver",
		})
		.optional(),

	/** Components in this registry */
	components: array(componentManifestSchema),
}).refine(
	(data) => {
		// All dependencies must either:
		// 1. Be a bare name that exists in this registry
		// 2. Be a qualified cross-registry reference (validated at install time)
		const componentNames = new Set(data.components.map((c) => c.name))
		for (const component of data.components) {
			for (const dep of component.dependencies) {
				// Only validate bare (same-registry) dependencies
				if (!dep.includes("/") && !componentNames.has(dep)) {
					return false
				}
			}
		}
		return true
	},
	{
		message:
			"Bare dependencies must reference components that exist in the registry. Use qualified references (e.g., 'other-registry/component') for cross-registry dependencies.",
	},
)

export type Registry = ZodInfer<typeof registrySchema>

// =============================================================================
// PACKUMENT SCHEMA (npm-style versioned component)
// =============================================================================

export const packumentSchema = object({
	/** Component name */
	name: openCodeNameSchema,

	/** Latest version */
	"dist-tags": object({
		latest: string(),
	}),

	/** All versions */
	versions: record(string(), componentManifestSchema),
})

export type Packument = ZodInfer<typeof packumentSchema>

// =============================================================================
// REGISTRY INDEX SCHEMA
// =============================================================================

export const registryIndexSchema = object({
	/** JSON Schema URL for IDE support */
	$schema: string().optional(),

	/** Registry author */
	author: string(),

	/** Minimum OpenCode version required */
	opencode: string()
		.regex(semverRegex, {
			message: "OpenCode version must be valid semver",
		})
		.optional(),

	/** Minimum OCX CLI version required */
	ocx: string()
		.regex(semverRegex, {
			message: "OCX version must be valid semver",
		})
		.optional(),

	/** Component summaries for search */
	components: array(
		object({
			name: openCodeNameSchema,
			type: componentTypeSchema,
			description: string(),
		}),
	),
})

export type RegistryIndex = ZodInfer<typeof registryIndexSchema>

/**
 * Schemas Barrel Export
 *
 * Exports all schemas and Bun-specific I/O helpers.
 */

// Common schemas (reusable validation patterns)
export { safeRelativePathSchema } from "./common"

// Config & lockfile schemas + I/O helpers
export {
	type InstalledComponent,
	installedComponentSchema,
	type OcxConfig,
	type OcxLock,
	ocxConfigSchema,
	ocxLockSchema,
	// Types
	type RegistryConfig,
	// I/O helpers
	readOcxConfig,
	readOcxLock,
	// Schemas
	registryConfigSchema,
	writeOcxConfig,
	writeOcxLock,
} from "./config"

// OCX profile schemas
export { type ProfileOcxConfig, profileOcxConfigSchema } from "./ocx"

// Registry & component schemas
export {
	type AgentConfig,
	agentConfigSchema,
	type ComponentFile,
	type ComponentFileObject,
	type ComponentManifest,
	// Types
	type ComponentType,
	componentFileObjectSchema,
	componentFileSchema,
	componentManifestSchema,
	// Component schemas
	componentTypeSchema,
	createQualifiedComponent,
	dependencyRefSchema,
	// Normalizer functions
	inferTargetPath,
	type McpServer,
	type McpServerRef,
	mcpServerObjectSchema,
	mcpServerRefSchema,
	type NormalizedComponentManifest,
	type NormalizedOpencodeConfig,
	namespaceSchema,
	normalizeComponentManifest,
	normalizeFile,
	normalizeMcpServer,
	type OpencodeConfig,
	// Name schemas
	openCodeNameSchema,
	opencodeConfigSchema,
	type Packument,
	type PermissionConfig,
	packumentSchema,
	// Helper functions
	parseQualifiedComponent,
	permissionConfigSchema,
	qualifiedComponentSchema,
	type Registry,
	type RegistryIndex,
	registryIndexSchema,
	// Registry schemas
	registrySchema,
	targetPathSchema,
} from "./registry"

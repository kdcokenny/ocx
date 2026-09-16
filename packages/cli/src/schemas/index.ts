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
	ocxConfigSchema,
	// Receipt types (V2)
	type Receipt,
	// Types
	type RegistryConfig,
	// I/O helpers
	readReceipt,
	receiptSchema,
	// Schemas
	registryConfigSchema,
	writeReceipt,
} from "./config"

// OCX profile schemas
export { type ProfileOcxConfig, profileOcxConfigSchema } from "./ocx"

// Registry & component schemas
export {
	aliasSchema,
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
	type NormalizedComponentManifest,
	namespaceSchema,
	normalizeComponentManifest,
	normalizeFile,
	// Name schemas
	openCodeNameSchema,
	type Packument,
	packumentSchema,
	// Helper functions
	parseQualifiedComponent,
	qualifiedComponentSchema,
	type Registry,
	type RegistryIndex,
	registryIndexSchema,
	// Registry schemas
	registrySchema,
	targetPathSchema,
} from "./registry"

/**
 * Dependency Resolver with topological sort
 * Based on: https://github.com/shadcn-ui/ui/blob/main/packages/shadcn/src/registry/resolver.ts
 */

import type { RegistryConfig } from "../schemas/config"
import {
	type ComponentManifest,
	createQualifiedComponent,
	type NormalizedComponentManifest,
	type NormalizedOpencodeConfig,
	normalizeComponentManifest,
	type OpencodeConfig,
	parseQualifiedComponent,
} from "../schemas/registry"
import { ConfigError, OCXError, ValidationError } from "../utils/errors"
import { fetchComponent } from "./fetcher"
import { mergeOpencodeConfig } from "./merge"

/**
 * Parse a component reference into namespace and component name.
 * - "kdco/researcher" -> { namespace: "kdco", component: "researcher" }
 * - "researcher" (with defaultNamespace) -> { namespace: defaultNamespace, component: "researcher" }
 * - "researcher" (without defaultNamespace) -> throws error
 */
export function parseComponentRef(
	ref: string,
	defaultNamespace?: string,
): { namespace: string; component: string } {
	// Check if it's a qualified reference (contains /)
	if (ref.includes("/")) {
		return parseQualifiedComponent(ref)
	}

	// Bare name - use default namespace if provided
	if (defaultNamespace) {
		return { namespace: defaultNamespace, component: ref }
	}

	throw new ValidationError(`Component '${ref}' must include a namespace (e.g., 'kdco/${ref}')`)
}

export interface ResolvedComponent extends NormalizedComponentManifest {
	/** The namespace this component belongs to */
	namespace: string
	/** The registry name from ocx.jsonc */
	registryName: string
	baseUrl: string
	/** Qualified name (namespace/component) */
	qualifiedName: string
}

export interface ResolvedDependencies {
	/** All components in dependency order (dependencies first) */
	components: ResolvedComponent[]
	/** Install order (component names) */
	installOrder: string[]
	/** Aggregated npm dependencies from all components */
	npmDependencies: string[]
	/** Aggregated npm dev dependencies from all components */
	npmDevDependencies: string[]
	/** Merged opencode configuration from all components (deep merged) */
	opencode: OpencodeConfig
}

/**
 * Resolve all dependencies for a set of components across multiple registries
 * Returns components in topological order (dependencies first)
 */
export async function resolveDependencies(
	registries: Record<string, RegistryConfig>,
	componentNames: string[],
): Promise<ResolvedDependencies> {
	const resolved = new Map<string, ResolvedComponent>()
	const visiting = new Set<string>()
	const npmDeps = new Set<string>()
	const npmDevDeps = new Set<string>()
	let opencode: NormalizedOpencodeConfig = {}

	async function resolve(
		componentNamespace: string,
		componentName: string,
		path: string[] = [],
	): Promise<void> {
		const qualifiedName = createQualifiedComponent(componentNamespace, componentName)

		// Already resolved
		if (resolved.has(qualifiedName)) {
			return
		}

		// Cycle detection
		if (visiting.has(qualifiedName)) {
			const cycle = [...path, qualifiedName].join(" → ")
			throw new ValidationError(`Circular dependency detected: ${cycle}`)
		}

		visiting.add(qualifiedName)

		// Look up the registry for this namespace
		const regConfig = registries[componentNamespace]
		if (!regConfig) {
			throw new ConfigError(
				`Registry '${componentNamespace}' not configured. Add it to ocx.jsonc registries.`,
			)
		}

		// Fetch component from the specific registry
		let component: ComponentManifest
		try {
			component = await fetchComponent(regConfig.url, componentName)
		} catch (_err) {
			throw new OCXError(
				`Component '${componentName}' not found in registry '${componentNamespace}'.`,
				"NOT_FOUND",
			)
		}

		// Resolve dependencies first (depth-first)
		for (const dep of component.dependencies) {
			// Parse dependency: bare name = same namespace, "foo/bar" = cross-namespace
			const depRef = parseComponentRef(dep, componentNamespace)
			await resolve(depRef.namespace, depRef.component, [...path, qualifiedName])
		}

		// Normalize the component (expand Cargo-style shorthands)
		const normalizedComponent = normalizeComponentManifest(component)

		// Add to resolved (dependencies are already added)
		resolved.set(qualifiedName, {
			...normalizedComponent,
			namespace: componentNamespace,
			registryName: componentNamespace,
			baseUrl: regConfig.url,
			qualifiedName,
		})
		visiting.delete(qualifiedName)

		// Collect npm dependencies
		if (component.npmDependencies) {
			for (const dep of component.npmDependencies) {
				npmDeps.add(dep)
			}
		}
		if (component.npmDevDependencies) {
			for (const dep of component.npmDevDependencies) {
				npmDevDeps.add(dep)
			}
		}

		// Deep merge opencode config (component takes precedence - ShadCN style)
		// Use normalizedComponent to ensure MCP servers are converted from string URLs to full objects
		if (normalizedComponent.opencode) {
			opencode = mergeOpencodeConfig(
				opencode,
				normalizedComponent.opencode as NormalizedOpencodeConfig,
			)
		}
	}

	// Resolve all requested components
	for (const name of componentNames) {
		// Parse qualified component name (must include namespace)
		const ref = parseComponentRef(name)
		await resolve(ref.namespace, ref.component)
	}

	// Convert to array (already in topological order due to depth-first)
	const components = Array.from(resolved.values())
	const installOrder = Array.from(resolved.keys())

	return {
		components,
		installOrder,
		npmDependencies: Array.from(npmDeps),
		npmDevDependencies: Array.from(npmDevDeps),
		opencode,
	}
}

/**
 * Dependency Resolver with topological sort
 * Based on: https://github.com/shadcn-ui/ui/blob/main/packages/shadcn/src/registry/resolver.ts
 */

import type { RegistryConfig } from "../schemas/config"
import {
	type ComponentManifest,
	type ComponentTuiConfig,
	createQualifiedComponent,
	type NormalizedComponentManifest,
	type NormalizedOpencodeConfig,
	normalizeComponentManifest,
	type OpencodeConfig,
	parseQualifiedComponent,
} from "../schemas/registry"
import { NetworkError, NotFoundError, OCXError, ValidationError } from "../utils/errors"
import { fetchComponent } from "./fetcher"
import { dedupePluginsByCanonicalName, mergeOpencodeConfig } from "./merge"

/**
 * Parse a component reference into registry alias and component name.
 * - "kdco/researcher" -> { namespace: "kdco", component: "researcher" }
 * - "researcher" (with defaultNamespace) -> { namespace: defaultNamespace, component: "researcher" }
 * - "researcher" (without defaultNamespace) -> throws error
 *
 * Note: The `namespace` field is the user-chosen registry alias, NOT a
 * registry-declared namespace.  Component refs use `<alias>/<component>`.
 */
export function parseComponentRef(
	ref: string,
	defaultNamespace?: string,
): { namespace: string; component: string } {
	// Check if it's a qualified reference (contains /)
	if (ref.includes("/")) {
		return parseQualifiedComponent(ref)
	}

	// Bare name - use default alias if provided
	if (defaultNamespace) {
		return { namespace: defaultNamespace, component: ref }
	}

	throw new ValidationError(
		`Component '${ref}' must include a registry alias (e.g., 'kdco/${ref}')`,
	)
}

export interface ResolvedComponent extends NormalizedComponentManifest {
	/** The registry name from ocx.jsonc (configured alias) */
	registryName: string
	baseUrl: string
	/** Qualified name (registryName/component) */
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
	/** Merged TUI configuration from all components (plugin entries concatenated + deduped) */
	tui: ComponentTuiConfig
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
	const tuiPlugins: string[] = []

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

		// Look up the registry for this alias
		const regConfig = registries[componentNamespace]
		if (!regConfig) {
			throw new NotFoundError(
				`Registry alias '${componentNamespace}' not found. Add it with 'ocx registry add <url> --name ${componentNamespace}'.`,
			)
		}

		// Fetch component from the specific registry
		let component: ComponentManifest
		try {
			component = await fetchComponent(regConfig.url, componentName)
		} catch (err) {
			// Re-throw network errors as-is (preserves exit code 69)
			if (err instanceof NetworkError) {
				throw err
			}
			// Convert NotFoundError to friendly message
			if (err instanceof NotFoundError) {
				throw new NotFoundError(
					`Component '${componentName}' not found in registry '${componentNamespace}'.`,
				)
			}
			// Re-throw other OCXError subclasses as-is
			if (err instanceof OCXError) {
				throw err
			}
			// Wrap unknown errors as NetworkError (likely connectivity issue)
			throw new NetworkError(
				`Failed to fetch component '${componentName}' from registry '${componentNamespace}': ${err instanceof Error ? err.message : String(err)}`,
				{ url: regConfig.url },
			)
		}

		// Resolve dependencies first (depth-first)
		for (const dep of component.dependencies) {
			// Parse dependency: bare name = same registry alias, "foo/bar" = cross-registry
			const depRef = parseComponentRef(dep, componentNamespace)
			await resolve(depRef.namespace, depRef.component, [...path, qualifiedName])
		}

		// Normalize the component (expand Cargo-style shorthands)
		const normalizedComponent = normalizeComponentManifest(component)

		// Add to resolved (dependencies are already added)
		resolved.set(qualifiedName, {
			...normalizedComponent,
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

		// Collect TUI plugin entries (raw ./relative or npm/absolute); resolved to
		// absolute install paths later, in the install/update commands.
		if (normalizedComponent.tui?.plugin) {
			tuiPlugins.push(...normalizedComponent.tui.plugin)
		}
	}

	// Resolve all requested components
	for (const name of componentNames) {
		// Parse qualified component name (must include registry alias)
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
		// tui entries are plain strings (paths / npm names), never tuples, so the
		// deduped result is string[] — the cast just narrows the shared helper's type.
		tui: { plugin: dedupePluginsByCanonicalName(tuiPlugins) as string[] },
	}
}

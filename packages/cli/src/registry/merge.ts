/**
 * OpenCode Config Merge Utilities
 *
 * Matches OpenCode's mergeConfigWithPlugins behavior (ref: anomalyco/opencode 05355a6b):
 * - Deep merge objects using remeda's mergeDeep
 * - Special-case only `plugin` and `instructions` arrays: concatenate + dedupe
 * - All other arrays follow mergeDeep default (source replaces target)
 *
 * Plugin dedupe uses canonical name (package name without version),
 * with later/higher-priority entries winning — matching OpenCode semantics.
 */

import { mergeDeep } from "remeda"
import type { NormalizedOpencodeConfig, OpencodePluginSpec } from "../schemas/registry"

/**
 * Return the string specifier from either supported OpenCode plugin entry form.
 */
export function getPluginSpecifier(plugin: OpencodePluginSpec): string {
	return typeof plugin === "string" ? plugin : plugin[0]
}

/**
 * Extract canonical plugin name by stripping version suffix.
 *
 * Handles npm-style specifiers:
 *   "npm:@scope/pkg@1.0.0" → "npm:@scope/pkg"
 *   "npm:pkg@1.0.0"        → "npm:pkg"
 *   "@scope/pkg@1.0.0"     → "@scope/pkg"
 *   "pkg@1.0.0"            → "pkg"
 *   "pkg"                  → "pkg"
 *
 * The version delimiter is the LAST "@" that is not at position 0
 * and not immediately after "npm:" (scoped package prefix).
 */
export function extractCanonicalPluginName(plugin: OpencodePluginSpec): string {
	const specifier = getPluginSpecifier(plugin)

	// Strip npm: prefix for parsing, re-add later
	const hasNpmPrefix = specifier.startsWith("npm:")
	const remainder = hasNpmPrefix ? specifier.slice(4) : specifier

	if (!remainder) return specifier

	// Scoped package: @scope/pkg[@version]
	if (remainder.startsWith("@")) {
		const slashIndex = remainder.indexOf("/")
		if (slashIndex === -1) return specifier // malformed, return as-is

		// Find @ after the slash (version delimiter)
		const afterSlash = remainder.slice(slashIndex + 1)
		const versionAt = afterSlash.indexOf("@")
		if (versionAt === -1) return specifier // no version

		const canonicalRemainder = remainder.slice(0, slashIndex + 1 + versionAt)
		return hasNpmPrefix ? `npm:${canonicalRemainder}` : canonicalRemainder
	}

	// Unscoped package: pkg[@version]
	const atIndex = remainder.indexOf("@")
	if (atIndex === -1) return specifier // no version

	const canonicalRemainder = remainder.slice(0, atIndex)
	return hasNpmPrefix ? `npm:${canonicalRemainder}` : canonicalRemainder
}

/**
 * Deduplicate plugin entries by canonical name, last-wins.
 *
 * When two entries share the same canonical name (e.g., "npm:pkg@1.0" and "npm:pkg@2.0"),
 * the later entry wins (higher-priority source overwrites lower-priority target).
 * This matches OpenCode's mergeConfigWithPlugins semantics.
 */
export function dedupePluginsByCanonicalName(plugins: OpencodePluginSpec[]): OpencodePluginSpec[] {
	// Walk backwards: first seen (from end) wins
	const seen = new Map<string, number>()
	for (let i = plugins.length - 1; i >= 0; i--) {
		const plugin = plugins[i] as OpencodePluginSpec
		const canonical = extractCanonicalPluginName(plugin)
		if (!seen.has(canonical)) {
			seen.set(canonical, i)
		}
	}

	// Collect in original order, keeping only the last occurrence per canonical name
	const result: OpencodePluginSpec[] = []
	for (const [i, plugin] of plugins.entries()) {
		const canonical = extractCanonicalPluginName(plugin)
		if (seen.get(canonical) === i) {
			result.push(plugin)
		}
	}

	return result
}

/**
 * True when a TUI plugin entry is a filesystem path (absolute or `./`/`../`
 * relative) rather than an npm specifier. npm names never start with `/` or `.`
 * (scoped names start with `@`).
 */
function isTuiFilesystemPath(entry: string): boolean {
	return (
		entry.startsWith("/") ||
		/^[A-Za-z]:[\\/]/.test(entry) ||
		entry.startsWith("\\\\") ||
		entry.startsWith("./") ||
		entry.startsWith("../")
	)
}

/**
 * Deduplicate TUI plugin entries (for `tui.json`).
 *
 * Filesystem paths are deduped by **exact string** — canonical-name extraction
 * would truncate a path at its first `@` (e.g. a `@scope` directory), collapsing
 * distinct plugins. npm specifiers still dedupe by canonical name (version-stripped).
 * Order is preserved; the last occurrence of each key wins (matching
 * {@link dedupePluginsByCanonicalName}).
 */
export function dedupeTuiEntries(entries: string[]): string[] {
	const keyOf = (entry: string): string =>
		isTuiFilesystemPath(entry) ? entry : extractCanonicalPluginName(entry)

	const lastIndexByKey = new Map<string, number>()
	entries.forEach((entry, index) => {
		lastIndexByKey.set(keyOf(entry), index)
	})

	const result: string[] = []
	entries.forEach((entry, index) => {
		if (lastIndexByKey.get(keyOf(entry)) === index) {
			result.push(entry)
		}
	})
	return result
}

/**
 * Merge two OpenCode config objects with special array handling.
 *
 * INTERNAL UTILITY - expects pre-validated configs.
 * Validation happens at boundaries (config loading, build step), not here.
 * See: Law 2 (Parse, Don't Validate) - parse at boundary, trust inside.
 *
 * Special-cased arrays (concatenate + dedupe):
 * - `plugin`: concatenated, deduped by canonical plugin name (last wins)
 * - `instructions`: concatenated, deduped by exact string (last wins)
 *
 * All other arrays follow mergeDeep default behavior (source replaces target).
 * This matches OpenCode's internal mergeConfigWithPlugins behavior.
 *
 * @param target - Base config (accumulated so far, pre-validated)
 * @param source - New config to merge in (pre-validated)
 * @returns Merged config with concatenated special arrays
 *
 * @example
 * ```typescript
 * const merged = mergeOpencodeConfig(
 *   { plugin: ["npm:a@1.0"], mcp: { server1: {...} } },
 *   { plugin: ["npm:a@2.0", "npm:b"], agent: { agent1: {...} } }
 * )
 * // Result: { plugin: ["npm:a@2.0", "npm:b"], mcp: {...}, agent: {...} }
 * ```
 */
export function mergeOpencodeConfig(
	target: NormalizedOpencodeConfig,
	source: NormalizedOpencodeConfig,
): NormalizedOpencodeConfig {
	const merged = mergeDeep(target, source) as NormalizedOpencodeConfig

	// Special-case: Concatenate and deduplicate plugin arrays by canonical name
	if (Array.isArray(target.plugin) && Array.isArray(source.plugin)) {
		merged.plugin = dedupePluginsByCanonicalName([...target.plugin, ...source.plugin])
	} else if (Array.isArray(target.plugin)) {
		merged.plugin = target.plugin
	} else if (Array.isArray(source.plugin)) {
		merged.plugin = source.plugin
	}

	// Special-case: Concatenate and deduplicate instructions arrays (exact string match)
	if (Array.isArray(target.instructions) && Array.isArray(source.instructions)) {
		merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))
	} else if (Array.isArray(target.instructions)) {
		merged.instructions = target.instructions
	} else if (Array.isArray(source.instructions)) {
		merged.instructions = source.instructions
	}

	return merged
}

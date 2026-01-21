/**
 * OpenCode Config Merge Utilities
 *
 * Matches OpenCode's mergeConfigWithPlugins behavior:
 * - Deep merge objects using remeda's mergeDeep
 * - Concatenate and deduplicate plugin and instructions arrays
 */

import { mergeDeep } from "remeda"
import type { NormalizedOpencodeConfig } from "../schemas/registry"

/**
 * Merge two OpenCode config objects with special array handling.
 *
 * Unlike plain mergeDeep which replaces arrays entirely, this function:
 * - Concatenates `plugin` arrays from both configs
 * - Concatenates `instructions` arrays from both configs
 * - Deduplicates entries in both arrays
 *
 * This matches OpenCode's internal mergeConfigWithPlugins behavior.
 *
 * @param target - Base config (accumulated so far)
 * @param source - New config to merge in
 * @returns Merged config with concatenated arrays
 */
export function mergeOpencodeConfig(
	target: NormalizedOpencodeConfig,
	source: NormalizedOpencodeConfig,
): NormalizedOpencodeConfig {
	const merged = mergeDeep(target, source) as NormalizedOpencodeConfig

	// Concatenate and deduplicate plugin arrays (matching OpenCode behavior)
	if (target.plugin && source.plugin) {
		merged.plugin = Array.from(new Set([...target.plugin, ...source.plugin]))
	}

	// Concatenate and deduplicate instructions arrays (matching OpenCode behavior)
	if (target.instructions && source.instructions) {
		merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))
	}

	return merged
}

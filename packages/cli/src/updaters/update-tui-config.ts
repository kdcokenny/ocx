/**
 * OpenCode TUI Config Updater
 *
 * Mirrors the opencode.jsonc updater, but targets opencode's separate TUI config
 * file (`~/.config/opencode/tui.json`) instead of `opencode.jsonc`.
 *
 * Key differences from the opencode.jsonc updater:
 * - Always the single global file (never a project-local `.opencode/` copy).
 * - The `plugin[]` array is merged/deduped against existing entries (unrelated
 *   third-party entries are preserved), not replaced wholesale.
 * - A reconcile-by-delta primitive (`applyTuiConfigDelta`) serves both install
 *   (add only) and update (add + drop the entries a component no longer declares).
 * - Comments are preserved via jsonc-parser's modify/applyEdits.
 *
 * Absolute-path note: `tui.json` requires absolute plugin paths. Component `tui`
 * entries that are `./relative` are resolved to the absolute install path of the
 * shipped file (npm names and already-absolute paths pass through unchanged).
 */

import { mkdir } from "node:fs/promises"
import path from "node:path"
import { applyEdits, type ModificationOptions, modify, parse as parseJsonc } from "jsonc-parser"
import { getGlobalOpencodeRoot, resolveOpencodePathScope, TUI_CONFIG_FILE } from "../profile/paths"
import { dedupeTuiEntries } from "../registry/merge"
import { ValidationError } from "../utils/errors"
import { resolveTargetPath } from "../utils/paths"

// =============================================================================
// TYPES
// =============================================================================

/** The structure of the tui.json file. */
export interface TuiJsonConfig {
	$schema?: string
	plugin?: string[]
	[key: string]: unknown
}

export interface UpdateTuiConfigResult {
	/** Path to the tui.json file */
	path: string
	/** Whether the file was created (vs updated) */
	created: boolean
	/** Whether any changes were made */
	changed: boolean
}

// =============================================================================
// CONSTANTS
// =============================================================================

const JSONC_OPTIONS: ModificationOptions = {
	formattingOptions: {
		tabSize: 2,
		insertSpaces: false,
		eol: "\n",
	},
}

// Minimal template for a new tui.json file.
const TUI_CONFIG_TEMPLATE = `{
	"$schema": "https://opencode.ai/tui.json"
}
`

// =============================================================================
// PATH RESOLUTION
// =============================================================================

/**
 * Absolute path to the global TUI config file (`~/.config/opencode/tui.json`).
 * Respects XDG_CONFIG_HOME via getGlobalOpencodeRoot.
 */
export function getGlobalTuiConfigPath(): string {
	return path.join(getGlobalOpencodeRoot(), TUI_CONFIG_FILE)
}

/**
 * Whether an install root uses opencode's flattened (global/profile) layout.
 * Matches add.ts's `isFlattened = !!(options.global || options.profile)`, but is
 * derived from the install root so `add` and `update` reconstruct identical paths.
 */
function tuiIsFlattened(installRoot: string): boolean {
	return resolveOpencodePathScope(path.resolve(installRoot)) !== "local-project"
}

/**
 * Resolve a single component `tui.plugin` entry to an absolute path.
 * - npm name / already-absolute path → returned unchanged.
 * - `./relative` path → resolved to the absolute install path of the shipped file,
 *   using the same target resolution ocx uses to place the file on disk.
 *
 * `../` parent-traversal entries are rejected — ocx can never ship a matching
 * traversal file target, and (in flattened installs) such a path would otherwise
 * escape the install root. Embedded `..` that escapes the root is rejected too.
 */
function resolveTuiPluginEntry(entry: string, installRoot: string): string {
	if (entry.startsWith("../")) {
		throw new ValidationError(
			`Invalid tui plugin entry "${entry}": parent traversal ("../") is not allowed.`,
		)
	}
	// npm name or already-absolute path → use as-is.
	if (!entry.startsWith("./")) {
		return entry
	}

	const root = path.resolve(installRoot)
	const target = entry.slice(2)
	const resolved = path.join(root, resolveTargetPath(target, tuiIsFlattened(root), root))

	// Defense in depth: reject entries whose resolved path escapes the install root
	// (e.g. embedded "..") — resolveTargetPath validates this for local installs, but
	// not for flattened (global/profile) installs.
	if (resolved !== root && !resolved.startsWith(root + path.sep)) {
		throw new ValidationError(
			`Invalid tui plugin entry "${entry}": resolves outside the install root.`,
		)
	}
	return resolved
}

/**
 * Resolve a list of component `tui.plugin` entries to absolute paths.
 */
export function resolveTuiPluginEntries(entries: string[], installRoot: string): string[] {
	return entries.map((entry) => resolveTuiPluginEntry(entry, installRoot))
}

// =============================================================================
// FILE OPERATIONS
// =============================================================================

/**
 * Read the global tui.json (parsed + raw content for comment preservation).
 * Returns null if it does not exist.
 */
export async function readTuiConfig(): Promise<{
	config: TuiJsonConfig
	content: string
	path: string
} | null> {
	const configPath = getGlobalTuiConfigPath()
	const file = Bun.file(configPath)
	if (!(await file.exists())) {
		return null
	}
	const content = await file.text()
	return {
		config: parseJsonc(content, [], { allowTrailingComma: true }) as TuiJsonConfig,
		content,
		path: configPath,
	}
}

// =============================================================================
// MAIN UPDATER
// =============================================================================

/**
 * Reconcile the global tui.json `plugin[]` array by delta.
 *
 * - `removeAbsolute`: absolute entries this component previously contributed and
 *   no longer declares (dropped, unless also present in `addAbsolute`).
 * - `addAbsolute`: absolute entries this component now declares (added + deduped).
 *
 * Unrelated third-party entries (never in `removeAbsolute`) are preserved. Comments
 * and other keys survive via jsonc-parser edits. The file is created from a minimal
 * template when absent.
 *
 * Install = call with `removeAbsolute: []`. Update = call with old + new sets.
 */
export async function applyTuiConfigDelta(
	removeAbsolute: string[],
	addAbsolute: string[],
): Promise<UpdateTuiConfigResult> {
	const existing = await readTuiConfig()

	let content: string
	const configPath = getGlobalTuiConfigPath()
	const created = !existing

	let currentPlugins: string[] = []
	if (existing) {
		content = existing.content
		currentPlugins = Array.isArray(existing.config.plugin)
			? existing.config.plugin.filter((p): p is string => typeof p === "string")
			: []
	} else {
		content = TUI_CONFIG_TEMPLATE
		await mkdir(path.dirname(configPath), { recursive: true })
	}

	const removeSet = new Set(removeAbsolute)
	const addSet = new Set(addAbsolute)
	// Keep entries unless this component owned them and no longer declares them.
	const base = currentPlugins.filter((entry) => !removeSet.has(entry) || addSet.has(entry))
	// Dedupe paths by exact string, npm names by canonical name (see dedupeTuiEntries).
	const finalPlugins = dedupeTuiEntries([...base, ...addAbsolute])

	const originalContent = content
	const edits = modify(content, ["plugin"], finalPlugins, JSONC_OPTIONS)
	content = applyEdits(content, edits)

	const changed = content !== originalContent
	if (changed) {
		await Bun.write(configPath, content)
	}

	return {
		path: configPath,
		created: created && changed,
		changed,
	}
}

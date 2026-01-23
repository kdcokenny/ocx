/**
 * Shared CLI Options Factory
 *
 * Reusable option definitions for consistent command interfaces.
 * Use these factories instead of defining options inline to ensure
 * consistency across commands.
 */

import { Option } from "commander"
import { InvalidProfileNameError } from "./errors"

// =============================================================================
// OPTION FACTORIES
// =============================================================================

/**
 * Shared CLI option factories for consistent command interfaces.
 * Use these instead of defining options inline to ensure consistency.
 */
export const sharedOptions = {
	/** Working directory option */
	cwd: () => new Option("--cwd <path>", "Working directory").default(process.cwd()),

	/** Suppress non-essential output */
	quiet: () => new Option("-q, --quiet", "Suppress output"),

	/** Output as JSON */
	json: () => new Option("--json", "Output as JSON"),

	/** Target a specific profile's config */
	profile: () => new Option("-p, --profile <name>", "Target a specific profile's config"),

	/** Skip confirmation prompts */
	force: () => new Option("-f, --force", "Skip confirmation prompts"),

	/** Verbose output */
	verbose: () => new Option("-v, --verbose", "Verbose output"),

	/** Install to global OpenCode config */
	global: new Option("-g, --global", "Install to global OpenCode config (~/.config/opencode)"),
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Add common options (cwd, quiet, json) to a command.
 *
 * @example
 * ```typescript
 * const cmd = program.command("my-command")
 * addCommonOptions(cmd)
 *   .option("--custom", "Custom option")
 *   .action(handler)
 * ```
 */
export function addCommonOptions<T extends { addOption: (opt: Option) => T }>(cmd: T): T {
	return cmd
		.addOption(sharedOptions.cwd())
		.addOption(sharedOptions.quiet())
		.addOption(sharedOptions.json())
}

/**
 * Add force option to a command for skipping confirmation prompts.
 *
 * @example
 * ```typescript
 * const cmd = program.command("destructive")
 * addForceOption(cmd)
 *   .action(handler)
 * ```
 */
export function addForceOption<T extends { addOption: (opt: Option) => T }>(cmd: T): T {
	return cmd.addOption(sharedOptions.force())
}

/**
 * Add verbose option to a command.
 *
 * @example
 * ```typescript
 * const cmd = program.command("debug")
 * addVerboseOption(cmd)
 *   .action(handler)
 * ```
 */
export function addVerboseOption<T extends { addOption: (opt: Option) => T }>(cmd: T): T {
	return cmd.addOption(sharedOptions.verbose())
}

/**
 * Add output options (json, quiet) to a command.
 * Use this for commands that don't need --cwd (like profile commands).
 *
 * @example
 * ```typescript
 * const cmd = program.command("init")
 * addOutputOptions(cmd)
 *   .action(handler)
 * ```
 */
export function addOutputOptions<T extends { addOption: (opt: Option) => T }>(cmd: T): T {
	return cmd.addOption(sharedOptions.json()).addOption(sharedOptions.quiet())
}

/**
 * Adds the --global option to a command.
 */
export function addGlobalOption<T extends { addOption: (opt: Option) => T }>(cmd: T): T {
	return cmd.addOption(sharedOptions.global)
}

/**
 * Adds the --profile option to a command.
 */
export function addProfileOption<T extends { addOption: (opt: Option) => T }>(cmd: T): T {
	return cmd.addOption(sharedOptions.profile())
}

// =============================================================================
// VALIDATION HELPERS
// =============================================================================

/**
 * Validates a profile name and throws if invalid.
 * Profile names must:
 * - Be non-empty
 * - Be 32 characters or less
 * - Start with a letter
 * - Contain only letters, numbers, dots, underscores, or hyphens
 *
 * @throws InvalidProfileNameError if validation fails
 */
export function validateProfileName(name: string): void {
	if (!name || name.length === 0) {
		throw new InvalidProfileNameError(name, "cannot be empty")
	}
	if (name.length > 32) {
		throw new InvalidProfileNameError(name, "must be 32 characters or less")
	}
	if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(name)) {
		throw new InvalidProfileNameError(
			name,
			"must start with a letter and contain only alphanumeric characters, dots, underscores, or hyphens",
		)
	}
}

/**
 * Shared CLI Options Factory
 *
 * Reusable option definitions for consistent command interfaces.
 * Use these factories instead of defining options inline to ensure
 * consistency across commands.
 */

import { Option } from "commander"
import { buildRegistryAuthConfig, type CliAuth } from "../registry/auth"
import { InvalidProfileNameError, ValidationError } from "./errors"
import { logger } from "./logger"

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
// REGISTRY CREDENTIAL OPTIONS (shared by `registry add` and `add --from`)
// =============================================================================

/**
 * Credential flags for authenticating to a registry — the same vocabulary whether the credential is
 * persisted (`registry add`) or applied to a one-off ephemeral registry (`add --from`). Bearer and
 * Basic each expose the secret as a literal, an env var, or a file; env/file references are only
 * honored in trusted scopes (enforced at resolution time, see registry/auth.ts).
 */
const credentialOptions = {
	token: () => new Option("--token <token>", "Bearer token (literal)"),
	tokenEnv: () => new Option("--token-env <name>", "Bearer token from an env var"),
	tokenFile: () => new Option("--token-file <path>", "Bearer token from a file"),
	username: () => new Option("--username <user>", "HTTP Basic username"),
	password: () => new Option("--password <pass>", "HTTP Basic password (literal)"),
	passwordEnv: () => new Option("--password-env <name>", "HTTP Basic password from an env var"),
	passwordFile: () => new Option("--password-file <path>", "HTTP Basic password from a file"),
}

function addCredentialOptions<T extends { addOption: (opt: Option) => T }>(cmd: T): T {
	return cmd
		.addOption(credentialOptions.token())
		.addOption(credentialOptions.tokenEnv())
		.addOption(credentialOptions.tokenFile())
		.addOption(credentialOptions.username())
		.addOption(credentialOptions.password())
		.addOption(credentialOptions.passwordEnv())
		.addOption(credentialOptions.passwordFile())
}

/** Add the persisted-credential options to `registry add`. */
export function addRegistryAuthOptions<T extends { addOption: (opt: Option) => T }>(cmd: T): T {
	return addCredentialOptions(cmd)
}

/** Add the credential options (plus a raw `--auth-header` escape hatch) for a `--from` registry. */
export function addAuthOptions<T extends { addOption: (opt: Option) => T }>(cmd: T): T {
	return addCredentialOptions(cmd).addOption(
		new Option("--auth-header <header>", 'Extra "Name: Value" header for the --from registry')
			.argParser((value: string, previous: string[] = []) => [...previous, value])
			.default([] as string[]),
	)
}

/**
 * Run-level `--insecure-skip-tls-verify` for any command that fetches from a registry. When set,
 * TLS certificate verification is skipped for every registry request that command makes.
 */
export function addInsecureTlsOption<T extends { addOption: (opt: Option) => T }>(cmd: T): T {
	return cmd.addOption(
		new Option(
			"--insecure-skip-tls-verify",
			"Skip TLS certificate verification for registry requests",
		),
	)
}

/** Parsed shape of the auth options (as Commander camelCases them). */
export interface CliAuthOptions {
	token?: string
	tokenEnv?: string
	tokenFile?: string
	username?: string
	password?: string
	passwordEnv?: string
	passwordFile?: string
	authHeader?: string[]
	insecureSkipTlsVerify?: boolean
	/** The `--from` URL, if any — auth flags require it. */
	from?: string
}

function parseAuthHeaders(raw?: string[]): Record<string, string> | undefined {
	if (!raw || raw.length === 0) return undefined
	const headers: Record<string, string> = {}
	for (const entry of raw) {
		const idx = entry.indexOf(":")
		if (idx === -1) {
			throw new ValidationError(`Invalid --auth-header "${entry}". Expected "Name: Value".`)
		}
		const name = entry.slice(0, idx).trim()
		const value = entry.slice(idx + 1).trim()
		if (!name) {
			throw new ValidationError(`Invalid --auth-header "${entry}": header name is empty.`)
		}
		headers[name] = value
	}
	return headers
}

/**
 * Convert parsed CLI auth options into a {@link CliAuth}, or undefined when no auth flag was given.
 * Reuses the shared credential parser; enforces that auth flags require `--from`; warns on a literal
 * `--token`/`--password` (argv/history exposure).
 */
export function resolveCliAuth(options: CliAuthOptions): CliAuth | undefined {
	const auth = buildRegistryAuthConfig(options)
	const headers = parseAuthHeaders(options.authHeader)

	if (auth === undefined && headers === undefined) {
		return undefined
	}

	if (!options.from) {
		throw new ValidationError(
			"Authentication flags (--token(-env|-file), --username, --password(-env|-file), " +
				"--auth-header) require --from <url>. For configured registries, use the registry's " +
				"`auth` block in ocx.jsonc or OCX_REGISTRY_<ALIAS>_TOKEN.",
		)
	}

	if (options.token !== undefined || options.password !== undefined) {
		logger.warn(
			"Passing a literal --token/--password exposes it in your shell history and process list. " +
				"Prefer the --*-env or --*-file variants.",
		)
	}

	const cli: CliAuth = {}
	if (auth) cli.auth = auth
	if (headers) cli.headers = headers
	return cli
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

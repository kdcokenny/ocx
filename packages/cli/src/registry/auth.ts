/**
 * Per-registry authentication resolution.
 *
 * Turns a registry's config (+ optional CLI flags for a `--from` registry) into the specific 
 * request auth (headers + TLS policy) used by the fetcher. Credential precedence, per registry,
 * for the `Authorization` header (first wins):
 *
 *   1. CLI flags        (only present for a one-off `--from <url>` registry)
 *   2. Per-registry env  `OCX_REGISTRY_<ALIAS>_TOKEN` | `_BASIC` | `_TOKEN_FILE`
 *   3. Config `auth`     block (literal always; env/file refs only in trusted scopes)
 *   4. Config `headers`  raw `Authorization` (with `${ENV}` expansion, trusted scopes only)
 *
 * Literal credentials are honored in ANY config scope, but any dynamic
 * credentials are only available in global configurations, to avoid credential
 * stealing via untrusted repositories.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
	AUTH_REF_FIELDS,
	type RegistryAuthConfig,
	type RegistryConfig,
	registryAuthConfigSchema,
} from "../schemas/config"
import { ConfigError, ValidationError } from "../utils/errors"

/**
 * Origin of a registry's configuration. Determines whether env/file references may be resolved.
 * - `local`     → committed `.opencode/ocx.jsonc` (untrusted; literal-only)
 * - `global`    → `~/.config/opencode/ocx.jsonc` (user-owned; trusted)
 * - `profile`   → a global profile's ocx.jsonc (user-owned; trusted)
 * - `ephemeral` → a `--from <url>` registry (CLI-invoked; trusted, auth comes from CLI flags)
 */
export type RegistryScope = "local" | "global" | "profile" | "ephemeral"

/** Concrete auth applied to a single registry request. */
export interface RequestAuth {
	/** Headers to attach to the request (may include `Authorization`). */
	headers?: Record<string, string>
	/** When `false`, TLS certificate verification is skipped for this request. */
	rejectUnauthorized?: boolean
}

/** CLI-provided auth for a single `--from` ephemeral registry (applied at highest precedence). */
export interface CliAuth {
	/** Structured credential built from the CLI flags (same shape as a config `auth` block). */
	auth?: RegistryAuthConfig
	/** Raw headers (`--auth-header "Name: Value"`, repeatable). */
	headers?: Record<string, string>
}

/** The credential flags shared by `registry add` (persisted) and `add --from` (ephemeral). */
export interface CredentialFlags {
	token?: string
	tokenEnv?: string
	tokenFile?: string
	username?: string
	password?: string
	passwordEnv?: string
	passwordFile?: string
}

const ENV_REF = /\$\{([^}]+)\}/g

function isTrustedScope(scope: RegistryScope): boolean {
	return scope !== "local"
}

/** True if the string contains a `${VAR}` reference. */
function hasEnvRef(value: string): boolean {
	return /\$\{[^}]+\}/.test(value)
}

/** Replace every `${VAR}` with its env value; fail fast if any referenced var is unset. */
function expandEnvRefs(value: string): string {
	return value.replace(ENV_REF, (_match, name: string) => {
		const resolved = process.env[name]
		if (resolved === undefined) {
			throw new ConfigError(
				`Environment variable "${name}" referenced in registry config is not set.`,
			)
		}
		return resolved
	})
}

function requireEnv(name: string): string {
	const value = process.env[name]
	if (value === undefined || value === "") {
		throw new ConfigError(
			`Environment variable "${name}" (referenced in registry auth) is not set.`,
		)
	}
	return value
}

function expandTilde(filePath: string): string {
	if (filePath === "~") return homedir()
	if (filePath.startsWith("~/")) return join(homedir(), filePath.slice(2))
	return filePath
}

/** Read a credential from a file, trimming trailing whitespace/newline. */
function readSecretFile(filePath: string): string {
	try {
		const contents = readFileSync(expandTilde(filePath), "utf8").trim()
		if (!contents) {
			throw new ConfigError(`Credential file "${filePath}" is empty.`)
		}
		return contents
	} catch (error) {
		if (error instanceof ConfigError) throw error
		const reason = error instanceof Error ? error.message : String(error)
		throw new ConfigError(`Failed to read credential file "${filePath}": ${reason}`)
	}
}

function bearerHeader(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}` }
}

function basicHeader(userpass: string): Record<string, string> {
	return { Authorization: `Basic ${Buffer.from(userpass).toString("base64")}` }
}

/**
 * Normalize a registry alias into the env-var segment used for per-registry overrides.
 */
export function normalizeAliasEnv(alias: string): string {
	return alias.toUpperCase().replace(/[^A-Z0-9]/g, "_")
}

/**
 * Guard: a committed local config must not carry env/file credential references,
 * `${ENV}` expansion, or TLS-skip. Literal credentials are allowed.
 */
function assertLocalScopeSafe(alias: string, regConfig: RegistryConfig): void {
	const problems: string[] = []

	const auth = regConfig.auth
	if (auth) {
		for (const field of AUTH_REF_FIELDS) {
			if (auth[field] !== undefined) problems.push(`auth.${field}`)
		}
	}

	if (regConfig.headers) {
		for (const [name, value] of Object.entries(regConfig.headers)) {
			if (hasEnvRef(value)) problems.push(`headers.${name} (\${…} reference)`)
		}
	}

	// A committed local config controls the alias, which selects OCX_REGISTRY_<ALIAS>_* env vars.
	// If one is set, refuse rather than silently sending the victim's secret to this registry's URL.
	const envKey = normalizeAliasEnv(alias)
	for (const suffix of ["TOKEN", "TOKEN_FILE", "BASIC"] as const) {
		if (process.env[`OCX_REGISTRY_${envKey}_${suffix}`]) {
			problems.push(`the OCX_REGISTRY_${envKey}_${suffix} environment override`)
		}
	}

	if (problems.length > 0) {
		throw new ConfigError(
			`Registry '${alias}' is defined in committed local config (.opencode/ocx.jsonc) but uses ` +
				`${problems.join(", ")}. For security, environment/file credential references, ` +
				`\${ENV} expansion are only honored in global or profile config. ` +
				`Use a literal value here, or move this registry to your global (~/.config/opencode) ` +
				`or profile config.`,
		)
	}
}

/** Resolve a credential from its three possible sources by precedence */
function pickSecret(
	literal: string | undefined,
	envVar: string | undefined,
	file: string | undefined,
	trusted: boolean,
): string | undefined {
	if (literal !== undefined) return literal
	if (trusted && envVar) return requireEnv(envVar)
	if (trusted && file) return readSecretFile(file)
	return undefined
}

/** Build an `Authorization` header from a config `auth` block, or null if no credential resolves. */
function authFromConfig(auth: RegistryAuthConfig, trusted: boolean): Record<string, string> | null {
	if (auth.type === "bearer") {
		const token = pickSecret(auth.token, auth.tokenEnv, auth.tokenFile, trusted)
		return token === undefined ? null : bearerHeader(token)
	}

	const password = pickSecret(auth.password, auth.passwordEnv, auth.passwordFile, trusted)
	return password === undefined ? null : basicHeader(`${auth.username ?? ""}:${password}`)
}

/** Per-registry env override (`OCX_REGISTRY_<ALIAS>_*`), or null if none set. */
function authFromEnvOverride(alias: string): Record<string, string> | null {
	const key = normalizeAliasEnv(alias)

	const token = process.env[`OCX_REGISTRY_${key}_TOKEN`]
	if (token) return bearerHeader(token)

	const tokenFile = process.env[`OCX_REGISTRY_${key}_TOKEN_FILE`]
	if (tokenFile) return bearerHeader(readSecretFile(tokenFile))

	const basic = process.env[`OCX_REGISTRY_${key}_BASIC`]
	if (basic) return basicHeader(basic)

	return null
}

/** Build headers from CLI flags (a `--from` ephemeral registry). CLI credentials are always trusted. */
function authFromCli(cli: CliAuth): Record<string, string> {
	const headers: Record<string, string> = { ...(cli.headers ?? {}) }
	if (cli.auth) {
		const authHeader = authFromConfig(cli.auth, true)
		if (authHeader) Object.assign(headers, authHeader)
	}
	return headers
}

/**
 * Build a {@link RegistryAuthConfig} from credential flags — shared by `registry add` (persisted)
 * and the `add --from` CLI path. Enforces one scheme (bearer XOR basic); the schema enforces
 * "exactly one source" per credential. Returns undefined when no credential flag was given.
 */
export function buildRegistryAuthConfig(flags: CredentialFlags): RegistryAuthConfig | undefined {
	const bearerFlags = [
		flags.token !== undefined ? "--token" : null,
		flags.tokenEnv ? "--token-env" : null,
		flags.tokenFile ? "--token-file" : null,
	].filter((v): v is string => v !== null)

	const basicFlags = [
		flags.username ? "--username" : null,
		flags.password !== undefined ? "--password" : null,
		flags.passwordEnv ? "--password-env" : null,
		flags.passwordFile ? "--password-file" : null,
	].filter((v): v is string => v !== null)

	if (bearerFlags.length === 0 && basicFlags.length === 0) return undefined

	if (bearerFlags.length > 0 && basicFlags.length > 0) {
		throw new ValidationError(
			`Cannot combine Bearer (${bearerFlags.join(", ")}) and Basic (${basicFlags.join(", ")}) auth flags.`,
		)
	}

	let candidate: Record<string, unknown>
	if (bearerFlags.length > 0) {
		candidate = { type: "bearer" }
		if (flags.token !== undefined) candidate.token = flags.token
		if (flags.tokenEnv) candidate.tokenEnv = flags.tokenEnv
		if (flags.tokenFile) candidate.tokenFile = flags.tokenFile
	} else {
		candidate = { type: "basic" }
		if (flags.username) candidate.username = flags.username
		if (flags.password !== undefined) candidate.password = flags.password
		if (flags.passwordEnv) candidate.passwordEnv = flags.passwordEnv
		if (flags.passwordFile) candidate.passwordFile = flags.passwordFile
	}

	const parsed = registryAuthConfigSchema.safeParse(candidate)
	if (!parsed.success) {
		const issue = parsed.error.issues[0]
		throw new ValidationError(`Invalid auth options: ${issue?.message ?? parsed.error.message}`)
	}
	return parsed.data
}

/**
 * Resolve the request auth for a single registry.
 *
 * @param alias     Configured registry alias (used for env-override lookup).
 * @param regConfig The registry's config entry.
 * @param scope     Where the config came from (gates env/file expansion).
 * @param cliAuth   CLI flags — only for a `--from` ephemeral registry.
 */
export function resolveRegistryAuth(
	alias: string,
	regConfig: RegistryConfig,
	scope: RegistryScope,
	cliAuth?: CliAuth,
): RequestAuth {
	const trusted = isTrustedScope(scope)

	if (scope === "local") {
		assertLocalScopeSafe(alias, regConfig)
	}

	// Applied lowest-precedence first so higher-precedence sources overwrite `Authorization`.
	const headers: Record<string, string> = {}

	// (4) Raw headers — `${ENV}` expanded only in trusted scopes (local guard forbids refs there).
	if (regConfig.headers) {
		for (const [name, value] of Object.entries(regConfig.headers)) {
			headers[name] = trusted ? expandEnvRefs(value) : value
		}
	}

	// (3) Config `auth` block.
	if (regConfig.auth) {
		const configAuth = authFromConfig(regConfig.auth, trusted)
		if (configAuth) Object.assign(headers, configAuth)
	}

	// (2) Per-registry env override — trusted scopes only. In an untrusted committed local config
	// the alias is attacker-controlled, so honoring OCX_REGISTRY_<ALIAS>_* here would let a cloned
	// repo point a victim's env secret at an attacker URL (assertLocalScopeSafe already rejects this).
	const envAuth = trusted ? authFromEnvOverride(alias) : null
	if (envAuth) Object.assign(headers, envAuth)

	// (1) CLI credential flags (ephemeral `--from` registry).
	if (cliAuth) {
		Object.assign(headers, authFromCli(cliAuth))
	}

	// Per-registry TLS-skip from config, honored in any scope (not a secret; the config author
	// already owns the URL). The run-level `--insecure-skip-tls-verify` flag is applied separately
	// (see createAuthResolver).
	let rejectUnauthorized: boolean | undefined
	if (regConfig.insecure) {
		rejectUnauthorized = false
	}

	const result: RequestAuth = {}
	if (Object.keys(headers).length > 0) result.headers = headers
	if (rejectUnauthorized !== undefined) result.rejectUnauthorized = rejectUnauthorized
	return result
}

/**
 * Lazily resolves (and memoizes) the auth for a registry alias.
 * Returns undefined for public registries or unknown aliases.
 */
export type AuthResolver = (alias: string) => RequestAuth | undefined

/**
 * Build a memoized {@link AuthResolver} over a set of registries at a given scope.
 *
 * Resolution is lazy: a registry's credentials (and any env/file lookups that can throw) are only
 * evaluated when that alias is actually fetched — so an unrelated registry with an unset token env
 * never breaks an unrelated install.
 *
 * @param opts.ephemeral When set, this alias is treated as a `--from` registry: resolved with scope
 *                       `ephemeral` and the provided CLI flags instead of the shared `scope`.
 *
 * Note: run-level `--insecure-skip-tls-verify` is NOT handled here — it is a process-global toggle
 * applied in the fetcher (see `setInsecureTls`). Per-registry `insecure: true` still flows through
 * `resolveRegistryAuth`.
 */
export function createAuthResolver(
	registries: Record<string, RegistryConfig>,
	scope: RegistryScope,
	opts?: { ephemeral?: { alias: string; cliAuth?: CliAuth } },
): AuthResolver {
	const memo = new Map<string, RequestAuth | undefined>()

	return (alias: string) => {
		if (memo.has(alias)) return memo.get(alias)

		const regConfig = registries[alias]
		let auth: RequestAuth | undefined
		if (regConfig) {
			const isEphemeral = opts?.ephemeral?.alias === alias
			auth = resolveRegistryAuth(
				alias,
				regConfig,
				isEphemeral ? "ephemeral" : scope,
				isEphemeral ? opts?.ephemeral?.cliAuth : undefined,
			)
		}

		memo.set(alias, auth)
		return auth
	}
}

/**
 * Tests for per-registry authentication resolution and fetcher threading.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	type CliAuth,
	createAuthResolver,
	normalizeAliasEnv,
	resolveRegistryAuth,
} from "../src/registry/auth"
import {
	_clearFetcherCacheForTests,
	fetchRegistryIndex,
	setInsecureTls,
} from "../src/registry/fetcher"
import type { RegistryConfig } from "../src/schemas/config"

const b64 = (value: string) => Buffer.from(value).toString("base64")

// Snapshot/restore only the env keys a test touches.
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
	const previous: Record<string, string | undefined> = {}
	for (const key of Object.keys(vars)) previous[key] = process.env[key]
	try {
		for (const [key, value] of Object.entries(vars)) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
		fn()
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
	}
}

describe("resolveRegistryAuth — bearer", () => {
	it("uses a literal token in any scope", () => {
		const cfg: RegistryConfig = { url: "https://r", auth: { type: "bearer", token: "abc" } }
		expect(resolveRegistryAuth("r", cfg, "local").headers).toEqual({ Authorization: "Bearer abc" })
		expect(resolveRegistryAuth("r", cfg, "global").headers).toEqual({ Authorization: "Bearer abc" })
	})

	it("resolves tokenEnv in a trusted scope", () => {
		const cfg: RegistryConfig = { url: "https://r", auth: { type: "bearer", tokenEnv: "MY_TOK" } }
		withEnv({ MY_TOK: "secret" }, () => {
			expect(resolveRegistryAuth("r", cfg, "global").headers).toEqual({
				Authorization: "Bearer secret",
			})
		})
	})

	it("throws when tokenEnv is unset", () => {
		const cfg: RegistryConfig = {
			url: "https://r",
			auth: { type: "bearer", tokenEnv: "MISSING_TOK" },
		}
		withEnv({ MISSING_TOK: undefined }, () => {
			expect(() => resolveRegistryAuth("r", cfg, "global")).toThrow(/MISSING_TOK/)
		})
	})

	it("reads tokenFile and trims trailing newline", () => {
		const dir = mkdtempSync(join(tmpdir(), "ocx-auth-"))
		try {
			const file = join(dir, "token")
			writeFileSync(file, "file-token\n")
			const cfg: RegistryConfig = { url: "https://r", auth: { type: "bearer", tokenFile: file } }
			expect(resolveRegistryAuth("r", cfg, "profile").headers).toEqual({
				Authorization: "Bearer file-token",
			})
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})

describe("resolveRegistryAuth — basic", () => {
	it("encodes literal user:pass as base64", () => {
		const cfg: RegistryConfig = {
			url: "https://r",
			auth: { type: "basic", username: "ci", password: "pw" },
		}
		expect(resolveRegistryAuth("r", cfg, "local").headers).toEqual({
			Authorization: `Basic ${b64("ci:pw")}`,
		})
	})

	it("resolves passwordEnv in a trusted scope", () => {
		const cfg: RegistryConfig = {
			url: "https://r",
			auth: { type: "basic", username: "ci", passwordEnv: "MY_PW" },
		}
		withEnv({ MY_PW: "s3cret" }, () => {
			expect(resolveRegistryAuth("r", cfg, "global").headers).toEqual({
				Authorization: `Basic ${b64("ci:s3cret")}`,
			})
		})
	})
})

describe("resolveRegistryAuth — local-scope security guard", () => {
	it("rejects env/file references in committed local config", () => {
		const cfg: RegistryConfig = { url: "https://r", auth: { type: "bearer", tokenEnv: "X" } }
		expect(() => resolveRegistryAuth("r", cfg, "local")).toThrow(/committed local config/)
	})

	it("rejects env-var expansion in local headers", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: intentionally a literal ${ENV} reference
		const cfg: RegistryConfig = { url: "https://r", headers: { Authorization: "Bearer ${X}" } }
		expect(() => resolveRegistryAuth("r", cfg, "local")).toThrow(/committed local config/)
	})

	it("rejects an OCX_REGISTRY_<ALIAS>_* env override for a local-config alias (exfil guard)", () => {
		// A cloned/malicious repo controls the alias + URL; it must not be able to send the
		// victim's env-var secret to its own registry URL.
		const cfg: RegistryConfig = { url: "https://attacker.example" }
		withEnv({ OCX_REGISTRY_R_TOKEN: "victim-secret" }, () => {
			expect(() => resolveRegistryAuth("r", cfg, "local")).toThrow(/OCX_REGISTRY_R_TOKEN/)
		})
	})

	it("does not attach an env override in local scope (no leak) when it does not error", () => {
		// Sanity: with no env override set, a bare local registry resolves to no auth at all.
		const cfg: RegistryConfig = { url: "https://attacker.example" }
		withEnv({ OCX_REGISTRY_R_TOKEN: undefined }, () => {
			expect(resolveRegistryAuth("r", cfg, "local").headers).toBeUndefined()
		})
	})

	it("allows literal credentials and literal headers in local config", () => {
		const cfg: RegistryConfig = {
			url: "https://r",
			auth: { type: "bearer", token: "abc" },
			headers: { "X-Extra": "value" },
		}
		const auth = resolveRegistryAuth("r", cfg, "local")
		expect(auth.headers).toEqual({ "X-Extra": "value", Authorization: "Bearer abc" })
	})
})

describe("resolveRegistryAuth — headers & env expansion", () => {
	it("expands env references in headers in trusted scopes", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: intentionally a literal ${ENV} reference
		const cfg: RegistryConfig = { url: "https://r", headers: { "X-Api-Key": "${API_KEY}" } }
		withEnv({ API_KEY: "k123" }, () => {
			expect(resolveRegistryAuth("r", cfg, "global").headers).toEqual({ "X-Api-Key": "k123" })
		})
	})

	it("auth block overrides raw headers Authorization", () => {
		const cfg: RegistryConfig = {
			url: "https://r",
			headers: { Authorization: "Bearer raw" },
			auth: { type: "bearer", token: "block" },
		}
		expect(resolveRegistryAuth("r", cfg, "global").headers?.Authorization).toBe("Bearer block")
	})
})

describe("resolveRegistryAuth — precedence", () => {
	it("env override beats the config auth block", () => {
		const cfg: RegistryConfig = { url: "https://r", auth: { type: "bearer", token: "fromConfig" } }
		withEnv({ OCX_REGISTRY_R_TOKEN: "fromEnv" }, () => {
			expect(resolveRegistryAuth("r", cfg, "global").headers?.Authorization).toBe("Bearer fromEnv")
		})
	})

	it("CLI flags beat the env override for a --from registry", () => {
		const cfg: RegistryConfig = { url: "https://r" }
		const cli: CliAuth = { auth: { type: "bearer", token: "fromCli" } }
		withEnv({ OCX_REGISTRY_R_TOKEN: "fromEnv" }, () => {
			expect(resolveRegistryAuth("r", cfg, "ephemeral", cli).headers?.Authorization).toBe(
				"Bearer fromCli",
			)
		})
	})

	it("env override supports OCX_REGISTRY_<ALIAS>_BASIC", () => {
		const cfg: RegistryConfig = { url: "https://r" }
		withEnv({ OCX_REGISTRY_R_BASIC: "u:p" }, () => {
			expect(resolveRegistryAuth("r", cfg, "global").headers?.Authorization).toBe(
				`Basic ${b64("u:p")}`,
			)
		})
	})
})

describe("resolveRegistryAuth — TLS", () => {
	it("honors config insecure in a trusted scope", () => {
		const cfg: RegistryConfig = { url: "https://r", insecure: true }
		expect(resolveRegistryAuth("r", cfg, "global").rejectUnauthorized).toBe(false)
	})

	it("honors config insecure in local scope (not a secret; author owns the URL)", () => {
		const cfg: RegistryConfig = { url: "https://r", insecure: true }
		expect(resolveRegistryAuth("r", cfg, "local").rejectUnauthorized).toBe(false)
	})
})

describe("resolveRegistryAuth — public registry", () => {
	it("returns no headers when nothing is configured", () => {
		const auth = resolveRegistryAuth("r", { url: "https://r" }, "local")
		expect(auth.headers).toBeUndefined()
		expect(auth.rejectUnauthorized).toBeUndefined()
	})
})

describe("createAuthResolver", () => {
	it("is lazy — an unrelated registry with a bad env ref does not break others", () => {
		const registries: Record<string, RegistryConfig> = {
			good: { url: "https://good", auth: { type: "bearer", token: "ok" } },
			bad: { url: "https://bad", auth: { type: "bearer", tokenEnv: "UNSET_XYZ" } },
		}
		withEnv({ UNSET_XYZ: undefined }, () => {
			const resolve = createAuthResolver(registries, "global")
			expect(resolve("good")?.headers?.Authorization).toBe("Bearer ok")
			expect(() => resolve("bad")).toThrow(/UNSET_XYZ/)
		})
	})

	it("applies CLI auth only to the ephemeral alias", () => {
		const registries: Record<string, RegistryConfig> = {
			cfg: { url: "https://cfg", auth: { type: "bearer", token: "cfgTok" } },
			eph: { url: "https://eph" },
		}
		const resolve = createAuthResolver(registries, "local", {
			ephemeral: { alias: "eph", cliAuth: { auth: { type: "bearer", token: "cliTok" } } },
		})
		expect(resolve("cfg")?.headers?.Authorization).toBe("Bearer cfgTok")
		expect(resolve("eph")?.headers?.Authorization).toBe("Bearer cliTok")
	})

	it("returns undefined for unknown aliases", () => {
		const resolve = createAuthResolver({}, "global")
		expect(resolve("nope")).toBeUndefined()
	})
})

describe("normalizeAliasEnv", () => {
	it("uppercases and replaces non-alphanumerics with underscore", () => {
		expect(normalizeAliasEnv("my-reg")).toBe("MY_REG")
		expect(normalizeAliasEnv("my.reg")).toBe("MY_REG")
		expect(normalizeAliasEnv("acme")).toBe("ACME")
	})
})

describe("fetcher threading", () => {
	beforeEach(() => _clearFetcherCacheForTests())
	afterEach(() => _clearFetcherCacheForTests())

	const okIndex = () =>
		new Response(JSON.stringify({ author: "test", components: [] }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		})

	it("passes the Authorization header to fetch", async () => {
		const fetchSpy = spyOn(global, "fetch").mockResolvedValue(okIndex())
		try {
			await fetchRegistryIndex("https://reg.example.com", {
				headers: { Authorization: "Bearer T" },
			})
			const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined
			expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer T")
		} finally {
			fetchSpy.mockRestore()
		}
	})

	it("passes tls.rejectUnauthorized:false to fetch when insecure", async () => {
		const fetchSpy = spyOn(global, "fetch").mockResolvedValue(okIndex())
		try {
			await fetchRegistryIndex("https://reg.example.com", { rejectUnauthorized: false })
			const init = fetchSpy.mock.calls[0]?.[1] as
				| { tls?: { rejectUnauthorized?: boolean } }
				| undefined
			expect(init?.tls?.rejectUnauthorized).toBe(false)
		} finally {
			fetchSpy.mockRestore()
		}
	})

	it("run-level setInsecureTls forces tls.rejectUnauthorized:false even without per-registry auth", async () => {
		const fetchSpy = spyOn(global, "fetch").mockResolvedValue(okIndex())
		try {
			setInsecureTls(true)
			await fetchRegistryIndex("https://reg.example.com")
			const init = fetchSpy.mock.calls[0]?.[1] as
				| { tls?: { rejectUnauthorized?: boolean } }
				| undefined
			expect(init?.tls?.rejectUnauthorized).toBe(false)
		} finally {
			setInsecureTls(false)
			fetchSpy.mockRestore()
		}
	})

	it("sends no init for a public (no-auth) request", async () => {
		const fetchSpy = spyOn(global, "fetch").mockResolvedValue(okIndex())
		try {
			await fetchRegistryIndex("https://reg.example.com")
			expect(fetchSpy.mock.calls[0]?.[1]).toBeUndefined()
		} finally {
			fetchSpy.mockRestore()
		}
	})

	it("does not cache a 401 as success", async () => {
		const fetchSpy = spyOn(global, "fetch").mockResolvedValue(
			new Response("nope", { status: 401, statusText: "Unauthorized" }),
		)
		try {
			await expect(fetchRegistryIndex("https://reg.example.com")).rejects.toThrow()
			await expect(fetchRegistryIndex("https://reg.example.com")).rejects.toThrow()
			// A cached failure would have short-circuited the second call.
			expect(fetchSpy.mock.calls.length).toBe(2)
		} finally {
			fetchSpy.mockRestore()
		}
	})
})

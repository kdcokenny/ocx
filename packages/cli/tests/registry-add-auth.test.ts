/**
 * Tests for `registry add` credential persistence:
 * building the auth block from flags, and refusing env/file refs in local scope.
 */

import { describe, expect, it } from "bun:test"
import { assertAuthPersistableInScope } from "../src/commands/registry"
import { buildRegistryAuthConfig } from "../src/registry/auth"
import type { RegistryAuthConfig } from "../src/schemas/config"

describe("buildRegistryAuthConfig", () => {
	it("returns undefined when no credential flags are given", () => {
		expect(buildRegistryAuthConfig({})).toBeUndefined()
	})

	it("builds a literal bearer block", () => {
		expect(buildRegistryAuthConfig({ token: "abc" })).toEqual({ type: "bearer", token: "abc" })
	})

	it("builds bearer env and file blocks", () => {
		expect(buildRegistryAuthConfig({ tokenEnv: "T" })).toEqual({ type: "bearer", tokenEnv: "T" })
		expect(buildRegistryAuthConfig({ tokenFile: "/p" })).toEqual({
			type: "bearer",
			tokenFile: "/p",
		})
	})

	it("builds a literal basic block from --username + --password", () => {
		expect(buildRegistryAuthConfig({ username: "admin", password: "secret" })).toEqual({
			type: "basic",
			username: "admin",
			password: "secret",
		})
	})

	it("builds basic from --username + --password-env / --password-file", () => {
		expect(buildRegistryAuthConfig({ username: "ci", passwordEnv: "PW" })).toEqual({
			type: "basic",
			username: "ci",
			passwordEnv: "PW",
		})
		expect(buildRegistryAuthConfig({ username: "ci", passwordFile: "/run/secrets/pw" })).toEqual({
			type: "basic",
			username: "ci",
			passwordFile: "/run/secrets/pw",
		})
	})

	it("rejects mixing bearer and basic flags", () => {
		expect(() => buildRegistryAuthConfig({ token: "a", username: "u" })).toThrow(/Cannot combine/)
	})

	it("rejects two bearer sources (schema: exactly one)", () => {
		expect(() => buildRegistryAuthConfig({ token: "a", tokenEnv: "B" })).toThrow(/exactly one/)
	})

	it("rejects two password sources (schema: exactly one)", () => {
		expect(() =>
			buildRegistryAuthConfig({ username: "u", password: "p", passwordEnv: "PW" }),
		).toThrow(/exactly one/)
	})

	it("rejects basic without a username", () => {
		expect(() => buildRegistryAuthConfig({ passwordEnv: "PW" })).toThrow()
	})
})

describe("assertAuthPersistableInScope", () => {
	const bearerEnv: RegistryAuthConfig = { type: "bearer", tokenEnv: "T" }
	const bearerLiteral: RegistryAuthConfig = { type: "bearer", token: "t" }
	const basicFile: RegistryAuthConfig = { type: "basic", username: "u", passwordFile: "/p" }
	const basicLiteral: RegistryAuthConfig = { type: "basic", username: "u", password: "p" }

	it("refuses env/file references in local scope", () => {
		expect(() => assertAuthPersistableInScope(bearerEnv, "local")).toThrow(/committed local config/)
		expect(() => assertAuthPersistableInScope(basicFile, "local")).toThrow(/committed local config/)
	})

	it("allows literal credentials in local scope", () => {
		expect(() => assertAuthPersistableInScope(bearerLiteral, "local")).not.toThrow()
		expect(() => assertAuthPersistableInScope(basicLiteral, "local")).not.toThrow()
	})

	it("allows env/file references in global and profile scope", () => {
		expect(() => assertAuthPersistableInScope(bearerEnv, "global")).not.toThrow()
		expect(() => assertAuthPersistableInScope(basicFile, "profile")).not.toThrow()
	})
})

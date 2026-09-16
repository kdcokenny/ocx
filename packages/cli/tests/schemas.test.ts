import { expect, test } from "bun:test"
import { REGISTRY_SCHEMA_LATEST_URL } from "../src/constants"
import {
	componentManifestSchema,
	normalizeFile,
	openCodeNameSchema,
	parseQualifiedComponent,
	registrySchema,
	validateFileTarget,
} from "../src/schemas/registry"

const component = {
	name: "review",
	type: "skill",
	description: "Review",
	files: ["skills/review/SKILL.md"],
}
const registry = {
	$schema: REGISTRY_SCHEMA_LATEST_URL,
	name: "Test",
	version: "1.0.0",
	author: "Test",
	components: [component],
}

test.each([
	"a",
	"review-code",
	"test123",
	"a".repeat(64),
])("accepts portable component names: %s", (name) => {
	expect(openCodeNameSchema.parse(name)).toBe(name)
	expect(parseQualifiedComponent(`team/${name}`)).toEqual({ namespace: "team", component: name })
})
test.each([
	"",
	"Upper",
	"bad--name",
	"-name",
	"name-",
	"../outside",
	"a/b",
	"a".repeat(65),
])("rejects invalid names: %s", (name) => {
	expect(openCodeNameSchema.safeParse(name).success).toBe(false)
	expect(() => parseQualifiedComponent(`team/${name}`)).toThrow()
})
test.each([
	"../x",
	"/tmp/file",
	"C:\\file",
	"skills/../file",
	"skills//file",
	"skills/./file",
	"file.",
	"AUX.md",
	"dir/con",
	"a:b",
	"a\0b",
	"a?b",
])("rejects unsafe or nonportable paths: %s", (path) => {
	expect(() => normalizeFile(path, "skill")).toThrow()
})
test.each([
	".ocx/receipt.jsonc",
	".git/config",
	".opencode/agent/a.md",
	"node_modules/a.js",
	".env",
	".env.local",
	"package.json",
	"bun.lock",
	"PACKAGE.JSON",
])("protects installation metadata: %s", (path) => {
	expect(() => validateFileTarget(path, "profile")).toThrow()
})
test.each([
	"ocx.jsonc",
	"opencode.json",
	"opencode.jsonc",
	"cli.json",
	"AGENTS.md",
])("reserves root config for profile recipes: %s", (path) => {
	expect(() => normalizeFile(path, "skill")).toThrow()
	expect(normalizeFile(path, "profile")).toEqual({ path, target: path })
})
test("normalizes separators and Unicode without rewriting native directory names", () => {
	expect(normalizeFile({ path: "a.md", target: "command\\re\u0301view.md" }, "command")).toEqual({
		path: "a.md",
		target: "command/réview.md",
	})
	expect(normalizeFile("commands/review.md")).toEqual({
		path: "commands/review.md",
		target: "commands/review.md",
	})
})
test.each([
	"opencode",
	"npmDependencies",
	"npmDevDependencies",
	"namespace",
])("rejects removed component fields: %s", (key) => {
	expect(componentManifestSchema.safeParse({ ...component, [key]: {} }).success).toBe(false)
})
test("rejects legacy schema, missing dependencies, duplicate names and unsupported fields", () => {
	expect(registrySchema.safeParse(registry).success).toBe(true)
	expect(
		registrySchema.safeParse({
			...registry,
			$schema: "https://ocx.kdco.dev/schemas/v2/registry.json",
		}).success,
	).toBe(false)
	expect(
		registrySchema.safeParse({ ...registry, components: [component, component] }).success,
	).toBe(false)
	expect(
		registrySchema.safeParse({
			...registry,
			components: [{ ...component, dependencies: ["missing"] }],
		}).success,
	).toBe(false)
	expect(registrySchema.safeParse({ ...registry, unknown: true }).success).toBe(false)
	expect(
		registrySchema.safeParse({
			...registry,
			components: [{ ...component, dependencies: ["other/review"] }],
		}).success,
	).toBe(true)
})

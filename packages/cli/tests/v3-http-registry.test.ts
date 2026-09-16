import { afterEach, beforeEach, expect, test } from "bun:test"
import type { Server } from "bun"
import { REGISTRY_SCHEMA_LATEST_URL } from "../src/constants"
import {
	_clearFetcherCacheForTests,
	fetchComponentVersion,
	fetchFileContent,
	fetchRegistryIndex,
} from "../src/registry/fetcher"
import { resolveDependencies } from "../src/registry/resolver"

let server: Server<unknown>
let base: string
let routes: Map<string, () => Response>
let seen: { path: string; token: string | null }[]
const skill = (name: string, dependencies: string[] = []) => ({
	name,
	type: "skill",
	description: name,
	dependencies,
	files: [`skills/${name}/SKILL.md`],
})
function component(path: string, name: string, dependencies: string[] = []) {
	routes.set(`${path}/components/${name}.json`, () =>
		Response.json({
			name,
			"dist-tags": { latest: "1.0.0" },
			versions: { "1.0.0": skill(name, dependencies) },
		}),
	)
}
beforeEach(() => {
	routes = new Map()
	seen = []
	server = Bun.serve({
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname
			seen.push({ path, token: request.headers.get("authorization") })
			return routes.get(path)?.() ?? new Response("missing", { status: 404 })
		},
	})
	base = `http://127.0.0.1:${server.port}`
	for (const path of ["/one", "/two"])
		routes.set(`${path}/index.json`, () =>
			Response.json({ $schema: REGISTRY_SCHEMA_LATEST_URL, author: "Test", components: [] }),
		)
})
afterEach(() => {
	server.stop(true)
	_clearFetcherCacheForTests()
})

test("resolves a diamond across registries once, dependencies before their parents, forwarding separate credentials", async () => {
	component("/one", "parent", ["left", "right"])
	component("/one", "left", ["two/shared"])
	component("/one", "right", ["two/shared"])
	component("/two", "shared")
	const result = await resolveDependencies(
		{
			one: { url: `${base}/one`, headers: { authorization: "fixture-one" } },
			two: { url: `${base}/two`, headers: { authorization: "fixture-two" } },
		},
		["one/parent"],
	)
	expect(result.installOrder).toEqual(["two/shared", "one/left", "one/right", "one/parent"])
	expect(seen.filter((item) => item.path === "/two/components/shared.json")).toHaveLength(1)
	expect(
		seen.every(
			(item) => item.token === (item.path.startsWith("/one/") ? "fixture-one" : "fixture-two"),
		),
	).toBe(true)
})
test("detects same-registry, cross-registry and self cycles in actual resolution", async () => {
	component("/one", "a", ["b"])
	component("/one", "b", ["a"])
	await expect(resolveDependencies({ one: { url: `${base}/one` } }, ["one/a"])).rejects.toThrow(
		"Circular",
	)
	_clearFetcherCacheForTests()
	component("/one", "a", ["two/b"])
	component("/two", "b", ["one/a"])
	await expect(
		resolveDependencies({ one: { url: `${base}/one` }, two: { url: `${base}/two` } }, ["one/a"]),
	).rejects.toThrow("Circular")
	_clearFetcherCacheForTests()
	component("/one", "a", ["a"])
	await expect(resolveDependencies({ one: { url: `${base}/one` } }, ["one/a"])).rejects.toThrow(
		"Circular",
	)
})
test("keeps authorization-specific caches separate and retries failed responses", async () => {
	routes.set("/one/index.json", () => new Response("denied", { status: 401 }))
	await expect(
		fetchRegistryIndex(`${base}/one`, { headers: { authorization: "bad-fixture" } }),
	).rejects.toThrow("401")
	routes.set("/one/index.json", () =>
		Response.json({ $schema: REGISTRY_SCHEMA_LATEST_URL, author: "Test", components: [] }),
	)
	await fetchRegistryIndex(`${base}/one`, { headers: { authorization: "bad-fixture" } })
	await fetchRegistryIndex(`${base}/one`, { headers: { authorization: "good-fixture" } })
	await fetchRegistryIndex(`${base}/one`, { headers: { authorization: "good-fixture" } })
	expect(seen).toHaveLength(3)
})
test("expands header variables without caching credentials from a previous environment", async () => {
	const previous = process.env.OCX_TEST_REGISTRY_TOKEN
	try {
		const options = { headers: { authorization: "Bearer " + "${" + "OCX_TEST_REGISTRY_TOKEN}" } }
		delete process.env.OCX_TEST_REGISTRY_TOKEN
		await expect(fetchRegistryIndex(`${base}/one`, options)).rejects.toThrow(
			"requires environment variable",
		)
		process.env.OCX_TEST_REGISTRY_TOKEN = "fixture-first"
		await fetchRegistryIndex(`${base}/one`, options)
		process.env.OCX_TEST_REGISTRY_TOKEN = "fixture-second"
		await fetchRegistryIndex(`${base}/one`, options)
		expect(seen.map((item) => item.token)).toEqual([
			"Bearer fixture-first",
			"Bearer fixture-second",
		])
	} finally {
		if (previous === undefined) delete process.env.OCX_TEST_REGISTRY_TOKEN
		else process.env.OCX_TEST_REGISTRY_TOKEN = previous
	}
})
test("rejects V1/V2 registries before fetching component code", async () => {
	for (const schema of [undefined, "https://ocx.kdco.dev/schemas/v2/registry.json"]) {
		_clearFetcherCacheForTests()
		routes.set("/one/index.json", () =>
			Response.json({ $schema: schema, author: "Test", components: [] }),
		)
		await expect(fetchComponentVersion(`${base}/one`, "a")).rejects.toThrow("Use OCX 2")
	}
	expect(seen.every((item) => item.path.endsWith("/index.json"))).toBe(true)
})
test("validates selected revisions and identity without parsing unused legacy revisions", async () => {
	routes.set("/one/components/a.json", () =>
		Response.json({
			name: "a",
			"dist-tags": { latest: "2.0.0" },
			versions: { "1.0.0": { ...skill("a"), opencode: {} }, "2.0.0": skill("a") },
		}),
	)
	expect((await fetchComponentVersion(`${base}/one`, "a")).version).toBe("2.0.0")
	await expect(fetchComponentVersion(`${base}/one`, "a", "1.0.0")).rejects.toThrow(
		"cannot patch config",
	)
	await expect(fetchComponentVersion(`${base}/one`, "a", "3.0.0")).rejects.toThrow("no version")
	_clearFetcherCacheForTests()
	routes.set("/one/components/a.json", () =>
		Response.json({
			name: "a",
			"dist-tags": { latest: "1.0.0" },
			versions: { "1.0.0": skill("other") },
		}),
	)
	await expect(fetchComponentVersion(`${base}/one`, "a")).rejects.toThrow("does not match")
})
test("encodes paths and returns binary bytes, while traversal makes no request", async () => {
	const bytes = Buffer.from([0, 255, 128])
	routes.set("/one/components/a/skills/a%20b.bin", () => new Response(bytes))
	expect(await fetchFileContent(`${base}/one`, "a", "skills/a b.bin")).toEqual(bytes)
	const count = seen.length
	for (const path of ["../secret", "/secret", "a/../../secret"])
		await expect(fetchFileContent(`${base}/one`, "a", path)).rejects.toThrow()
	expect(seen).toHaveLength(count)
})

import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { parse } from "jsonc-parser"

type RegistryComponent = {
	name: string
	type: string
	files?: string[]
	dependencies?: string[]
	opencode?: {
		mcp?: Record<string, unknown>
		agent?: Record<string, { permission?: Record<string, unknown> }>
	}
}

type Registry = {
	components: RegistryComponent[]
}

async function readRegistry(): Promise<Registry> {
	const registryText = await readFile(new URL("../registry.jsonc", import.meta.url), "utf8")
	return parse(registryText) as Registry
}

function getRegistryComponent(registry: Registry, name: string): RegistryComponent {
	const component = registry.components.find((candidate) => candidate.name === name)
	if (!component) {
		throw new Error(`Registry component ${name} is missing`)
	}

	return component
}

describe("kdco/flow registry source coverage", () => {
	it("keeps flow bundle and explorer-clone reproducible from source registry", async () => {
		const registry = await readRegistry()
		const explorerClone = getRegistryComponent(registry, "explorer-clone")
		const flow = getRegistryComponent(registry, "flow")

		expect(explorerClone.type).toBe("plugin")
		expect(explorerClone.files).toEqual(["plugins/explorer-clone.ts"])
		expect(explorerClone.dependencies ?? []).toEqual([])

		expect(flow.type).toBe("bundle")
		expect(flow.files ?? []).toEqual([])
		expect(flow.dependencies).toEqual(
			expect.arrayContaining([
				"plan-protocol",
				"explorer-clone",
				"conductor",
				"explorer",
				"coder",
				"plan-reviewer",
				"qa-reviewer",
				"review",
				"notify",
				"worktree",
				"philosophy",
			]),
		)

		for (const agentName of ["conductor", "explorer", "plan-reviewer", "qa-reviewer"]) {
			const agent = getRegistryComponent(registry, agentName)
			expect(agent.type).toBe("agent")
			expect(agent.files).toEqual([`agents/${agentName}.md`])
		}
	})

	it("keeps gh_grep enabled for flow explorer defaults", async () => {
		const registry = await readRegistry()
		const explorer = getRegistryComponent(registry, "explorer")
		const ghGrepMcp = explorer.opencode?.mcp?.gh_grep
		const explorerPermissions = explorer.opencode?.agent?.explorer?.permission ?? {}

		expect(ghGrepMcp).toBe("https://mcp.grep.app")
		expect(explorerPermissions["gh_grep_*"]).toBe("allow")
	})
})

import { describe, expect, it } from "bun:test"
import * as backgroundAgentsModule from "../files/plugins/background-agents"
import * as worktreeModule from "../files/plugins/worktree"

function expectNamedExportsToBeNonCallable(
	moduleName: string,
	moduleNamespace: Record<string, unknown>,
): void {
	const namedExports = Object.entries(moduleNamespace).filter(([exportName]) => exportName !== "default")

	expect(namedExports.length, `${moduleName} should expose named internals for tests`).toBeGreaterThan(0)

	for (const [exportName, exportValue] of namedExports) {
		expect(
			typeof exportValue,
			`${moduleName}.${exportName} must not be callable by the OpenCode plugin loader`,
		).not.toBe("function")
	}
}

describe("plugin entry export surface", () => {
	it("keeps background-agents named exports non-callable", () => {
		expect(Object.keys(backgroundAgentsModule).sort()).toEqual([
			"backgroundAgentsInternals",
			"default",
		])
		expectNamedExportsToBeNonCallable("background-agents", backgroundAgentsModule)
	})

	it("keeps worktree named exports non-callable", () => {
		expect(Object.keys(worktreeModule).sort()).toEqual(["default", "worktreeInternals"])
		expectNamedExportsToBeNonCallable("worktree", worktreeModule)
	})
})

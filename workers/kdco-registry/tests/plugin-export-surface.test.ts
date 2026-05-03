import { describe, expect, it } from "bun:test"
import * as backgroundAgentsModule from "../files/plugins/background-agents"
import * as notifyModule from "../files/plugins/notify"
import * as workspacePluginModule from "../files/plugins/workspace-plugin"
import * as worktreeModule from "../files/plugins/worktree"

function expectDefaultOnlyExportSurface(
	moduleName: string,
	moduleNamespace: Record<string, unknown>,
): void {
	expect(Object.keys(moduleNamespace).sort(), `${moduleName} must expose only default`).toEqual([
		"default",
	])
}

describe("plugin entry export surface", () => {
	it("keeps packaged plugin entry modules default-only", () => {
		expectDefaultOnlyExportSurface("background-agents", backgroundAgentsModule)
		expectDefaultOnlyExportSurface("worktree", worktreeModule)
		expectDefaultOnlyExportSurface("notify", notifyModule)
		expectDefaultOnlyExportSurface("workspace-plugin", workspacePluginModule)
	})
})

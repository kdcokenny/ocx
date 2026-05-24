import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const syncWorkflowPath = join(
	import.meta.dir,
	"..",
	"..",
	"..",
	".github",
	"workflows",
	"sync-facades.yml",
)
const prPreviewWorkflowPath = join(
	import.meta.dir,
	"..",
	"..",
	"..",
	".github",
	"workflows",
	"pr-preview-cli.yml",
)

describe("GitHub Actions security", () => {
	it("pins the facade sync action when passing FACADE_SYNC_PAT", () => {
		const workflow = readFileSync(syncWorkflowPath, "utf8")
		const facadePatInput = "GH_PAT: $" + "{{ secrets.FACADE_SYNC_PAT }}"
		const syncStep = workflow.match(
			/ {6}- name: Sync Files\n(?<body>(?: {8}.*\n?)+?)(?=\n {6}- name:|\n*$)/,
		)?.groups?.body

		expect(syncStep).toBeDefined()
		expect(syncStep).toContain(facadePatInput)
		expect(syncStep).toMatch(/uses:\s*BetaHuhn\/repo-file-sync-action@[a-f0-9]{40}\n/)
	})

	it("does not expose a write-scoped token to PR preview build code", () => {
		const workflow = readFileSync(prPreviewWorkflowPath, "utf8")

		expect(workflow).toContain("pull_request:")
		expect(workflow).toContain("contents: read")
		expect(workflow).not.toContain("pull-requests: write")
		expect(workflow).toMatch(
			/uses:\s*actions\/checkout@v6\n\s+with:\n\s+persist-credentials:\s*false\n/,
		)
		expect(workflow).not.toMatch(/GITHUB_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/)
		expect(workflow).toContain(
			"npx --no-install pkg-pr-new publish --bin --packageManager=npm,pnpm,bun ./packages/cli",
		)
	})
})

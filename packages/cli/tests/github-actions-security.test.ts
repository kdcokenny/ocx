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
})

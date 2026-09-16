import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const prPreviewWorkflowPath = join(
	import.meta.dir,
	"..",
	"..",
	"..",
	".github",
	"workflows",
	"pr-preview-cli.yml",
)
const releaseWorkflowPath = join(
	import.meta.dir,
	"..",
	"..",
	"..",
	".github",
	"workflows",
	"release.yml",
)

describe("GitHub Actions security", () => {
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

	it("fails closed when a release tag is not aligned with remote main", () => {
		const workflow = readFileSync(releaseWorkflowPath, "utf8")
		const revalidationIndex = workflow.indexOf("- name: Revalidate release source")
		const releaseIndex = workflow.indexOf("- name: Release\n", revalidationIndex)
		const publishIndex = workflow.indexOf("- name: Publish ocx to npm", revalidationIndex)

		expect(workflow).toContain("- name: Validate release tag version")
		expect(workflow).toContain('"$GITHUB_REF_NAME" != "v$' + '{package_version}"')
		expect(workflow).toContain('"$lock_version" != "$package_version"')
		expect(workflow).toContain(
			'git merge-base --is-ancestor "$GITHUB_SHA" "refs/remotes/origin/$' + '{DEFAULT_BRANCH}"',
		)
		expect(workflow).toContain('"$remote_version" != "$package_version"')
		expect(revalidationIndex).toBeGreaterThan(-1)
		expect(releaseIndex).toBeGreaterThan(revalidationIndex)
		expect(publishIndex).toBeGreaterThan(revalidationIndex)
	})
})

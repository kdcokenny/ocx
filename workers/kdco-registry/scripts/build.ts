import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { buildRegistry } from "ocx"
import { restoreLegacyRegistry } from "../../../legacy/restore"
import { publishDirectory } from "../../../packages/cli/src/utils/publish-directory"

const root = join(import.meta.dir, "..")
await publishDirectory(join(root, "dist"), async (stage) => {
	await restoreLegacyRegistry("kdco-registry", stage)
	const result = await buildRegistry({
		source: join(root, "catalog"),
		out: join(stage, "opencode-v2"),
	})
	await writeFile(
		join(stage, "opencode-v2/.well-known/ocx.json"),
		JSON.stringify({ registry: "/opencode-v2/index.json" }),
	)
	console.log(`Preserved legacy URLs and built ${result.componentsCount} V2 components`)
})

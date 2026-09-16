import { join } from "node:path"
import { buildRegistry } from "ocx"
import { restoreLegacyRegistry } from "../../../legacy/restore"

const root = join(import.meta.dir, "..")
await restoreLegacyRegistry("kdco-registry", join(root, "dist"))
const result = await buildRegistry({
	source: join(root, "catalog"),
	out: join(root, "dist", "opencode-v2"),
})
console.log(`Preserved legacy URLs and built ${result.componentsCount} V2 components`)

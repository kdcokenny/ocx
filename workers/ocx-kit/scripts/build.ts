import { join } from "node:path"
import { restoreLegacyRegistry } from "../../../legacy/restore"

await restoreLegacyRegistry("ocx-kit", join(import.meta.dir, "..", "dist"))
console.log("Restored frozen OpenCode V1 preset registry")

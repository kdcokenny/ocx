import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { toJSONSchema } from "zod"
import { ocxConfigSchema, receiptSchema } from "../src/schemas/config"
import { profileOcxConfigSchema } from "../src/schemas/ocx"
import { registrySchema } from "../src/schemas/registry"

const directory = join(import.meta.dir, "../../../docs/schemas/v3")
await mkdir(directory, { recursive: true })
for (const [name, schema] of Object.entries({
	registry: registrySchema,
	ocx: ocxConfigSchema,
	profile: profileOcxConfigSchema,
	receipt: receiptSchema,
})) {
	const output = {
		...toJSONSchema(schema, { io: "input" }),
		$id: `https://ocx.kdco.dev/schemas/v3/${name}.json`,
	}
	await writeFile(join(directory, `${name}.schema.json`), `${JSON.stringify(output, null, 2)}\n`)
}

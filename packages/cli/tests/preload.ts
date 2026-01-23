import { afterAll } from "bun:test"
import fsSync from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const dir = path.join(os.tmpdir(), `ocx-test-data-${process.pid}`)
await fs.mkdir(dir, { recursive: true })

afterAll(() => {
	fsSync.rmSync(dir, { recursive: true, force: true })
})

// NOTE: We do NOT override HOME because it breaks bun version manager (bunv).
// Subprocesses would fail with "Bun v1.3.5 is not installed".
// XDG directories provide sufficient isolation for test purposes.

// Set XDG directories for complete isolation
process.env.XDG_CONFIG_HOME = path.join(dir, "config")
process.env.XDG_DATA_HOME = path.join(dir, "share")
process.env.XDG_CACHE_HOME = path.join(dir, "cache")
process.env.XDG_STATE_HOME = path.join(dir, "state")

// Create XDG directories to ensure they exist before tests run
await fs.mkdir(process.env.XDG_CONFIG_HOME, { recursive: true })
await fs.mkdir(process.env.XDG_DATA_HOME, { recursive: true })
await fs.mkdir(process.env.XDG_CACHE_HOME, { recursive: true })
await fs.mkdir(process.env.XDG_STATE_HOME, { recursive: true })

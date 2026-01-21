#!/usr/bin/env bun
/**
 * OCX CLI - OpenCode Extensions
 *
 * A ShadCN-style CLI for installing agents, skills, plugins, and commands
 * into OpenCode projects.
 */

import { Command } from "commander"
import { registerAddCommand } from "./commands/add"
import { registerBuildCommand } from "./commands/build"
import { registerConfigCommand } from "./commands/config/index"
import { registerDiffCommand } from "./commands/diff"
import { registerGhostCommand } from "./commands/ghost/index"
import { registerInitCommand } from "./commands/init"
import { registerOpencodeCommand } from "./commands/opencode"
import { registerProfileCommand } from "./commands/profile/index"
import { registerRegistryCommand } from "./commands/registry"
import { registerSearchCommand } from "./commands/search"
import { registerSelfCommand } from "./commands/self/index"
import { registerUpdateCommand } from "./commands/update"
import { registerUpdateCheckHook } from "./self-update/index"
import { handleError } from "./utils/index"

// Version injected at build time
declare const __VERSION__: string
const version = typeof __VERSION__ !== "undefined" ? __VERSION__ : "0.0.0-dev"

async function main() {
	const program = new Command()
		.name("ocx")
		.description("OpenCode Extensions - Install agents, skills, plugins, and commands")
		.version(version)

	// Register all commands using the registration pattern
	registerInitCommand(program)
	registerAddCommand(program)
	registerUpdateCommand(program)
	registerDiffCommand(program)
	registerSearchCommand(program)
	registerRegistryCommand(program)
	registerBuildCommand(program)
	registerSelfCommand(program)

	// New top-level commands (Phase 5)
	registerProfileCommand(program)
	registerConfigCommand(program)
	registerOpencodeCommand(program)

	// Migration command (temporary - remove in next minor version)
	registerGhostCommand(program)

	// Register update check hook (runs after each command)
	registerUpdateCheckHook(program)

	// Parse and handle errors
	await program.parseAsync(process.argv)
}

// Only run CLI when executed directly, not when imported as a library
if (import.meta.main) {
	main().catch((err) => {
		handleError(err)
	})
}

// Library exports - for programmatic use
export { type BuildRegistryOptions, type BuildRegistryResult, buildRegistry } from "./lib/index"

// Schema exports - for validation
export {
	type ComponentManifest,
	componentManifestSchema,
	type OcxConfig,
	type OcxLock,
	// Config schemas
	ocxConfigSchema,
	ocxLockSchema,
	type Packument,
	packumentSchema,
	type Registry,
	// Registry schemas
	registrySchema,
} from "./schemas/index"

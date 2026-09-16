#!/usr/bin/env -S bun --no-env-file

if (import.meta.main) {
	void runCliEntryPoint()
}

async function runCliEntryPoint(): Promise<void> {
	const { runCliEntryPoint: runCli } = await import("./cli/entrypoint")
	await runCli()
}

export {
	type BuildRegistryOptions,
	type BuildRegistryResult,
	buildRegistry,
	type ComponentManifest,
	componentManifestSchema,
	type OcxConfig,
	ocxConfigSchema,
	type Packument,
	packumentSchema,
	type Registry,
	registrySchema,
} from "./programmatic-exports"

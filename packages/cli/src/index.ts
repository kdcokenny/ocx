#!/usr/bin/env -S bun --no-env-file

if (import.meta.main) {
	void runCliEntryPoint()
}

async function runCliEntryPoint(): Promise<void> {
	try {
		const { runCli } = await import("./cli/bootstrap")
		await runCli()
	} catch (error) {
		const { handleError } = await import("./utils/handle-error")
		handleError(error)
	}
}

export {
	type BuildRegistryOptions,
	type BuildRegistryResult,
	buildRegistry,
	type ComponentManifest,
	componentManifestSchema,
	type OcxConfig,
	type OcxLock,
	ocxConfigSchema,
	ocxLockSchema,
	type Packument,
	packumentSchema,
	type Registry,
	registrySchema,
} from "./programmatic-exports"

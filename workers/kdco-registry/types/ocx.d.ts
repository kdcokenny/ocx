declare module "ocx" {
	export interface BuildRegistryOptions {
		source: string
		out: string
		dryRun?: boolean
	}

	export interface BuildRegistryResult {
		componentsCount: number
		outputPath: string
	}

	export function buildRegistry(options: BuildRegistryOptions): Promise<BuildRegistryResult>
}

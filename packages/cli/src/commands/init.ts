/**
 * OCX CLI - init command
 * Initialize OCX configuration in a project or scaffold a new registry
 */

import { existsSync } from "node:fs"
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Command } from "commander"
import { OCX_SCHEMA_URL, REGISTRY_SCHEMA_LATEST_URL } from "../constants"
import { ProfileManager } from "../profile/manager"
import { getGlobalConfig } from "../profile/paths"
import { ocxConfigSchema } from "../schemas/config"
import { ConflictError, NetworkError, ValidationError } from "../utils/errors"
import { handleError } from "../utils/handle-error"
import { logger } from "../utils/logger"
import { addCommonOptions, addGlobalOption, addVerboseOption } from "../utils/shared-options"
import { createSpinner } from "../utils/spinner"

declare const __VERSION__: string | undefined

export const TEMPLATE_REPO = "kdcokenny/ocx"
const TEMPLATE_PATH = "examples/registry-starter"

interface InitOptions {
	cwd?: string
	quiet?: boolean
	verbose?: boolean
	json?: boolean
	registry?: string
	namespace?: string
	author?: string
	canary?: boolean
	local?: string
	global?: boolean
	project?: boolean
}

export function registerInitCommand(program: Command): void {
	const cmd = program.command("init").description("Initialize OCX configuration in your project")

	addCommonOptions(cmd)
	addVerboseOption(cmd)
	addGlobalOption(cmd)

	cmd
		.option("--project", "Initialize OCX sources in this project")
		.option("--registry <path>", "Scaffold a new OCX registry project at path")
		.option("--namespace <name>", "Registry namespace (e.g., my-org)")
		.option("--author <name>", "Author name for the registry")
		.option("--canary", "Use canary (main branch) instead of latest release")
		.option("--local <path>", "Use local template directory instead of fetching")
		.action(async (options: InitOptions) => {
			try {
				if ([options.registry, options.global, options.project].filter(Boolean).length !== 1)
					throw new ValidationError("Choose --global, --project, or --registry <path>.")
				if (options.registry) {
					await runInitRegistry(options.registry, options)
				} else if (options.global) {
					await runInitGlobal(options)
				} else {
					await runInit(options)
				}
			} catch (error) {
				handleError(error, { json: options.json })
			}
		})
}

async function runInit(options: InitOptions): Promise<void> {
	const configPath = join(options.cwd ?? process.cwd(), ".opencode", "ocx.jsonc")
	if (existsSync(configPath)) throw new ConflictError(`Config already exists: ${configPath}`)
	await mkdir(dirname(configPath), { recursive: true })
	await writeFile(
		configPath,
		`${JSON.stringify(ocxConfigSchema.parse({ $schema: OCX_SCHEMA_URL, registries: {} }), null, 2)}\n`,
		{ flag: "wx" },
	)
	if (options.json) console.log(JSON.stringify({ success: true, path: configPath }))
	else if (!options.quiet) console.log(`Created ${configPath}`)
}

async function runInitGlobal(options: InitOptions): Promise<void> {
	await ProfileManager.create().initialize()
	if (options.json) console.log(JSON.stringify({ success: true, path: getGlobalConfig() }))
	else if (!options.quiet)
		console.log(
			`Profiles initialized. Launch with 'ocx oc --profile default'. Settings: ${getGlobalConfig()}`,
		)
}

async function runInitRegistry(registryPath: string, options: InitOptions): Promise<void> {
	const cwd = registryPath
	const namespace = options.namespace ?? "my-registry"
	const author = options.author ?? "Your Name"

	// Validate namespace format (Early Exit)
	if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(namespace)) {
		throw new ValidationError(
			"Invalid namespace format: must start with letter/number, use hyphens only between segments (e.g., 'my-registry')",
		)
	}

	// Check if directory is empty (Early Exit)
	const existingFiles = await readdir(cwd).catch(() => [])
	const hasVisibleFiles = existingFiles.some((f) => !f.startsWith("."))

	if (hasVisibleFiles) {
		throw new ConflictError(
			"Directory is not empty. Remove existing files or choose a different directory.",
		)
	}

	const spin = options.quiet ? null : createSpinner({ text: "Scaffolding registry..." })
	spin?.start()

	try {
		// Fetch and extract template (or copy from local)
		if (spin) spin.text = options.local ? "Copying template..." : "Fetching template..."

		if (options.local) {
			// Use local template directory
			await mkdir(cwd, { recursive: true })
			await copyDir(options.local, cwd)
		} else {
			// Fetch from GitHub
			const version = options.canary ? "main" : getReleaseTag()
			await fetchAndExtractTemplate(cwd, version, options.verbose)
		}

		// Replace placeholders
		if (spin) spin.text = "Configuring project..."
		await replacePlaceholders(cwd, { namespace, author })

		spin?.succeed(`Created registry: ${namespace}`)

		if (options.json) {
			console.log(JSON.stringify({ success: true, namespace, path: cwd }))
		} else if (!options.quiet) {
			logger.info("")
			logger.info("Next steps:")
			logger.info("  1. bun install")
			logger.info("  2. Edit registry.jsonc with your components")
			logger.info("  3. bun run build")
			logger.info("")
			logger.info("Deploy to:")
			logger.info("  Cloudflare: bunx wrangler deploy")
			logger.info("  Vercel:     vercel")
			logger.info("  Netlify:    netlify deploy")
		}
	} catch (error) {
		spin?.fail("Failed to scaffold registry")
		throw error
	}
}

/** Copy directory recursively */
async function copyDir(src: string, dest: string): Promise<void> {
	await cp(src, dest, { recursive: true })
}

/**
 * Returns the release tag for template fetching.
 * Throws in development mode - use --canary flag instead.
 */
export function getReleaseTag(): string {
	if (typeof __VERSION__ === "undefined") {
		throw new ValidationError(
			"Cannot fetch release template in development mode. Run with --canary flag to use the latest development template.",
		)
	}
	return `v${__VERSION__}`
}

/**
 * Constructs the GitHub tarball URL for a given version.
 * @param version - Either "main" for canary or "vX.Y.Z" for release
 */
export function getTemplateUrl(version: string): string {
	const ref = version === "main" ? "heads/main" : `tags/${version}`
	return `https://github.com/${TEMPLATE_REPO}/archive/refs/${ref}.tar.gz`
}

async function fetchAndExtractTemplate(
	destDir: string,
	version: string,
	verbose?: boolean,
): Promise<void> {
	const tarballUrl = getTemplateUrl(version)

	if (verbose) {
		logger.info(`Fetching ${tarballUrl}`)
	}

	const response = await fetch(tarballUrl)
	if (!response.ok || !response.body) {
		throw new NetworkError(`Failed to fetch template from ${tarballUrl}: ${response.statusText}`)
	}

	// Create temp directory for extraction
	const tempDir = join(destDir, ".ocx-temp")
	await mkdir(tempDir, { recursive: true })

	try {
		// Download tarball
		const tarPath = join(tempDir, "template.tar.gz")
		const arrayBuffer = await response.arrayBuffer()
		await writeFile(tarPath, Buffer.from(arrayBuffer))

		// Extract using tar command (available on all platforms with Bun)
		const proc = Bun.spawn(["tar", "-xzf", tarPath, "-C", tempDir], {
			stdout: "ignore",
			stderr: "pipe",
		})
		const exitCode = await proc.exited
		if (exitCode !== 0) {
			const stderr = await new Response(proc.stderr).text()
			throw new Error(`Failed to extract template: ${stderr}`)
		}

		// Find the extracted directory (format: ocx-{version}/)
		const extractedDirs = await readdir(tempDir)
		const extractedDir = extractedDirs.find((d) => d.startsWith("ocx-"))
		if (!extractedDir) {
			throw new Error("Failed to find extracted template directory")
		}

		// Copy template files to destination
		const templateDir = join(tempDir, extractedDir, TEMPLATE_PATH)
		await copyDir(templateDir, destDir)
	} finally {
		// Cleanup temp directory
		await rm(tempDir, { recursive: true, force: true })
	}
}

/** Convert string to title case (e.g., "my-registry" → "My Registry") */
function toTitleCase(str: string): string {
	return str
		.split(/[-_\s]+/)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
		.join(" ")
}

async function replacePlaceholders(
	dir: string,
	values: { namespace: string; author: string },
): Promise<void> {
	const filesToProcess = [
		"registry.jsonc",
		"package.json",
		"wrangler.jsonc",
		"README.md",
		"AGENTS.md",
	]

	for (const file of filesToProcess) {
		const filePath = join(dir, file)
		if (!existsSync(filePath)) continue

		let content = await readFile(filePath).then((b) => b.toString())

		// Replace placeholders
		content = content.replace(/my-registry/g, values.namespace)
		content = content.replace(/My Registry/g, toTitleCase(values.namespace))
		content = content.replace(/Your Name/g, values.author)

		if (file === "registry.jsonc") {
			if (/"\$schema"\s*:/.test(content)) {
				content = content.replace(
					/("\$schema"\s*:\s*")[^"]*(")/,
					`$1${REGISTRY_SCHEMA_LATEST_URL}$2`,
				)
			} else {
				content = content.replace(/{/, `{\n\t"$schema": "${REGISTRY_SCHEMA_LATEST_URL}",`)
			}
		}

		await writeFile(filePath, content)
	}
}

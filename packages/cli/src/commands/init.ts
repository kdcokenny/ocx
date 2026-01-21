/**
 * OCX CLI - init command
 * Initialize OCX configuration in a project or scaffold a new registry
 */

import { existsSync } from "node:fs"
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Command } from "commander"
import { OCX_SCHEMA_URL } from "../constants"
import { ProfileManager } from "../profile/manager"
import { getProfileOcxConfig, getProfilesDir } from "../profile/paths"
import { findOcxConfig, ocxConfigSchema } from "../schemas/config"
import { ensureOpencodeConfig } from "../updaters/update-opencode-config"
import { ConflictError, NetworkError, ProfileExistsError, ValidationError } from "../utils/errors"
import { createSpinner, handleError, logger } from "../utils/index"

const TEMPLATE_REPO = "kdcokenny/ocx"
const TEMPLATE_PATH = "examples/registry-starter"

interface InitOptions {
	cwd?: string
	quiet?: boolean
	verbose?: boolean
	json?: boolean
	registry?: boolean
	namespace?: string
	author?: string
	canary?: boolean
	local?: string
	force?: boolean // Only used for --registry mode
	global?: boolean
}

export function registerInitCommand(program: Command): void {
	program
		.command("init [directory]")
		.description("Initialize OCX configuration in your project")
		.option("--cwd <path>", "Working directory", process.cwd())
		.option("-q, --quiet", "Suppress output")
		.option("-v, --verbose", "Verbose output")
		.option("--json", "Output as JSON")
		.option("--registry", "Scaffold a new OCX registry project")
		.option("--namespace <name>", "Registry namespace (e.g., my-org)")
		.option("--author <name>", "Author name for the registry")
		.option("--canary", "Use canary (main branch) instead of latest release")
		.option("--local <path>", "Use local template directory instead of fetching")
		.option("-f, --force", "Overwrite existing files (registry mode only)")
		.option("-g, --global", "Initialize in global OpenCode config (~/.config/opencode)")
		.action(async (directory: string | undefined, options: InitOptions) => {
			try {
				if (options.registry) {
					await runInitRegistry(directory, options)
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
	const cwd = options.cwd ?? process.cwd()

	// Check for existing config in either location
	const { path: configPath, exists } = findOcxConfig(cwd)

	// Check for existing config - error if exists (Law 1: Early Exit)
	if (exists) {
		throw new ConflictError(
			`ocx.jsonc already exists at ${configPath}\n\n` +
				`To reset, delete the config and run init again:\n` +
				`  rm ${configPath} && ocx init`,
		)
	}

	const spin = options.quiet ? null : createSpinner({ text: "Initializing OCX..." })
	spin?.start()

	try {
		// Create minimal config - schema will apply defaults
		const rawConfig = {
			$schema: OCX_SCHEMA_URL,
			registries: {},
		}

		// Validate with schema (applies defaults)
		const config = ocxConfigSchema.parse(rawConfig)

		// Ensure .opencode directory exists
		await mkdir(dirname(configPath), { recursive: true })

		// Write config file
		const content = JSON.stringify(config, null, 2)
		await writeFile(configPath, content, "utf-8")

		// Ensure opencode.jsonc exists (upsert - creates if not present)
		const opencodeResult = await ensureOpencodeConfig(cwd)

		spin?.succeed("Initialized OCX configuration")

		if (options.json) {
			console.log(
				JSON.stringify({
					success: true,
					path: configPath,
					opencodePath: opencodeResult.path,
					opencodeCreated: opencodeResult.created,
				}),
			)
		} else if (!options.quiet) {
			logger.info(`Created ${configPath}`)
			if (opencodeResult.created) {
				logger.info(`Created ${opencodeResult.path}`)
			}
			logger.info("")
			logger.info("Next steps:")
			logger.info("  1. Add a registry: ocx registry add <url>")
			logger.info("  2. Install components: ocx add <component>")
		}
	} catch (error) {
		spin?.fail("Failed to initialize")
		throw error
	}
}

async function runInitGlobal(options: InitOptions): Promise<void> {
	const manager = ProfileManager.create()

	// Guard: Check if already initialized (Law 1: Early Exit)
	if (await manager.isInitialized()) {
		const profilesDir = getProfilesDir()
		throw new ProfileExistsError(`Global profiles already initialized at ${profilesDir}`)
	}

	const spin = options.quiet ? null : createSpinner({ text: "Initializing global profiles..." })
	spin?.start()

	try {
		// Initialize profiles directory with default profile
		await manager.initialize()

		// Get paths for output
		const profilesDir = getProfilesDir()
		const ocxConfigPath = getProfileOcxConfig("default")

		spin?.succeed("Initialized global profiles")

		if (options.json) {
			console.log(
				JSON.stringify({
					success: true,
					profilesDir,
					defaultProfile: "default",
					ocxConfigPath,
				}),
			)
		} else if (!options.quiet) {
			logger.info(`Created ${profilesDir}`)
			logger.info(`Created profile "default"`)
			logger.info("")
			logger.info("Next steps:")
			logger.info("  1. Edit your profile config: ocx profile config")
			logger.info("  2. Add registries: ocx registry add <url> --profile default")
			logger.info("  3. Launch OpenCode: ocx opencode")
			logger.info("  4. Create more profiles: ocx profile add <name>")
		}
	} catch (error) {
		spin?.fail("Failed to initialize")
		throw error
	}
}

async function runInitRegistry(directory: string | undefined, options: InitOptions): Promise<void> {
	const cwd = directory ?? options.cwd ?? process.cwd()
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

	if (hasVisibleFiles && !options.force) {
		throw new ConflictError("Directory is not empty. Use --force to overwrite existing files.")
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
			const version = options.canary ? "main" : await getLatestVersion()
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

async function getLatestVersion(): Promise<string> {
	const pkgPath = new URL("../../package.json", import.meta.url)
	const pkgContent = await readFile(pkgPath)
	const pkg = JSON.parse(pkgContent.toString())
	return `v${pkg.version}`
}

async function fetchAndExtractTemplate(
	destDir: string,
	version: string,
	verbose?: boolean,
): Promise<void> {
	const ref = version === "main" ? "heads/main" : `tags/${version}`
	const tarballUrl = `https://github.com/${TEMPLATE_REPO}/archive/refs/${ref}.tar.gz`

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
		content = content.replace(/Your Name/g, values.author)

		await writeFile(filePath, content)
	}
}

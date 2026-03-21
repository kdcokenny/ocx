/**
 * OCX CLI - init command
 * Initialize OCX configuration in a project or scaffold a new registry
 */

import { existsSync } from "node:fs"
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Command } from "commander"
import { OCX_SCHEMA_URL, REGISTRY_SCHEMA_LATEST_URL } from "../constants"
import { atomicWrite } from "../profile/atomic"
import { DEFAULT_OCX_CONFIG } from "../profile/manager"
import {
	getGlobalConfig,
	getProfileAgents,
	getProfileDir,
	getProfileOcxConfig,
	getProfileOpencodeConfig,
	getProfilesDir,
} from "../profile/paths"
import { findOcxConfig, ocxConfigSchema } from "../schemas/config"
import { ensureOpencodeConfig } from "../updaters/update-opencode-config"
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
}

export function registerInitCommand(program: Command): void {
	const cmd = program.command("init").description("Initialize OCX configuration in your project")

	addCommonOptions(cmd)
	addVerboseOption(cmd)
	addGlobalOption(cmd)

	cmd
		.option("--registry <path>", "Scaffold a new OCX registry project at path")
		.option("--namespace <name>", "Registry namespace (e.g., my-org)")
		.option("--author <name>", "Author name for the registry")
		.option("--canary", "Use canary (main branch) instead of latest release")
		.option("--local <path>", "Use local template directory instead of fetching")
		.action(async (options: InitOptions) => {
			try {
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
	const spin = options.quiet ? null : createSpinner({ text: "Initializing global profiles..." })
	spin?.start()

	try {
		const created: string[] = []
		const existed: string[] = []

		// 1. Create global base config (create-if-missing)
		const globalConfigPath = getGlobalConfig()
		if (existsSync(globalConfigPath)) {
			existed.push("globalConfig")
		} else {
			await mkdir(dirname(globalConfigPath), { recursive: true, mode: 0o700 })
			await atomicWrite(globalConfigPath, {
				$schema: OCX_SCHEMA_URL,
				registries: {},
			})
			created.push("globalConfig")
		}

		// 2. Create profiles directory (create-if-missing)
		const profilesDir = getProfilesDir()
		if (!existsSync(profilesDir)) {
			await mkdir(profilesDir, { recursive: true, mode: 0o700 })
		}

		// 3. Create default profile directory (create-if-missing)
		const profileDir = getProfileDir("default")
		if (!existsSync(profileDir)) {
			await mkdir(profileDir, { recursive: true, mode: 0o700 })
		}

		// 4. Check/create each profile file individually
		const ocxPath = getProfileOcxConfig("default")
		if (existsSync(ocxPath)) {
			existed.push("profileOcx")
		} else {
			await atomicWrite(ocxPath, DEFAULT_OCX_CONFIG)
			created.push("profileOcx")
		}

		const opencodePath = getProfileOpencodeConfig("default")
		if (existsSync(opencodePath)) {
			existed.push("profileOpencode")
		} else {
			await atomicWrite(opencodePath, {})
			created.push("profileOpencode")
		}

		const agentsPath = getProfileAgents("default")
		if (existsSync(agentsPath)) {
			existed.push("profileAgents")
		} else {
			const agentsContent = `# Profile Instructions

<!-- Add your custom instructions for this profile here -->
<!-- These will be included when running \`ocx opencode -p default\` -->
`
			await Bun.write(agentsPath, agentsContent, { mode: 0o600 })
			created.push("profileAgents")
		}

		spin?.succeed("Initialized global profiles")

		if (options.json) {
			console.log(
				JSON.stringify({
					success: true,
					files: {
						globalConfig: globalConfigPath,
						profileOcx: ocxPath,
						profileOpencode: opencodePath,
						profileAgents: agentsPath,
					},
					created,
					existed,
				}),
			)
		} else if (!options.quiet) {
			if (created.length > 0) {
				for (const key of created) {
					if (key === "globalConfig") logger.info(`Created global config: ${globalConfigPath}`)
					if (key === "profileOcx") logger.info(`Created profile config: ${ocxPath}`)
					if (key === "profileOpencode")
						logger.info(`Created profile opencode config: ${opencodePath}`)
					if (key === "profileAgents") logger.info(`Created profile instructions: ${agentsPath}`)
				}
				logger.info("")
				logger.info("Next steps:")
				logger.info("  1. Edit your profile config: ocx config edit -p default")
				logger.info("  2. Add registries: ocx registry add <url> --name <name> --global")
				logger.info("  3. Launch OpenCode: ocx opencode")
				logger.info("  4. Create more profiles: ocx profile add <name> --global")
			} else {
				logger.info("Global profiles already initialized (all files exist)")
			}
		}
	} catch (error) {
		spin?.fail("Failed to initialize")
		throw error
	}
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

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { Server } from "bun"

interface BuiltRegistryServer {
	server: Server<unknown>
	url: string
	stop: () => void
}

interface CLIResult {
	stdout: string
	stderr: string
	output: string
	exitCode: number
}

const repoRoot = resolve(import.meta.dir, "..", "..", "..")
const kdcoRegistrySourceDir = join(repoRoot, "workers", "kdco-registry")

async function runCLI(args: string[], cwd: string, timeout = 10000): Promise<CLIResult> {
	const indexPath = join(import.meta.dir, "..", "src", "index.ts")
	await mkdir(cwd, { recursive: true })

	const proc = Bun.spawn(["bun", "run", indexPath, ...args], {
		cwd,
		env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
		stdout: "pipe",
		stderr: "pipe",
	})

	const outputPromise = Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	])

	let timeoutId: ReturnType<typeof setTimeout> | undefined
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => {
			proc.kill()
			reject(new Error(`CLI timeout after ${timeout}ms`))
		}, timeout)
	})

	let exitCode: number
	try {
		exitCode = await Promise.race([proc.exited, timeoutPromise])
	} catch {
		const [stdout, stderr] = await outputPromise.catch(() => ["", ""])
		return {
			stdout,
			stderr,
			output: `${stdout + stderr}\n[TIMEOUT after ${timeout}ms]`,
			exitCode: 124,
		}
	} finally {
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId)
		}
	}

	const [stdout, stderr] = await outputPromise
	return {
		stdout,
		stderr,
		output: stdout + stderr,
		exitCode,
	}
}

async function createTempDir(prefix: string): Promise<string> {
	const directory = join(
		import.meta.dir,
		"fixtures",
		`tmp-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	)
	await mkdir(directory, { recursive: true })
	return directory
}

async function cleanupTempDir(directory: string): Promise<void> {
	await rm(directory, { recursive: true, force: true })
}

function startBuiltRegistryServer(distDir: string): BuiltRegistryServer {
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url)
			const requestPath = decodeURIComponent(url.pathname)
			const normalizedPath = requestPath === "/" ? "index.json" : requestPath.replace(/^\//, "")

			if (!normalizedPath || normalizedPath.includes("..")) {
				return new Response("Not Found", { status: 404 })
			}

			const filePath = join(distDir, normalizedPath)
			const file = Bun.file(filePath)

			if (!(await file.exists())) {
				return new Response("Not Found", { status: 404 })
			}

			return new Response(file)
		},
	})

	return {
		server,
		url: `http://localhost:${server.port}`,
		stop: () => server.stop(),
	}
}

describe("kdco/worktree registry packaging contract", () => {
	let buildDir = ""
	let distDir = ""
	let projectDir = ""

	beforeAll(async () => {
		buildDir = await mkdtemp(join(tmpdir(), "ocx-worktree-contract-"))
		distDir = join(buildDir, "dist")

		const buildResult = await runCLI(
			["build", kdcoRegistrySourceDir, "--out", distDir],
			buildDir,
			120000,
		)
		expect(buildResult.exitCode).toBe(0)
	})

	afterEach(async () => {
		if (projectDir) {
			await cleanupTempDir(projectDir)
			projectDir = ""
		}
	})

	afterAll(async () => {
		if (buildDir) {
			await rm(buildDir, { recursive: true, force: true })
		}
	})

	it("packages launch-context.ts in built worktree component output", () => {
		const builtLaunchContextPath = join(
			distDir,
			"components",
			"worktree",
			"plugins",
			"worktree",
			"launch-context.ts",
		)

		expect(existsSync(builtLaunchContextPath)).toBe(true)
	})

	it("keeps worktree manifest files in parity with ./worktree/* local imports", async () => {
		const registryContent = await readFile(join(kdcoRegistrySourceDir, "registry.jsonc"), "utf-8")
		const worktreeComponentMatch = registryContent.match(
			/"name"\s*:\s*"worktree"[\s\S]*?"files"\s*:\s*\[([\s\S]*?)\]/,
		)
		expect(worktreeComponentMatch).toBeTruthy()
		if (!worktreeComponentMatch || !worktreeComponentMatch[1]) {
			throw new Error("Expected worktree component files array in registry manifest")
		}

		const manifestFiles = new Set(
			Array.from(worktreeComponentMatch[1].matchAll(/"([^"]+)"/g), ([, filePath]) => filePath),
		)

		const worktreePluginSource = await readFile(
			join(kdcoRegistrySourceDir, "files", "plugins", "worktree.ts"),
			"utf-8",
		)
		const localWorktreeImports = Array.from(
			worktreePluginSource.matchAll(/from "\.\/worktree\/([^"]+)"/g),
			([, importPath]) => `plugins/worktree/${importPath}.ts`,
		)

		const missingManifestFiles = localWorktreeImports.filter(
			(filePath) => !manifestFiles.has(filePath),
		)
		expect(missingManifestFiles).toEqual([])
	})

	it("installs kdco/worktree from built output and initializes plugin tools", async () => {
		projectDir = await createTempDir("worktree-install-contract")
		const registryServer = startBuiltRegistryServer(distDir)

		try {
			const initResult = await runCLI(["init"], projectDir)
			expect(initResult.exitCode).toBe(0)

			await Bun.write(
				join(projectDir, ".opencode", "ocx.jsonc"),
				JSON.stringify(
					{
						$schema: "https://ocx.kdco.dev/schemas/ocx.json",
						registries: {
							kdco: { url: registryServer.url },
						},
					},
					null,
					2,
				),
			)

			const writtenConfig = JSON.parse(
				await readFile(join(projectDir, ".opencode", "ocx.jsonc"), "utf-8"),
			) as {
				registries: Record<string, { url: string }>
			}
			expect(writtenConfig.registries.kdco.url).toBe(registryServer.url)

			const installResult = await runCLI(["add", "kdco/worktree"], projectDir, 120000)
			if (installResult.exitCode !== 0) {
				throw new Error(`Expected install to succeed. Output:\n${installResult.output}`)
			}
			expect(installResult.exitCode).toBe(0)

			const installedLaunchContextPath = join(
				projectDir,
				".opencode",
				"plugins",
				"worktree",
				"launch-context.ts",
			)
			expect(existsSync(installedLaunchContextPath)).toBe(true)

			const installedPluginPath = join(projectDir, ".opencode", "plugins", "worktree.ts")
			expect(existsSync(installedPluginPath)).toBe(true)

			const pluginPackageDir = join(projectDir, "node_modules", "@opencode-ai", "plugin")
			await mkdir(pluginPackageDir, { recursive: true })
			await Bun.write(
				join(pluginPackageDir, "package.json"),
				JSON.stringify({ name: "@opencode-ai/plugin", type: "module" }, null, 2),
			)
			await Bun.write(
				join(pluginPackageDir, "index.js"),
				[
					"const createStringSchema = () => {",
					"  const chain = {",
					"    describe() { return chain },",
					"    optional() { return chain },",
					"  }",
					"  return chain",
					"}",
					"export const tool = Object.assign((definition) => definition, {",
					"  schema: {",
					"    string: createStringSchema,",
					"  },",
					"})",
				].join("\n"),
			)

			const zodPackageDir = join(projectDir, "node_modules", "zod")
			await mkdir(zodPackageDir, { recursive: true })
			await Bun.write(
				join(zodPackageDir, "package.json"),
				JSON.stringify({ name: "zod", type: "module" }, null, 2),
			)
			await Bun.write(
				join(zodPackageDir, "index.js"),
				[
					"const createSchema = () => {",
					"  const schema = {",
					"    min() { return schema },",
					"    max() { return schema },",
					"    refine() { return schema },",
					"    optional() { return schema },",
					"    default() { return schema },",
					"    describe() { return schema },",
					"    nullable() { return schema },",
					"    parse(value) { return value },",
					"    safeParse(value) { return { success: true, data: value } },",
					"  }",
					"  return schema",
					"}",
					"const literal = (expected) => ({",
					"  safeParse(value) {",
					"    return value === expected",
					"      ? { success: true, data: value }",
					"      : { success: false, error: { issues: [] } }",
					"  },",
					"})",
					"const createObjectSchema = () => createSchema()",
					"export const z = {",
					"  string: () => createSchema(),",
					"  object: createObjectSchema,",
					"  array: () => createSchema(),",
					"  enum: () => createSchema(),",
					"  union: () => createSchema(),",
					"  literal,",
					"}",
				].join("\n"),
			)

			const pluginModule = (await import(pathToFileURL(installedPluginPath).href)) as {
				default: (ctx: unknown) => Promise<{ tool: Record<string, unknown> }>
			}

			const plugin = await pluginModule.default({
				directory: projectDir,
				client: {
					app: {
						log: async () => undefined,
					},
				},
			})

			expect(Object.keys(plugin.tool).sort()).toEqual(["worktree_create", "worktree_delete"])
		} finally {
			registryServer.stop()
		}
	})
})

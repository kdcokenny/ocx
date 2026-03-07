import { describe, expect, it } from "bun:test"
import {
	chmod,
	copyFile,
	lstat,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises"
import { dirname, join } from "node:path"
import {
	applyOverlayCopyOperations,
	loadProjectOverlayPolicy,
	OPENCODE_MERGED_DIR_PREFIX,
	planOverlayCopyOperations,
	prepareMergedConfigDirForProfile,
} from "../src/commands/opencode-overlay"
import { EXIT_CODES } from "../src/utils/errors"
import { cleanupTempDir, createTempDir, runCLIIsolated } from "./helpers"

interface OpencodeCapturePayload {
	configDir: string
	disableProjectConfig: string | null
	files: string[]
	fileContents: Record<string, string>
}

async function createProfile(testDir: string, name: string): Promise<string> {
	const profileDir = join(testDir, "opencode", "profiles", name)
	await mkdir(profileDir, { recursive: true })
	await Bun.write(
		join(profileDir, "ocx.jsonc"),
		JSON.stringify({ registries: {}, profileMarker: "profile" }, null, 2),
	)
	return profileDir
}

async function createCaptureScript(testDir: string): Promise<string> {
	const scriptPath = join(testDir, "capture-opencode.ts")

	await Bun.write(
		scriptPath,
		[
			'import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs"',
			'import { join, relative } from "node:path"',
			"",
			"const outputPath = process.env.OCX_CAPTURE_OUTPUT_PATH",
			"if (!outputPath) {",
			'  throw new Error("OCX_CAPTURE_OUTPUT_PATH is required")',
			"}",
			"",
			"const configDir = process.env.OPENCODE_CONFIG_DIR ?? ''",
			"const files: string[] = []",
			"const fileContents: Record<string, string> = {}",
			"",
			"const walk = (dir: string) => {",
			"  const entries = readdirSync(dir).sort((a, b) => a.localeCompare(b))",
			"  for (const entry of entries) {",
			"    const absolutePath = join(dir, entry)",
			"    const relativePath = relative(configDir, absolutePath).replaceAll('\\\\', '/')",
			"    const stats = lstatSync(absolutePath)",
			"    if (stats.isDirectory()) {",
			"      walk(absolutePath)",
			"      continue",
			"    }",
			"",
			"    if (stats.isFile()) {",
			"      files.push(relativePath)",
			"      fileContents[relativePath] = readFileSync(absolutePath, 'utf8')",
			"      continue",
			"    }",
			"",
			"    if (stats.isSymbolicLink()) {",
			"      files.push(relativePath + '@symlink')",
			"    }",
			"  }",
			"}",
			"",
			"if (configDir && existsSync(configDir)) {",
			"  walk(configDir)",
			"}",
			"",
			"const payload = {",
			"  configDir,",
			"  disableProjectConfig: process.env.OPENCODE_DISABLE_PROJECT_CONFIG ?? null,",
			"  files,",
			"  fileContents,",
			"}",
			"",
			"await Bun.write(outputPath, JSON.stringify(payload, null, 2))",
		].join("\n"),
	)

	return scriptPath
}

async function runOcCapture(args: {
	testDir: string
	profileName?: string
	env?: Record<string, string | undefined>
	noRename?: boolean
}): Promise<{ result: Awaited<ReturnType<typeof runCLIIsolated>>; payloadPath: string }> {
	const scriptPath = await createCaptureScript(args.testDir)
	const payloadPath = join(args.testDir, "oc-capture.json")

	const profileArgs = args.profileName ? ["--profile", args.profileName] : []
	const renameArgs = args.noRename === false ? [] : ["--no-rename"]
	const result = await runCLIIsolated(
		["oc", ...renameArgs, ...profileArgs, scriptPath],
		args.testDir,
		{
			OPENCODE_BIN: "bun",
			OCX_CAPTURE_OUTPUT_PATH: payloadPath,
			...args.env,
		},
	)

	return { result, payloadPath }
}

async function readCapturePayload(payloadPath: string): Promise<OpencodeCapturePayload> {
	const text = await readFile(payloadPath, "utf8")
	return JSON.parse(text) as OpencodeCapturePayload
}

async function listMergedDirs(tmpRoot: string): Promise<string[]> {
	const entries = await readdir(tmpRoot)
	return entries.filter((entry) => entry.startsWith(OPENCODE_MERGED_DIR_PREFIX))
}

describe("opencode overlay planner", () => {
	it("uses TypeScript-style include/exclude matrix with include-wins overlap", () => {
		const candidates = [
			{ sourcePath: "/tmp/agents/alpha.md", overlayRelativePath: "agents/alpha.md" },
			{ sourcePath: "/tmp/agents/beta.md", overlayRelativePath: "agents/beta.md" },
			{ sourcePath: "/tmp/skills/gamma.md", overlayRelativePath: "skills/gamma.md" },
		]

		const cases = [
			{
				name: "default include-all",
				policy: { include: [], exclude: [] },
				expected: ["agents/alpha.md", "agents/beta.md", "skills/gamma.md"],
			},
			{
				name: "exclude deny-list",
				policy: { include: [], exclude: ["agents/**"] },
				expected: ["skills/gamma.md"],
			},
			{
				name: "include re-includes excluded path",
				policy: { include: ["agents/alpha.md"], exclude: ["agents/**"] },
				expected: ["agents/alpha.md", "skills/gamma.md"],
			},
			{
				name: "include wins overlap for nested folder",
				policy: {
					include: ["skills/gamma.md"],
					exclude: ["skills/**", "agents/beta.md"],
				},
				expected: ["agents/alpha.md", "skills/gamma.md"],
			},
		]

		for (const testCase of cases) {
			const plan = planOverlayCopyOperations(candidates, testCase.policy)
			expect(
				plan.map((step) => step.destinationRelativePath),
				testCase.name,
			).toEqual(testCase.expected)
		}
	})

	it("blocks traversal destinations at copy boundary", async () => {
		const testDir = await createTempDir("oc-overlay-traversal")
		try {
			const sourcePath = join(testDir, "source.md")
			const mergedDir = join(testDir, "merged")
			await mkdir(mergedDir, { recursive: true })
			await writeFile(sourcePath, "safe")

			await expect(
				applyOverlayCopyOperations(
					[
						{
							sourcePath,
							destinationRelativePath: "../../escape.md",
						},
					],
					mergedDir,
				),
			).rejects.toThrow(/validate error/i)
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("rejects root destination symlink and preserves outside target", async () => {
		const testDir = await createTempDir("oc-overlay-destination-root-symlink")
		try {
			const sourcePath = join(testDir, "source.md")
			const mergedDir = join(testDir, "merged")
			const outsideDir = join(testDir, "outside")
			const outsideTargetPath = join(outsideDir, "agent.md")

			await mkdir(mergedDir, { recursive: true })
			await mkdir(outsideDir, { recursive: true })
			await writeFile(sourcePath, "safe")
			await writeFile(outsideTargetPath, "outside-before")
			await symlink(outsideDir, join(mergedDir, "agents"))

			await expect(
				applyOverlayCopyOperations(
					[
						{
							sourcePath,
							destinationRelativePath: "agents/agent.md",
						},
					],
					mergedDir,
				),
			).rejects.toThrow(/validate error/i)

			expect(await readFile(outsideTargetPath, "utf8")).toBe("outside-before")
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("rejects nested destination symlink and preserves outside target", async () => {
		const testDir = await createTempDir("oc-overlay-destination-nested-symlink")
		try {
			const sourcePath = join(testDir, "source.md")
			const mergedDir = join(testDir, "merged")
			const outsideDir = join(testDir, "outside")
			const outsideTargetPath = join(outsideDir, "nested-agent.md")

			await mkdir(join(mergedDir, "agents"), { recursive: true })
			await mkdir(outsideDir, { recursive: true })
			await writeFile(sourcePath, "safe")
			await writeFile(outsideTargetPath, "outside-before")
			await symlink(outsideDir, join(mergedDir, "agents", "nested"))

			await expect(
				applyOverlayCopyOperations(
					[
						{
							sourcePath,
							destinationRelativePath: "agents/nested/nested-agent.md",
						},
					],
					mergedDir,
				),
			).rejects.toThrow(/validate error/i)

			expect(await readFile(outsideTargetPath, "utf8")).toBe("outside-before")
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("rejects existing destination leaf symlink and preserves outside target", async () => {
		const testDir = await createTempDir("oc-overlay-destination-leaf-symlink")
		try {
			const sourcePath = join(testDir, "source.md")
			const mergedDir = join(testDir, "merged")
			const outsideTargetPath = join(testDir, "outside-leaf.md")

			await mkdir(join(mergedDir, "agents"), { recursive: true })
			await writeFile(sourcePath, "safe")
			await writeFile(outsideTargetPath, "outside-before")
			await symlink(outsideTargetPath, join(mergedDir, "agents", "leaf.md"))

			await expect(
				applyOverlayCopyOperations(
					[
						{
							sourcePath,
							destinationRelativePath: "agents/leaf.md",
						},
					],
					mergedDir,
				),
			).rejects.toThrow(/validate error/i)

			expect(await readFile(outsideTargetPath, "utf8")).toBe("outside-before")
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("allows overlay copy into normal real destination directories", async () => {
		const testDir = await createTempDir("oc-overlay-destination-real-directories")
		try {
			const sourcePath = join(testDir, "source.md")
			const mergedDir = join(testDir, "merged")
			const destinationPath = join(mergedDir, "agents", "new", "path", "agent.md")

			await mkdir(join(mergedDir, "agents"), { recursive: true })
			await writeFile(sourcePath, "safe")

			await applyOverlayCopyOperations(
				[
					{
						sourcePath,
						destinationRelativePath: "agents/new/path/agent.md",
					},
				],
				mergedDir,
			)

			expect(await readFile(destinationPath, "utf8")).toBe("safe")
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("uses injected atomic publication seam for destination writes", async () => {
		const testDir = await createTempDir("oc-overlay-atomic-publication-seam")
		try {
			const sourcePath = join(testDir, "source.md")
			const mergedDir = join(testDir, "merged")
			const destinationPath = join(mergedDir, "agents", "agent.md")
			const seamCalls: Array<{ sourcePath: string; destinationPath: string }> = []

			await mkdir(join(mergedDir, "agents"), { recursive: true })
			await writeFile(sourcePath, "safe")

			await applyOverlayCopyOperations(
				[
					{
						sourcePath,
						destinationRelativePath: "agents/agent.md",
					},
				],
				mergedDir,
				{
					publishAtomically: async (capturedSourcePath, capturedDestinationPath) => {
						seamCalls.push({
							sourcePath: capturedSourcePath,
							destinationPath: capturedDestinationPath,
						})
						await copyFile(capturedSourcePath, capturedDestinationPath)
					},
				},
			)

			expect(seamCalls).toEqual([
				{
					sourcePath,
					destinationPath,
				},
			])
			expect(await readFile(destinationPath, "utf8")).toBe("safe")
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("removes temp publication sibling when atomic rename fails", async () => {
		const testDir = await createTempDir("oc-overlay-atomic-publication-cleanup")
		try {
			const sourcePath = join(testDir, "source.md")
			const mergedDir = join(testDir, "merged")
			const destinationDirPath = join(mergedDir, "agents")
			const destinationPath = join(destinationDirPath, "agent.md")

			await mkdir(destinationPath, { recursive: true })
			await writeFile(sourcePath, "safe")

			await expect(
				applyOverlayCopyOperations(
					[
						{
							sourcePath,
							destinationRelativePath: "agents/agent.md",
						},
					],
					mergedDir,
				),
			).rejects.toThrow(/copy error/i)

			const destinationStats = await lstat(destinationPath)
			expect(destinationStats.isDirectory()).toBe(true)

			const destinationSiblings = await readdir(destinationDirPath)
			expect(destinationSiblings.filter((name) => name.startsWith(".agent.md.ocx-tmp-"))).toEqual(
				[],
			)
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("detects deterministic destination ancestor swap before parent mkdir", async () => {
		const testDir = await createTempDir("oc-overlay-destination-swap-before-parent-mkdir")
		try {
			const sourcePath = join(testDir, "source.md")
			const mergedDir = join(testDir, "merged")
			const outsideDir = join(testDir, "outside")
			const outsideNestedPath = join(outsideDir, "nested")
			const outsideTargetPath = join(outsideDir, "agent.md")

			await mkdir(join(mergedDir, "agents"), { recursive: true })
			await mkdir(outsideDir, { recursive: true })
			await writeFile(sourcePath, "safe")
			await writeFile(outsideTargetPath, "outside-before")

			let didSwapDestinationAncestor = false
			await expect(
				applyOverlayCopyOperations(
					[
						{
							sourcePath,
							destinationRelativePath: "agents/nested/agent.md",
						},
					],
					mergedDir,
					{
						beforeDestinationParentCreate: async ({ destinationParentPath }) => {
							if (didSwapDestinationAncestor) {
								return
							}

							didSwapDestinationAncestor = true
							const destinationAncestorPath = dirname(destinationParentPath)
							await rm(destinationAncestorPath, { recursive: true, force: true })
							await symlink(outsideDir, destinationAncestorPath)
						},
					},
				),
			).rejects.toThrow(/validate error/i)

			expect(didSwapDestinationAncestor).toBe(true)
			expect(await readFile(outsideTargetPath, "utf8")).toBe("outside-before")
			await expect(lstat(outsideNestedPath)).rejects.toMatchObject({ code: "ENOENT" })
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("fails closed when native-fd hardening mode is required without helper support", async () => {
		const testDir = await createTempDir("oc-overlay-native-required-no-helper")
		try {
			const profileDir = await createProfile(testDir, "work")
			const localConfigDir = join(testDir, ".opencode")
			await mkdir(join(localConfigDir, "agents"), { recursive: true })
			await writeFile(
				join(localConfigDir, "ocx.jsonc"),
				JSON.stringify({ profile: "work" }, null, 2),
			)
			await writeFile(join(localConfigDir, "agents", "agent.md"), "project-agent")

			await expect(
				prepareMergedConfigDirForProfile({
					projectDir: testDir,
					profileDir,
					hardeningMode: "native-fd-required",
				}),
			).rejects.toThrow(/Native fd helper required for overlay merge/i)
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("allows native-fd-required mode when overlay manifest is empty", async () => {
		const testDir = await createTempDir("oc-overlay-native-required-empty-manifest")
		let prepared: Awaited<ReturnType<typeof prepareMergedConfigDirForProfile>> | null = null
		try {
			const profileDir = await createProfile(testDir, "work")
			const localConfigDir = join(testDir, ".opencode")
			await mkdir(localConfigDir, { recursive: true })
			await writeFile(
				join(localConfigDir, "ocx.jsonc"),
				JSON.stringify({ profile: "work" }, null, 2),
			)

			prepared = await prepareMergedConfigDirForProfile({
				projectDir: testDir,
				profileDir,
				hardeningMode: "native-fd-required",
			})

			expect(prepared.hardeningLevel).toBe("best-effort-js")
			expect(await readFile(join(prepared.path, "ocx.jsonc"), "utf8")).toContain("profileMarker")
		} finally {
			if (prepared) {
				await prepared.cleanup()
			}
			await cleanupTempDir(testDir)
		}
	})

	it("passes parsed relative manifest operations to injected native helper contract", async () => {
		const testDir = await createTempDir("oc-overlay-native-helper-contract")
		try {
			const profileDir = await createProfile(testDir, "work")
			const localConfigDir = join(testDir, ".opencode")
			await mkdir(join(localConfigDir, "agents"), { recursive: true })
			await writeFile(
				join(localConfigDir, "ocx.jsonc"),
				JSON.stringify({ profile: "work" }, null, 2),
			)
			await writeFile(join(localConfigDir, "agents", "agent.md"), "project-agent")

			const helperCalls: Array<{ sourceRelativePath: string; destinationRelativePath: string }> = []

			const prepared = await prepareMergedConfigDirForProfile({
				projectDir: testDir,
				profileDir,
				seams: {
					nativeHelper: {
						name: "test-native-helper",
						applyManifest: async (manifest, mergedConfigDir) => {
							helperCalls.push(
								...manifest.operations.map((operation) => ({
									sourceRelativePath: operation.sourceRelativePath,
									destinationRelativePath: operation.destinationRelativePath,
								})),
							)

							for (const operation of manifest.operations) {
								const sourcePath = join(manifest.projectConfigDir, operation.sourceRelativePath)
								const destinationPath = join(mergedConfigDir, operation.destinationRelativePath)
								await mkdir(dirname(destinationPath), { recursive: true })
								await copyFile(sourcePath, destinationPath)
							}
						},
					},
				},
			})

			try {
				expect(prepared.hardeningLevel).toBe("native-fd")
				expect(helperCalls).toContainEqual({
					sourceRelativePath: "agents/agent.md",
					destinationRelativePath: "agents/agent.md",
				})
				expect(await readFile(join(prepared.path, "agents", "agent.md"), "utf8")).toBe(
					"project-agent",
				)
			} finally {
				await prepared.cleanup()
			}
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("detects deterministic project overlay root swap during discovery", async () => {
		const testDir = await createTempDir("oc-overlay-root-swap-during-discovery")
		try {
			const profileDir = await createProfile(testDir, "work")
			const localConfigDir = join(testDir, ".opencode")
			const originalConfigDirBackup = join(testDir, ".opencode-before-swap")
			const outsideConfigDir = join(testDir, "outside-config")

			await mkdir(join(localConfigDir, "agents"), { recursive: true })
			await writeFile(
				join(localConfigDir, "ocx.jsonc"),
				JSON.stringify({ profile: "work" }, null, 2),
			)
			await writeFile(join(localConfigDir, "agents", "agent.md"), "project-agent")

			await mkdir(join(outsideConfigDir, "agents"), { recursive: true })
			await writeFile(join(outsideConfigDir, "agents", "outside.md"), "outside-agent")

			let didSwapRoot = false
			await expect(
				prepareMergedConfigDirForProfile({
					projectDir: testDir,
					profileDir,
					seams: {
						collection: {
							beforeScopeInspect: async () => {
								if (didSwapRoot) {
									return
								}

								didSwapRoot = true
								await rename(localConfigDir, originalConfigDirBackup)
								await symlink(outsideConfigDir, localConfigDir)
							},
						},
					},
				}),
			).rejects.toThrow(/Overlay path changed during overlay discovery/i)

			expect(didSwapRoot).toBe(true)
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("detects deterministic ancestor directory swap during discovery", async () => {
		const testDir = await createTempDir("oc-overlay-ancestor-swap-during-discovery")
		try {
			const profileDir = await createProfile(testDir, "work")
			const localConfigDir = join(testDir, ".opencode")
			const nestedDir = join(localConfigDir, "agents", "nested")
			const outsideDirectory = join(testDir, "outside-discovery")

			await mkdir(nestedDir, { recursive: true })
			await writeFile(
				join(localConfigDir, "ocx.jsonc"),
				JSON.stringify({ profile: "work" }, null, 2),
			)
			await writeFile(join(nestedDir, "agent.md"), "nested-agent")

			await mkdir(outsideDirectory, { recursive: true })
			await writeFile(join(outsideDirectory, "outside.md"), "outside-agent")

			let didSwapAncestor = false
			await expect(
				prepareMergedConfigDirForProfile({
					projectDir: testDir,
					profileDir,
					seams: {
						collection: {
							beforeDirectoryRead: async (context: {
								absolutePath: string
								overlayRelativePath: string
							}) => {
								const { absolutePath, overlayRelativePath } = context
								if (didSwapAncestor || overlayRelativePath !== "agents/nested") {
									return
								}

								didSwapAncestor = true
								await rm(absolutePath, { recursive: true, force: true })
								await symlink(outsideDirectory, absolutePath)
							},
						},
					},
				}),
			).rejects.toThrow(/Overlay path changed during overlay discovery/i)

			expect(didSwapAncestor).toBe(true)
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("detects deterministic source swap between discovery and publish", async () => {
		const testDir = await createTempDir("oc-overlay-source-swap-before-copy")
		try {
			const profileDir = await createProfile(testDir, "work")
			const localConfigDir = join(testDir, ".opencode")
			const sourcePath = join(localConfigDir, "agents", "agent.md")
			const outsideSourcePath = join(testDir, "outside-source.md")

			await mkdir(join(localConfigDir, "agents"), { recursive: true })
			await writeFile(
				join(localConfigDir, "ocx.jsonc"),
				JSON.stringify({ profile: "work" }, null, 2),
			)
			await writeFile(sourcePath, "project-agent")
			await writeFile(outsideSourcePath, "outside-agent")

			let didSwapSource = false
			await expect(
				prepareMergedConfigDirForProfile({
					projectDir: testDir,
					profileDir,
					seams: {
						copy: {
							beforeSourceVerification: async (operation: {
								sourcePath: string
								destinationRelativePath: string
							}) => {
								if (didSwapSource || operation.destinationRelativePath !== "agents/agent.md") {
									return
								}

								didSwapSource = true
								await rm(operation.sourcePath, { force: true })
								await symlink(outsideSourcePath, operation.sourcePath)
							},
						},
					},
				}),
			).rejects.toThrow(/Overlay path changed during overlay source verification/i)

			expect(didSwapSource).toBe(true)
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("detects deterministic destination ancestor swap before publish", async () => {
		const testDir = await createTempDir("oc-overlay-destination-swap-before-publish")
		try {
			const sourcePath = join(testDir, "source.md")
			const mergedDir = join(testDir, "merged")
			const outsideDir = join(testDir, "outside")
			const outsideTargetPath = join(outsideDir, "agent.md")

			await mkdir(join(mergedDir, "agents"), { recursive: true })
			await mkdir(outsideDir, { recursive: true })
			await writeFile(sourcePath, "safe")
			await writeFile(outsideTargetPath, "outside-before")

			let didSwapDestination = false
			await expect(
				applyOverlayCopyOperations(
					[
						{
							sourcePath,
							destinationRelativePath: "agents/agent.md",
						},
					],
					mergedDir,
					{
						beforeDestinationPublish: async ({ destinationParentPath }) => {
							if (didSwapDestination) {
								return
							}

							didSwapDestination = true
							await rm(destinationParentPath, { recursive: true, force: true })
							await symlink(outsideDir, destinationParentPath)
						},
					},
				),
			).rejects.toThrow(/Overlay path changed during overlay destination publish/i)

			expect(didSwapDestination).toBe(true)
			expect(await readFile(outsideTargetPath, "utf8")).toBe("outside-before")
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("maps parse/read/validate failures for project overlay policy", async () => {
		const testDir = await createTempDir("oc-overlay-policy-errors")
		try {
			const localConfigDir = join(testDir, ".opencode")
			await mkdir(localConfigDir, { recursive: true })

			// Parse error
			await writeFile(join(localConfigDir, "ocx.jsonc"), '{ "include": ["agents/**"]')
			await expect(loadProjectOverlayPolicy(localConfigDir)).rejects.toThrow(/parse error/i)

			// Validate error (invalid schema shape)
			await writeFile(
				join(localConfigDir, "ocx.jsonc"),
				JSON.stringify({ include: 42, exclude: [] }, null, 2),
			)
			await expect(loadProjectOverlayPolicy(localConfigDir)).rejects.toThrow(/validate error/i)

			// Read error
			await chmod(join(localConfigDir, "ocx.jsonc"), 0)
			await expect(loadProjectOverlayPolicy(localConfigDir)).rejects.toThrow(/read error/i)
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("falls back to default policy when project overlay policy file is missing", async () => {
		const testDir = await createTempDir("oc-overlay-policy-missing")
		try {
			const localConfigDir = join(testDir, ".opencode")
			await mkdir(localConfigDir, { recursive: true })

			const policy = await loadProjectOverlayPolicy(localConfigDir)
			expect(policy).toEqual({ include: [], exclude: [] })
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("rejects project overlay policy symlink that escapes project scope", async () => {
		const testDir = await createTempDir("oc-overlay-policy-symlink-escape")
		try {
			const localConfigDir = join(testDir, ".opencode")
			await mkdir(localConfigDir, { recursive: true })

			const outsidePolicyPath = join(testDir, "outside-policy.jsonc")
			await writeFile(outsidePolicyPath, JSON.stringify({ include: ["agents/**"] }, null, 2))
			await symlink(outsidePolicyPath, join(localConfigDir, "ocx.jsonc"))

			await expect(loadProjectOverlayPolicy(localConfigDir)).rejects.toThrow(
				/Symlink escapes project overlay policy scope/i,
			)
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("fails loud on broken project overlay policy symlink", async () => {
		const testDir = await createTempDir("oc-overlay-policy-broken-symlink")
		try {
			const localConfigDir = join(testDir, ".opencode")
			await mkdir(localConfigDir, { recursive: true })

			await symlink(join(testDir, "missing-policy.jsonc"), join(localConfigDir, "ocx.jsonc"))

			await expect(loadProjectOverlayPolicy(localConfigDir)).rejects.toThrow(
				/Broken symlink in project overlay policy/i,
			)
		} finally {
			await cleanupTempDir(testDir)
		}
	})
})

describe("ocx oc profile overlay integration", () => {
	it("merges project agents/skills over profile with no leakage beyond overlay scope", async () => {
		const testDir = await createTempDir("oc-overlay-visibility")
		try {
			const profileDir = await createProfile(testDir, "work")
			await mkdir(join(profileDir, "agents"), { recursive: true })
			await mkdir(join(profileDir, "skills"), { recursive: true })
			await Bun.write(join(profileDir, "agents", "profile-agent.md"), "profile-agent")
			await Bun.write(join(profileDir, "skills", "profile-skill.md"), "profile-skill")

			const localConfigDir = join(testDir, ".opencode")
			await mkdir(join(localConfigDir, "agents"), { recursive: true })
			await mkdir(join(localConfigDir, "skills"), { recursive: true })
			await mkdir(join(localConfigDir, "notes"), { recursive: true })
			await Bun.write(
				join(localConfigDir, "ocx.jsonc"),
				JSON.stringify(
					{ profile: "work", include: [], exclude: [], projectMarker: "project" },
					null,
					2,
				),
			)
			await Bun.write(join(localConfigDir, "agents", "project-agent.md"), "project-agent")
			await Bun.write(join(localConfigDir, "skills", "project-skill.md"), "project-skill")
			await Bun.write(join(localConfigDir, "notes", "should-not-leak.md"), "no-leak")

			const { result, payloadPath } = await runOcCapture({ testDir, profileName: "work" })
			expect(result.exitCode).toBe(0)

			const payload = await readCapturePayload(payloadPath)
			expect(payload.disableProjectConfig).toBe("true")
			expect(payload.configDir).not.toBe(profileDir)
			expect(payload.files).toContain("agents/profile-agent.md")
			expect(payload.files).toContain("skills/profile-skill.md")
			expect(payload.files).toContain("agents/project-agent.md")
			expect(payload.files).toContain("skills/project-skill.md")
			expect(payload.files).not.toContain("notes/should-not-leak.md")
			expect(payload.fileContents["ocx.jsonc"] ?? "").toContain("profileMarker")
			expect(payload.fileContents["ocx.jsonc"] ?? "").not.toContain("projectMarker")
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("uses project .opencode/ocx.jsonc include/exclude policy with include-wins overlap", async () => {
		const testDir = await createTempDir("oc-overlay-policy")
		try {
			await createProfile(testDir, "work")

			const localConfigDir = join(testDir, ".opencode")
			await mkdir(join(localConfigDir, "agents"), { recursive: true })
			await mkdir(join(localConfigDir, "skills"), { recursive: true })
			await Bun.write(
				join(localConfigDir, "ocx.jsonc"),
				JSON.stringify(
					{
						profile: "work",
						exclude: ["agents/**", "skills/**"],
						include: ["agents/keep.md"],
					},
					null,
					2,
				),
			)
			await Bun.write(join(localConfigDir, "agents", "keep.md"), "keep")
			await Bun.write(join(localConfigDir, "agents", "drop.md"), "drop")
			await Bun.write(join(localConfigDir, "skills", "drop.md"), "drop")

			const { result, payloadPath } = await runOcCapture({ testDir, profileName: "work" })
			expect(result.exitCode).toBe(0)

			const payload = await readCapturePayload(payloadPath)
			expect(payload.files).toContain("agents/keep.md")
			expect(payload.files).not.toContain("agents/drop.md")
			expect(payload.files).not.toContain("skills/drop.md")
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("uses project file on collisions over profile base", async () => {
		const testDir = await createTempDir("oc-overlay-collision")
		try {
			const profileDir = await createProfile(testDir, "work")
			await mkdir(join(profileDir, "agents"), { recursive: true })
			await Bun.write(join(profileDir, "agents", "shared.md"), "from-profile")

			const localConfigDir = join(testDir, ".opencode")
			await mkdir(join(localConfigDir, "agents"), { recursive: true })
			await Bun.write(
				join(localConfigDir, "ocx.jsonc"),
				JSON.stringify({ profile: "work" }, null, 2),
			)
			await Bun.write(join(localConfigDir, "agents", "shared.md"), "from-project")

			const { result, payloadPath } = await runOcCapture({ testDir, profileName: "work" })
			expect(result.exitCode).toBe(0)

			const payload = await readCapturePayload(payloadPath)
			expect(payload.fileContents["agents/shared.md"]).toBe("from-project")
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("keeps no-profile behavior unchanged", async () => {
		const testDir = await createTempDir("oc-overlay-no-profile")
		try {
			const localConfigDir = join(testDir, ".opencode")
			await mkdir(join(localConfigDir, "agents"), { recursive: true })
			await Bun.write(join(localConfigDir, "agents", "local-agent.md"), "local")

			const { result, payloadPath } = await runOcCapture({ testDir })
			expect(result.exitCode).toBe(0)

			const payload = await readCapturePayload(payloadPath)
			expect(payload.disableProjectConfig).toBeNull()
			expect(payload.configDir).toBe(join(testDir, "opencode"))
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("does not forward stale OPENCODE_DISABLE_PROJECT_CONFIG in no-profile mode", async () => {
		const testDir = await createTempDir("oc-overlay-no-profile-stale-disable-flag")
		try {
			const localConfigDir = join(testDir, ".opencode")
			await mkdir(join(localConfigDir, "agents"), { recursive: true })
			await Bun.write(join(localConfigDir, "agents", "local-agent.md"), "local")

			const { result, payloadPath } = await runOcCapture({
				testDir,
				env: {
					OPENCODE_DISABLE_PROJECT_CONFIG: "true",
				},
			})
			expect(result.exitCode).toBe(0)

			const payload = await readCapturePayload(payloadPath)
			expect(payload.disableProjectConfig).toBeNull()
			expect(payload.configDir).toBe(join(testDir, "opencode"))
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("fails fast on symlink escape in overlay scope", async () => {
		const testDir = await createTempDir("oc-overlay-symlink-escape")
		try {
			await createProfile(testDir, "work")

			const outsidePath = join(testDir, "outside.md")
			await Bun.write(outsidePath, "outside")

			const localConfigDir = join(testDir, ".opencode")
			await mkdir(join(localConfigDir, "agents"), { recursive: true })
			await Bun.write(
				join(localConfigDir, "ocx.jsonc"),
				JSON.stringify({ profile: "work" }, null, 2),
			)
			await symlink(outsidePath, join(localConfigDir, "agents", "escape.md"))

			const { result } = await runOcCapture({ testDir, profileName: "work" })
			expect(result.exitCode).toBe(EXIT_CODES.CONFIG)
			expect(result.output).toContain("ocx oc validate error")
			expect(result.output).toContain("Symlink escapes project overlay scope")
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("fails fast on broken symlink in overlay scope", async () => {
		const testDir = await createTempDir("oc-overlay-broken-symlink")
		try {
			await createProfile(testDir, "work")

			const localConfigDir = join(testDir, ".opencode")
			await mkdir(join(localConfigDir, "skills"), { recursive: true })
			await Bun.write(
				join(localConfigDir, "ocx.jsonc"),
				JSON.stringify({ profile: "work" }, null, 2),
			)
			await symlink(join(testDir, "missing-target.md"), join(localConfigDir, "skills", "broken.md"))

			const { result } = await runOcCapture({ testDir, profileName: "work" })
			expect(result.exitCode).toBe(EXIT_CODES.CONFIG)
			expect(result.output).toContain("ocx oc validate error")
			expect(result.output).toContain("Broken symlink in project overlay scope")
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("fails fast when project .opencode root resolves outside project", async () => {
		const testDir = await createTempDir("oc-overlay-root-symlink-escape")
		const outsideConfigDir = await createTempDir("oc-overlay-root-symlink-target")
		try {
			await createProfile(testDir, "work")

			await mkdir(join(outsideConfigDir, "agents"), { recursive: true })
			await Bun.write(
				join(outsideConfigDir, "ocx.jsonc"),
				JSON.stringify({ profile: "work" }, null, 2),
			)
			await Bun.write(join(outsideConfigDir, "agents", "outside-agent.md"), "outside-agent")

			await symlink(outsideConfigDir, join(testDir, ".opencode"))

			const { result } = await runOcCapture({ testDir, profileName: "work" })
			expect(result.exitCode).toBe(EXIT_CODES.CONFIG)
			expect(result.output).toContain("ocx oc validate error")
			expect(result.output).toContain("Project .opencode root resolves outside project directory")
		} finally {
			await cleanupTempDir(outsideConfigDir)
			await cleanupTempDir(testDir)
		}
	})

	it("fails with validate mapping for malformed local overlay policy", async () => {
		const testDir = await createTempDir("oc-overlay-malformed-policy")
		try {
			await createProfile(testDir, "work")

			const localConfigDir = join(testDir, ".opencode")
			await mkdir(localConfigDir, { recursive: true })
			await Bun.write(
				join(localConfigDir, "ocx.jsonc"),
				JSON.stringify({ profile: "work", exclude: 42 }, null, 2),
			)

			const { result } = await runOcCapture({ testDir, profileName: "work" })
			expect(result.exitCode).toBe(EXIT_CODES.CONFIG)
			expect(result.output).toContain("ocx oc validate error")
			expect(result.output).toContain("exclude")
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("fails when local .opencode/ocx.jsonc is unreadable", async () => {
		const testDir = await createTempDir("oc-overlay-unreadable-policy")
		try {
			await createProfile(testDir, "work")

			const localConfigDir = join(testDir, ".opencode")
			await mkdir(localConfigDir, { recursive: true })
			const localPolicyPath = join(localConfigDir, "ocx.jsonc")
			await Bun.write(localPolicyPath, JSON.stringify({ profile: "work" }, null, 2))
			await chmod(localPolicyPath, 0)

			const { result } = await runOcCapture({ testDir, profileName: "work" })
			expect(result.exitCode).toBe(EXIT_CODES.CONFIG)
			expect(result.output).toContain("Failed to read local config")
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("cleans merged temp dir when spawn fails", async () => {
		const testDir = await createTempDir("oc-overlay-spawn-cleanup")
		try {
			await createProfile(testDir, "work")

			const tmpRoot = join(testDir, "tmp")
			await mkdir(tmpRoot, { recursive: true })

			const localConfigDir = join(testDir, ".opencode")
			await mkdir(join(localConfigDir, "agents"), { recursive: true })
			await Bun.write(
				join(localConfigDir, "ocx.jsonc"),
				JSON.stringify({ profile: "work" }, null, 2),
			)
			await Bun.write(join(localConfigDir, "agents", "agent.md"), "agent")

			const { result } = await runOcCapture({
				testDir,
				profileName: "work",
				env: {
					TMPDIR: tmpRoot,
					OPENCODE_BIN: "/definitely/missing/opencode-binary",
				},
			})

			expect(result.exitCode).toBe(EXIT_CODES.CONFIG)
			expect(result.output).toContain("ocx oc spawn error")

			const leftovers = await listMergedDirs(tmpRoot)
			expect(leftovers).toEqual([])
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("cleans merged temp dir when copy fails before spawn", async () => {
		const testDir = await createTempDir("oc-overlay-copy-cleanup")
		try {
			await createProfile(testDir, "work")

			const tmpRoot = join(testDir, "tmp")
			await mkdir(tmpRoot, { recursive: true })

			const localConfigDir = join(testDir, ".opencode")
			await mkdir(join(localConfigDir, "agents"), { recursive: true })
			await Bun.write(
				join(localConfigDir, "ocx.jsonc"),
				JSON.stringify({ profile: "work" }, null, 2),
			)
			const unreadablePath = join(localConfigDir, "agents", "unreadable.md")
			await Bun.write(unreadablePath, "secret")
			await chmod(unreadablePath, 0)

			const { result } = await runOcCapture({
				testDir,
				profileName: "work",
				env: {
					TMPDIR: tmpRoot,
				},
			})

			expect(result.exitCode).toBe(EXIT_CODES.CONFIG)
			expect(result.output).toContain("ocx oc copy error")

			const leftovers = await listMergedDirs(tmpRoot)
			expect(leftovers).toEqual([])
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("cleans merged temp dir when destination symlink validation fails", async () => {
		const testDir = await createTempDir("oc-overlay-destination-symlink-cleanup")
		try {
			const profileDir = await createProfile(testDir, "work")

			const outsideDir = join(testDir, "outside")
			await mkdir(outsideDir, { recursive: true })
			const outsideTargetPath = join(outsideDir, "agent.md")
			await Bun.write(outsideTargetPath, "outside-before")
			await symlink(outsideDir, join(profileDir, "agents"))

			const tmpRoot = join(testDir, "tmp")
			await mkdir(tmpRoot, { recursive: true })

			const localConfigDir = join(testDir, ".opencode")
			await mkdir(join(localConfigDir, "agents"), { recursive: true })
			await Bun.write(
				join(localConfigDir, "ocx.jsonc"),
				JSON.stringify({ profile: "work" }, null, 2),
			)
			await Bun.write(join(localConfigDir, "agents", "agent.md"), "from-project")

			const { result } = await runOcCapture({
				testDir,
				profileName: "work",
				env: {
					TMPDIR: tmpRoot,
				},
			})

			expect(result.exitCode).toBe(EXIT_CODES.CONFIG)
			expect(result.output).toContain("ocx oc validate error")
			expect(result.output).not.toContain("ocx oc copy error")
			expect(await readFile(outsideTargetPath, "utf8")).toBe("outside-before")

			const leftovers = await listMergedDirs(tmpRoot)
			expect(leftovers).toEqual([])
		} finally {
			await cleanupTempDir(testDir)
		}
	})

	it("cleans merged temp dir when pre-spawn setup fails", async () => {
		const testDir = await createTempDir("oc-overlay-pre-spawn-cleanup")
		try {
			await createProfile(testDir, "work")

			const tmpRoot = join(testDir, "tmp")
			await mkdir(tmpRoot, { recursive: true })

			const localConfigDir = join(testDir, ".opencode")
			await mkdir(join(localConfigDir, "agents"), { recursive: true })
			await Bun.write(
				join(localConfigDir, "ocx.jsonc"),
				JSON.stringify({ profile: "work" }, null, 2),
			)
			await Bun.write(join(localConfigDir, "agents", "agent.md"), "agent")

			const fakeBinDir = join(testDir, "fake-bin")
			await mkdir(fakeBinDir, { recursive: true })
			const bunShimPath = join(fakeBinDir, "bun")
			await writeFile(bunShimPath, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`)
			await chmod(bunShimPath, 0o755)

			const { result } = await runOcCapture({
				testDir,
				profileName: "work",
				noRename: false,
				env: {
					TMPDIR: tmpRoot,
					PATH: fakeBinDir,
					OPENCODE_BIN: process.execPath,
				},
			})

			expect(result.exitCode).not.toBe(0)

			const leftovers = await listMergedDirs(tmpRoot)
			expect(leftovers).toEqual([])
		} finally {
			await cleanupTempDir(testDir)
		}
	})
})

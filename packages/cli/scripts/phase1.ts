import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises"
import { cpus, tmpdir } from "node:os"
import { delimiter, dirname, join, relative, resolve, sep } from "node:path"
import { gunzipSync } from "node:zlib"

type ToolingCommand = "all" | "pack" | "inspect" | "verify" | "benchmark"

interface CommandResult {
	stdout: string
	stderr: string
	exitCode: number
	durationMs: number
}

interface BaselineEnvironment {
	platform: NodeJS.Platform
	arch: string
	nodeVersion: string
	bunVersion: string
	cpuModel: string
}

interface ContractManifest {
	schemaVersion: number
	packageName: string
	supportedContract: {
		bin: {
			name: string
			packageJsonPath: string
		}
		entrypoints: {
			importSpecifiers: string[]
			moduleFormat: "esm"
			main: string
		}
		runtimeExports: string[]
		importSideEffects: {
			bareImportStdoutExact: string
			bareImportStderrExact: string
		}
		cliMatrix: CliMatrixCase[]
	}
	observedPublishShape: {
		packedPackageJson: {
			type: string
			main: string
			bin: Record<string, string>
			files: string[]
			exports: null
			types: null
		}
		requiredTarEntries: string[]
		disallowedTarEntryPatterns: string[]
		sourcemapPolicy: {
			classification: "observed-publish-shape"
			notes: string
		}
	}
}

interface CliMatrixCase {
	id: string
	args: string[]
	expect: {
		exitCode: number
		stdoutExact?: string
		stderrExact?: string
		stdoutContains?: string[]
		stderrContains?: string[]
		stdoutRegex?: string
		stderrRegex?: string
	}
}

interface NpmPackFileEntry {
	path: string
	size: number
	mode: number
}

interface NpmPackJsonEntry {
	id: string
	name: string
	version: string
	size: number
	unpackedSize: number
	shasum: string
	integrity: string
	filename: string
	files: NpmPackFileEntry[]
	entryCount: number
	bundled: string[]
}

interface InstalledSandbox {
	rootDir: string
	installDir: string
	cleanCwd: string
	env: Record<string, string>
	commandName: string
	installedBinContract: {
		commandName: string
		resolvedFromPath: string
		shimPath: string
		shimType: "symlink" | "file"
		shimTarget: string | null
		shimMode: string
		shimExecutable: boolean
		packageBinPath: string
		packageBinShebang: string
		packageBinMode: string
		packageBinExecutable: boolean
	}
}

interface TarArchiveEntry {
	path: string
	sizeBytes: number
	mode: number
	type: "file" | "directory" | "symlink" | "other"
	content: Uint8Array
	linkPath: string | null
}

const PACKAGE_DIR = resolve(import.meta.dir, "..")
const PHASE1_DIR = join(PACKAGE_DIR, "phase1")
const BASELINE_DIR = join(PHASE1_DIR, "baselines")
const ARTIFACT_DIR = join(PHASE1_DIR, "artifacts")
const CONTRACT_PATH = join(PHASE1_DIR, "contract.manifest.json")

const BASELINE_OUTPUT_PATHS = {
	packShape: join(BASELINE_DIR, "publish-shape.latest.json"),
	contractVerification: join(BASELINE_DIR, "contract-verification.latest.json"),
	startupBenchmark: join(BASELINE_DIR, "startup-cold.latest.json"),
}

const BENCHMARK_WARMUP_RUNS = 1
const BENCHMARK_MEASURED_RUNS = 7

function assertCondition(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new Error(message)
	}
}

function toRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		return value as Record<string, unknown>
	}

	throw new Error(`${label} must be an object. Received ${JSON.stringify(value)}`)
}

async function runCommand(
	command: string[],
	options: {
		cwd: string
		env?: Record<string, string>
		timeoutMs?: number
	},
): Promise<CommandResult> {
	const proc = Bun.spawn(command, {
		cwd: options.cwd,
		env: options.env ?? process.env,
		stdout: "pipe",
		stderr: "pipe",
	})

	const timeoutMs = options.timeoutMs ?? 120_000
	let timedOut = false
	let timeoutId: ReturnType<typeof setTimeout> | undefined

	const startedAt = performance.now()
	const outputPromise = Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	])
	const exitPromise = proc.exited.then((code) => {
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId)
		}
		return code
	})

	const exitCode = await Promise.race([
		exitPromise,
		new Promise<number>((resolve) => {
			timeoutId = setTimeout(() => {
				timedOut = true
				proc.kill()
				resolve(124)
			}, timeoutMs)

			if (typeof timeoutId.unref === "function") {
				timeoutId.unref()
			}
		}),
	])

	const [stdout, stderr] = await outputPromise
	const durationMs = Number((performance.now() - startedAt).toFixed(3))

	if (timedOut) {
		throw new Error(
			`Command timed out after ${timeoutMs}ms: ${command.join(" ")}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
		)
	}

	return { stdout, stderr, exitCode, durationMs }
}

function ensureExitCode(result: CommandResult, expected: number, label: string): void {
	if (result.exitCode === expected) {
		return
	}

	throw new Error(
		`${label} failed (expected exit ${expected}, got ${result.exitCode})\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
	)
}

async function ensureDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true })
}

async function sha256File(path: string): Promise<string> {
	const bytes = await readFile(path)
	return createHash("sha256").update(bytes).digest("hex")
}

function trimNullTerminatedAscii(input: Uint8Array): string {
	let endIndex = input.indexOf(0)
	if (endIndex === -1) {
		endIndex = input.length
	}

	return Buffer.from(input.subarray(0, endIndex)).toString("utf-8").trim()
}

function parseTarOctalField(input: Uint8Array): number {
	const raw = trimNullTerminatedAscii(input).replace(/\0/g, "").trim()
	if (raw.length === 0) {
		return 0
	}

	const parsed = Number.parseInt(raw, 8)
	assertCondition(Number.isFinite(parsed), `Invalid tar octal field value: ${JSON.stringify(raw)}`)
	return parsed
}

function parseTarPath(headerBlock: Uint8Array): string {
	const name = trimNullTerminatedAscii(headerBlock.subarray(0, 100))
	const prefix = trimNullTerminatedAscii(headerBlock.subarray(345, 500))

	if (prefix.length > 0 && name.length > 0) {
		return `${prefix}/${name}`
	}

	return name
}

function parseTarType(flag: number): TarArchiveEntry["type"] {
	if (flag === 0 || flag === 48) {
		return "file"
	}

	if (flag === 53) {
		return "directory"
	}

	if (flag === 50) {
		return "symlink"
	}

	return "other"
}

function isTarZeroBlock(block: Uint8Array): boolean {
	for (const byte of block) {
		if (byte !== 0) {
			return false
		}
	}

	return true
}

async function parseTarGzipArchive(tarballPath: string): Promise<TarArchiveEntry[]> {
	const compressed = await readFile(tarballPath)
	const tarBytes = gunzipSync(compressed)
	const entries: TarArchiveEntry[] = []

	let offset = 0
	while (offset + 512 <= tarBytes.length) {
		const header = tarBytes.subarray(offset, offset + 512)
		if (isTarZeroBlock(header)) {
			break
		}

		const entryPath = parseTarPath(header)
		const mode = parseTarOctalField(header.subarray(100, 108))
		const sizeBytes = parseTarOctalField(header.subarray(124, 136))
		const type = parseTarType(header[156] ?? 0)
		const linkPath = trimNullTerminatedAscii(header.subarray(157, 257)) || null

		const contentStart = offset + 512
		const contentEnd = contentStart + sizeBytes
		assertCondition(
			contentEnd <= tarBytes.length,
			`Tar entry ${entryPath} exceeds archive bounds (size ${sizeBytes})`,
		)

		entries.push({
			path: entryPath,
			sizeBytes,
			mode,
			type,
			content: tarBytes.subarray(contentStart, contentEnd),
			linkPath,
		})

		const alignedSize = Math.ceil(sizeBytes / 512) * 512
		offset = contentStart + alignedSize
	}

	return entries
}

function normalizePackageJsonPath(path: string): string {
	return path.replace(/^\.\//, "")
}

function toPortableRelativePath(baseDir: string, targetPath: string): string {
	const relativePath = relative(baseDir, targetPath)
	assertCondition(
		relativePath === "." || (!relativePath.startsWith("..") && !relativePath.includes(`..${sep}`)),
		`Path escaped sandbox root. Base: ${baseDir}, target: ${targetPath}`,
	)
	return relativePath.replaceAll("\\", "/")
}

function formatMode(mode: number): string {
	return `0o${(mode & 0o777).toString(8).padStart(3, "0")}`
}

function readFirstLine(input: string): string {
	const [line] = input.split(/\r?\n/u)
	return line ?? ""
}

function quoteWindowsCmdArg(arg: string): string {
	if (arg.length === 0) {
		return '""'
	}

	if (!/[\s"&()<>^|]/.test(arg)) {
		return arg
	}

	return `"${arg.replaceAll('"', '""')}"`
}

async function runInstalledCommand(
	commandName: string,
	args: string[],
	options: {
		cwd: string
		env: Record<string, string>
		timeoutMs: number
	},
): Promise<CommandResult> {
	if (process.platform === "win32") {
		const commandLine = [commandName, ...args].map(quoteWindowsCmdArg).join(" ")
		return runCommand(["cmd.exe", "/d", "/s", "/c", commandLine], options)
	}

	return runCommand([commandName, ...args], options)
}

function median(values: number[]): number {
	assertCondition(values.length > 0, "Cannot calculate median for an empty dataset")
	const sorted = [...values].sort((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	if (sorted.length % 2 === 1) {
		const center = sorted[mid]
		assertCondition(center !== undefined, "Missing center element while computing median")
		return Number(center.toFixed(3))
	}

	const left = sorted[mid - 1]
	const right = sorted[mid]
	assertCondition(
		left !== undefined && right !== undefined,
		"Missing midpoint values while computing median",
	)
	return Number(((left + right) / 2).toFixed(3))
}

function collectEnvironmentMetadata(): BaselineEnvironment {
	return {
		platform: process.platform,
		arch: process.arch,
		nodeVersion: process.version,
		bunVersion: Bun.version,
		cpuModel: cpus()[0]?.model ?? "unknown",
	}
}

function createDeterministicEnv(rootDir: string, installBinDir: string): Record<string, string> {
	const inheritedEnv = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => {
			const [_, value] = entry
			return value !== undefined
		}),
	)

	const pathKey = Object.keys(inheritedEnv).find((key) => key.toUpperCase() === "PATH") ?? "PATH"
	const inheritedPath = inheritedEnv[pathKey] ?? ""
	const prefixedPath =
		inheritedPath.length > 0 ? `${installBinDir}${delimiter}${inheritedPath}` : installBinDir

	return {
		...inheritedEnv,
		[pathKey]: prefixedPath,
		NO_COLOR: "1",
		FORCE_COLOR: "0",
		OCX_SELF_UPDATE: "off",
		OCX_NO_UPDATE_CHECK: "1",
		CI: "1",
		XDG_CONFIG_HOME: join(rootDir, "xdg"),
	}
}

async function packTarball(): Promise<{
	packEntry: NpmPackJsonEntry
	tarballPath: string
	tarballSha256: string
}> {
	await ensureDir(ARTIFACT_DIR)

	const buildResult = await runCommand(["bun", "run", "build"], { cwd: PACKAGE_DIR })
	ensureExitCode(buildResult, 0, "bun run build")

	const packResult = await runCommand(
		["npm", "pack", "--json", "--pack-destination", ARTIFACT_DIR],
		{ cwd: PACKAGE_DIR },
	)
	ensureExitCode(packResult, 0, "npm pack --json")

	let parsedPack: unknown
	try {
		parsedPack = JSON.parse(packResult.stdout)
	} catch (error) {
		throw new Error(
			`Failed to parse npm pack --json output: ${error instanceof Error ? error.message : String(error)}\n${packResult.stdout}`,
		)
	}

	assertCondition(Array.isArray(parsedPack), "npm pack --json output must be an array")
	const [entry] = parsedPack
	assertCondition(entry !== undefined, "npm pack --json returned an empty array")

	const packEntry = entry as NpmPackJsonEntry
	const tarballPath = join(ARTIFACT_DIR, packEntry.filename)
	const tarballInfo = await stat(tarballPath)
	assertCondition(tarballInfo.isFile(), `Expected tarball at ${tarballPath}`)

	const tarballSha256 = await sha256File(tarballPath)

	return {
		packEntry,
		tarballPath,
		tarballSha256,
	}
}

function listFileEntriesFromTarArchive(tarEntries: TarArchiveEntry[]): string[] {
	return tarEntries
		.filter((entry) => entry.type === "file")
		.map((entry) => entry.path)
		.sort((left, right) => left.localeCompare(right))
}

function readTarEntryTextFromArchive(tarEntries: TarArchiveEntry[], entryPath: string): string {
	const entry = tarEntries.find((candidate) => candidate.path === entryPath)
	assertCondition(entry !== undefined, `Tar entry not found: ${entryPath}`)
	assertCondition(entry.type === "file", `Tar entry is not a file: ${entryPath}`)
	return Buffer.from(entry.content).toString("utf-8")
}

async function createInstalledSandbox(
	manifest: ContractManifest,
	tarballPath: string,
): Promise<InstalledSandbox> {
	const rootDir = await mkdtemp(join(tmpdir(), "ocx-phase1-"))
	const installDir = join(rootDir, "install")
	const cleanCwd = join(rootDir, "clean-project")
	const nodeModulesDir = join(installDir, "node_modules")
	const binDir = join(nodeModulesDir, ".bin")

	await ensureDir(installDir)
	await ensureDir(cleanCwd)

	const sandboxPackageJsonPath = join(installDir, "package.json")
	await writeJsonFile(sandboxPackageJsonPath, {
		name: "ocx-phase1-sandbox",
		private: true,
		version: "0.0.0",
	})

	const installResult = await runCommand(
		["npm", "install", "--no-package-lock", "--no-audit", "--no-fund", tarballPath],
		{ cwd: installDir },
	)
	ensureExitCode(installResult, 0, "npm install <local tarball>")

	const commandName = manifest.supportedContract.bin.name
	const linkedPackagePath = join(nodeModulesDir, manifest.packageName)
	const linkedPackageStats = await stat(linkedPackagePath)
	assertCondition(
		linkedPackageStats.isDirectory(),
		`Expected installed package at ${linkedPackagePath}`,
	)

	const packageBinPath = join(
		linkedPackagePath,
		normalizePackageJsonPath(manifest.supportedContract.bin.packageJsonPath),
	)
	const packageBinStats = await stat(packageBinPath)
	assertCondition(packageBinStats.isFile(), `Expected package bin file at ${packageBinPath}`)

	const shimPath = join(binDir, process.platform === "win32" ? `${commandName}.cmd` : commandName)
	const shimStats = await lstat(shimPath)
	const shimType: "symlink" | "file" = shimStats.isSymbolicLink() ? "symlink" : "file"

	let shimTarget: string | null = null
	if (shimStats.isSymbolicLink()) {
		const linkedTarget = await readlink(shimPath)
		const resolvedTarget = resolve(dirname(shimPath), linkedTarget)
		assertCondition(
			resolvedTarget === packageBinPath,
			`Bin shim target drifted. Expected ${packageBinPath}, received ${resolvedTarget}`,
		)
		shimTarget = toPortableRelativePath(installDir, resolvedTarget)
	}

	const packageBinSource = await readFile(packageBinPath, "utf-8")
	const packageBinShebang = readFirstLine(packageBinSource)
	assertCondition(
		packageBinShebang.startsWith("#!"),
		`Installed package bin missing shebang: ${packageBinPath}`,
	)

	const packageBinExecutable = (packageBinStats.mode & 0o111) !== 0
	if (process.platform !== "win32") {
		assertCondition(
			packageBinExecutable,
			`Installed package bin is not executable: ${packageBinPath}`,
		)
	}

	const shimExecutable = (shimStats.mode & 0o111) !== 0
	if (process.platform !== "win32") {
		assertCondition(shimExecutable, `Installed command shim is not executable: ${shimPath}`)
	}

	return {
		rootDir,
		installDir,
		cleanCwd,
		env: createDeterministicEnv(rootDir, binDir),
		commandName,
		installedBinContract: {
			commandName,
			resolvedFromPath:
				process.platform === "win32"
					? `node_modules/.bin/${commandName}.cmd`
					: `node_modules/.bin/${commandName}`,
			shimPath: toPortableRelativePath(installDir, shimPath),
			shimType,
			shimTarget,
			shimMode: formatMode(shimStats.mode),
			shimExecutable,
			packageBinPath: toPortableRelativePath(installDir, packageBinPath),
			packageBinShebang,
			packageBinMode: formatMode(packageBinStats.mode),
			packageBinExecutable,
		},
	}
}

async function withInstalledSandbox<T>(
	manifest: ContractManifest,
	tarballPath: string,
	execute: (sandbox: InstalledSandbox) => Promise<T>,
): Promise<T> {
	const sandbox = await createInstalledSandbox(manifest, tarballPath)

	try {
		return await execute(sandbox)
	} finally {
		await rm(sandbox.rootDir, { recursive: true, force: true })
	}
}

function substituteTokens(input: string, values: Record<string, string>): string {
	let output = input
	for (const [key, value] of Object.entries(values)) {
		output = output.replaceAll(`{{${key}}}`, value)
	}
	return output
}

function resolveCliMatrixCase(
	caseSpec: CliMatrixCase,
	tokenValues: Record<string, string>,
): CliMatrixCase {
	return {
		...caseSpec,
		args: caseSpec.args.map((arg) => substituteTokens(arg, tokenValues)),
		expect: {
			...caseSpec.expect,
			stdoutExact:
				caseSpec.expect.stdoutExact === undefined
					? undefined
					: substituteTokens(caseSpec.expect.stdoutExact, tokenValues),
			stderrExact:
				caseSpec.expect.stderrExact === undefined
					? undefined
					: substituteTokens(caseSpec.expect.stderrExact, tokenValues),
			stdoutContains: caseSpec.expect.stdoutContains?.map((value) =>
				substituteTokens(value, tokenValues),
			),
			stderrContains: caseSpec.expect.stderrContains?.map((value) =>
				substituteTokens(value, tokenValues),
			),
			stdoutRegex:
				caseSpec.expect.stdoutRegex === undefined
					? undefined
					: substituteTokens(caseSpec.expect.stdoutRegex, tokenValues),
			stderrRegex:
				caseSpec.expect.stderrRegex === undefined
					? undefined
					: substituteTokens(caseSpec.expect.stderrRegex, tokenValues),
		},
	}
}

function assertCommandMatchesExpectations(
	caseId: string,
	result: Pick<CommandResult, "stdout" | "stderr" | "exitCode">,
	expectation: CliMatrixCase["expect"],
): void {
	assertCondition(
		result.exitCode === expectation.exitCode,
		`${caseId} exit code mismatch. Expected ${expectation.exitCode}, got ${result.exitCode}`,
	)

	if (expectation.stdoutExact !== undefined) {
		expectExactOutput(result.stdout, expectation.stdoutExact, `${caseId} stdout`)
	}

	if (expectation.stderrExact !== undefined) {
		expectExactOutput(result.stderr, expectation.stderrExact, `${caseId} stderr`)
	}

	if (expectation.stdoutContains) {
		expectContainsOutput(result.stdout, expectation.stdoutContains, `${caseId} stdout`)
	}

	if (expectation.stderrContains) {
		expectContainsOutput(result.stderr, expectation.stderrContains, `${caseId} stderr`)
	}

	if (expectation.stdoutRegex) {
		expectRegexOutput(result.stdout, expectation.stdoutRegex, `${caseId} stdout`)
	}

	if (expectation.stderrRegex) {
		expectRegexOutput(result.stderr, expectation.stderrRegex, `${caseId} stderr`)
	}
}

function expectExactOutput(actual: string, expected: string, label: string): void {
	if (actual === expected) {
		return
	}

	throw new Error(
		`${label} output mismatch\n--- expected ---\n${expected}\n--- actual ---\n${actual}`,
	)
}

function expectContainsOutput(actual: string, expectedItems: string[], label: string): void {
	for (const item of expectedItems) {
		if (actual.includes(item)) {
			continue
		}

		throw new Error(
			`${label} missing expected fragment: ${JSON.stringify(item)}\n--- output ---\n${actual}`,
		)
	}
}

function expectRegexOutput(actual: string, pattern: string, label: string): void {
	const regex = new RegExp(pattern)
	if (regex.test(actual)) {
		return
	}

	throw new Error(`${label} failed regex ${pattern}\n--- output ---\n${actual}`)
}

async function captureRuntimeExports(
	installDir: string,
	env: Record<string, string>,
	importSpecifier: string,
): Promise<string[]> {
	const script = `const mod = await import(${JSON.stringify(importSpecifier)}); process.stdout.write(JSON.stringify(Object.keys(mod).sort()));`
	const result = await runCommand(["bun", "--cwd", installDir, "-e", script], {
		cwd: PACKAGE_DIR,
		env,
	})
	ensureExitCode(result, 0, `capture runtime exports from ${importSpecifier}`)

	let parsed: unknown
	try {
		parsed = JSON.parse(result.stdout)
	} catch (error) {
		throw new Error(
			`Failed to parse runtime exports JSON: ${error instanceof Error ? error.message : String(error)}\n${result.stdout}`,
		)
	}

	assertCondition(Array.isArray(parsed), "Runtime exports payload must be an array")
	const runtimeExports = parsed.map((name) => String(name)).sort((a, b) => a.localeCompare(b))
	return runtimeExports
}

async function verifyImportSideEffects(
	installDir: string,
	env: Record<string, string>,
	importSpecifier: string,
	expected: ContractManifest["supportedContract"]["importSideEffects"],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const script = `await import(${JSON.stringify(importSpecifier)})`
	const result = await runCommand(["bun", "--cwd", installDir, "-e", script], {
		cwd: PACKAGE_DIR,
		env,
	})
	ensureExitCode(result, 0, `bare import side-effect check for ${importSpecifier}`)

	expectExactOutput(result.stdout, expected.bareImportStdoutExact, "bare import stdout")
	expectExactOutput(result.stderr, expected.bareImportStderrExact, "bare import stderr")

	return {
		stdout: result.stdout,
		stderr: result.stderr,
		exitCode: result.exitCode,
	}
}

async function verifyContract(
	manifest: ContractManifest,
	packEntry: NpmPackJsonEntry,
	tarballSha256: string,
	publishShapeData: {
		tarEntries: string[]
		packedPackageJson: Record<string, unknown>
		installedBinContract: InstalledSandbox["installedBinContract"]
		importSpecifierChecks: Array<{
			importSpecifier: string
			runtimeExports: string[]
			importCheck: { stdout: string; stderr: string; exitCode: number }
		}>
		cliResults: Array<{
			id: string
			command: string
			exitCode: number
			stdout: string
			stderr: string
		}>
	},
): Promise<Record<string, unknown>> {
	const packedPackageJson = publishShapeData.packedPackageJson
	const supportedContract = manifest.supportedContract

	assertCondition(
		packedPackageJson.name === manifest.packageName,
		`Packed package name drifted. Expected ${manifest.packageName}, received ${packedPackageJson.name}`,
	)

	const packedBin = toRecord(packedPackageJson.bin, "packed package.json bin")
	const supportedBinTarget = packedBin[supportedContract.bin.name]
	assertCondition(
		typeof supportedBinTarget === "string",
		`Packed package.json bin is missing supported executable ${supportedContract.bin.name}`,
	)
	assertCondition(
		supportedBinTarget === supportedContract.bin.packageJsonPath,
		`Supported bin target drifted. Expected ${supportedContract.bin.packageJsonPath}, received ${supportedBinTarget}`,
	)

	const installedBinContract = publishShapeData.installedBinContract
	assertCondition(
		installedBinContract.commandName === supportedContract.bin.name,
		`Installed command name drifted. Expected ${supportedContract.bin.name}, received ${installedBinContract.commandName}`,
	)
	assertCondition(
		installedBinContract.shimPath === installedBinContract.resolvedFromPath,
		`Installed command path drifted. Expected ${installedBinContract.resolvedFromPath}, received ${installedBinContract.shimPath}`,
	)
	assertCondition(
		installedBinContract.packageBinPath ===
			`node_modules/${manifest.packageName}/${normalizePackageJsonPath(supportedContract.bin.packageJsonPath)}`,
		`Installed package bin path drifted. Received ${installedBinContract.packageBinPath}`,
	)
	assertCondition(
		installedBinContract.packageBinShebang.startsWith("#!"),
		`Installed package bin shebang drifted: ${installedBinContract.packageBinShebang}`,
	)

	if (process.platform !== "win32") {
		assertCondition(
			installedBinContract.shimExecutable,
			`Installed command shim is not executable (${installedBinContract.shimMode})`,
		)
		assertCondition(
			installedBinContract.packageBinExecutable,
			`Installed package bin is not executable (${installedBinContract.packageBinMode})`,
		)
	}

	assertCondition(
		packedPackageJson.main === supportedContract.entrypoints.main,
		`Supported main entrypoint drifted. Expected ${supportedContract.entrypoints.main}, received ${packedPackageJson.main}`,
	)

	if (supportedContract.entrypoints.moduleFormat === "esm") {
		assertCondition(
			packedPackageJson.type === "module",
			`Supported module format drifted. Expected package.json type "module" for ESM, received ${packedPackageJson.type}`,
		)
	}

	for (const importSpecifier of supportedContract.entrypoints.importSpecifiers) {
		assertCondition(
			importSpecifier.length > 0,
			"supportedContract.entrypoints.importSpecifiers cannot contain empty values",
		)
	}

	const expectedImportSpecifiers = [...supportedContract.entrypoints.importSpecifiers].sort(
		(left, right) => left.localeCompare(right),
	)
	const observedImportSpecifiers = publishShapeData.importSpecifierChecks
		.map((check) => check.importSpecifier)
		.sort((left, right) => left.localeCompare(right))
	assertCondition(
		JSON.stringify(observedImportSpecifiers) === JSON.stringify(expectedImportSpecifiers),
		`Import specifier coverage drifted. Expected ${JSON.stringify(expectedImportSpecifiers)}, received ${JSON.stringify(observedImportSpecifiers)}`,
	)

	const expectedExports = [...supportedContract.runtimeExports].sort((left, right) =>
		left.localeCompare(right),
	)
	for (const importCheck of publishShapeData.importSpecifierChecks) {
		assertCondition(
			JSON.stringify(importCheck.runtimeExports) === JSON.stringify(expectedExports),
			`Runtime export surface drifted for ${importCheck.importSpecifier}. Expected ${JSON.stringify(expectedExports)}, received ${JSON.stringify(importCheck.runtimeExports)}`,
		)
	}

	const expectedBinTarEntry = `package/${normalizePackageJsonPath(supportedContract.bin.packageJsonPath)}`
	const expectedMainTarEntry = `package/${normalizePackageJsonPath(supportedContract.entrypoints.main)}`
	assertCondition(
		publishShapeData.tarEntries.includes(expectedBinTarEntry),
		`Supported bin path missing from tarball: ${expectedBinTarEntry}`,
	)
	assertCondition(
		publishShapeData.tarEntries.includes(expectedMainTarEntry),
		`Supported main entrypoint missing from tarball: ${expectedMainTarEntry}`,
	)

	const expectedPackageShape = manifest.observedPublishShape.packedPackageJson
	assertCondition(
		packedPackageJson.type === expectedPackageShape.type,
		`Packed package type drifted. Expected ${expectedPackageShape.type}, received ${packedPackageJson.type}`,
	)
	assertCondition(
		packedPackageJson.main === expectedPackageShape.main,
		`Packed package main drifted. Expected ${expectedPackageShape.main}, received ${packedPackageJson.main}`,
	)

	assertCondition(
		JSON.stringify(packedBin) === JSON.stringify(expectedPackageShape.bin),
		`Packed package bin drifted. Expected ${JSON.stringify(expectedPackageShape.bin)}, received ${JSON.stringify(packedBin)}`,
	)

	const packedFilesValue = packedPackageJson.files
	assertCondition(Array.isArray(packedFilesValue), "packed package.json files must be an array")
	const packedFiles = packedFilesValue.map((value) => String(value))
	assertCondition(
		JSON.stringify(packedFiles) === JSON.stringify(expectedPackageShape.files),
		`Packed package files drifted. Expected ${JSON.stringify(expectedPackageShape.files)}, received ${JSON.stringify(packedFiles)}`,
	)

	if (expectedPackageShape.exports === null) {
		assertCondition(
			!("exports" in packedPackageJson),
			"Packed package unexpectedly defines exports field",
		)
	}

	if (expectedPackageShape.types === null) {
		assertCondition(
			!("types" in packedPackageJson),
			"Packed package unexpectedly defines types field",
		)
	}

	for (const entry of manifest.observedPublishShape.requiredTarEntries) {
		assertCondition(
			publishShapeData.tarEntries.includes(entry),
			`Required tar entry missing: ${entry}`,
		)
	}

	const disallowedMatches: string[] = []
	for (const pattern of manifest.observedPublishShape.disallowedTarEntryPatterns) {
		const regex = new RegExp(pattern)
		for (const entry of publishShapeData.tarEntries) {
			if (regex.test(entry)) {
				disallowedMatches.push(entry)
			}
		}
	}

	assertCondition(
		disallowedMatches.length === 0,
		`Disallowed tar entries detected: ${disallowedMatches.join(", ")}`,
	)

	const expectedCliIds = supportedContract.cliMatrix
		.map((matrixCase) => matrixCase.id)
		.sort((a, b) => a.localeCompare(b))
	const observedCliIds = publishShapeData.cliResults
		.map((matrixCase) => matrixCase.id)
		.sort((a, b) => a.localeCompare(b))

	assertCondition(
		JSON.stringify(expectedCliIds) === JSON.stringify(observedCliIds),
		`CLI matrix case set drifted. Expected ${JSON.stringify(expectedCliIds)}, received ${JSON.stringify(observedCliIds)}`,
	)

	return {
		schemaVersion: 1,
		contractManifestPath: "phase1/contract.manifest.json",
		environment: collectEnvironmentMetadata(),
		status: "pass",
		artifact: {
			filename: packEntry.filename,
			path: `phase1/artifacts/${packEntry.filename}`,
			sha256: tarballSha256,
			sizeBytes: packEntry.size,
		},
		checks: {
			supportedContract: {
				binResolution: {
					name: supportedContract.bin.name,
					target: supportedContract.bin.packageJsonPath,
					installedCommand: {
						resolvedFromPath: installedBinContract.resolvedFromPath,
						shimType: installedBinContract.shimType,
						shimTarget: installedBinContract.shimTarget,
						shimMode: installedBinContract.shimMode,
						executableBit:
							process.platform === "win32"
								? "not-applicable"
								: installedBinContract.shimExecutable
									? "present"
									: "missing",
					},
					entrypointFile: {
						path: installedBinContract.packageBinPath,
						shebang: installedBinContract.packageBinShebang,
						mode: installedBinContract.packageBinMode,
						executableBit:
							process.platform === "win32"
								? "not-applicable"
								: installedBinContract.packageBinExecutable
									? "present"
									: "missing",
					},
					status: "pass",
				},
				entrypoint: {
					main: supportedContract.entrypoints.main,
					moduleFormat: supportedContract.entrypoints.moduleFormat,
					importSpecifiers: supportedContract.entrypoints.importSpecifiers,
					status: "pass",
				},
				importSpecifiers: publishShapeData.importSpecifierChecks.map((check) => ({
					importSpecifier: check.importSpecifier,
					runtimeExports: check.runtimeExports,
					importSideEffects: check.importCheck,
					status: "pass",
				})),
				runtimeExports: expectedExports,
				cliMatrix: publishShapeData.cliResults.map((result) => ({
					id: result.id,
					command: result.command,
					exitCode: result.exitCode,
					status: "pass",
				})),
				status: "pass",
			},
			observedPublishShape: {
				packedPackageJson: expectedPackageShape,
				requiredTarEntries: manifest.observedPublishShape.requiredTarEntries,
				disallowedTarEntryPatterns: manifest.observedPublishShape.disallowedTarEntryPatterns,
				status: "pass",
				sourcemapPolicy: manifest.observedPublishShape.sourcemapPolicy,
			},
		},
	}
}

async function writeJsonFile(path: string, payload: unknown): Promise<void> {
	await ensureDir(dirname(path))
	await writeFile(path, `${JSON.stringify(payload, null, "\t")}\n`, "utf-8")
}

async function collectPublishShape(
	packEntry: NpmPackJsonEntry,
	tarballSha256: string,
	tarEntries: string[],
	packedPackageJson: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	return {
		schemaVersion: 1,
		tool: "packages/cli/scripts/phase1.ts inspect",
		environment: collectEnvironmentMetadata(),
		artifact: {
			filename: packEntry.filename,
			path: `phase1/artifacts/${packEntry.filename}`,
			sha256: tarballSha256,
		},
		npmPack: {
			id: packEntry.id,
			name: packEntry.name,
			version: packEntry.version,
			sizeBytes: packEntry.size,
			unpackedSizeBytes: packEntry.unpackedSize,
			entryCount: packEntry.entryCount,
			shasum: packEntry.shasum,
			integrity: packEntry.integrity,
			files: packEntry.files,
		},
		packedPackageJson: {
			name: packedPackageJson.name,
			version: packedPackageJson.version,
			type: packedPackageJson.type,
			main: packedPackageJson.main,
			bin: packedPackageJson.bin,
			files: packedPackageJson.files,
			exports: Object.hasOwn(packedPackageJson, "exports") ? packedPackageJson.exports : null,
			types: Object.hasOwn(packedPackageJson, "types") ? packedPackageJson.types : null,
		},
		tarEntries,
		observations: {
			sourcemapPublished: tarEntries.includes("package/dist/index.js.map"),
			sourcemapClassification: "observed-publish-shape-only",
		},
	}
}

const BENCHMARK_CASE_IDS = ["help", "version", "search-missing-config"] as const

function selectBenchmarkCases(resolvedCases: CliMatrixCase[]): CliMatrixCase[] {
	const selectedCases = BENCHMARK_CASE_IDS.map((caseId) => {
		const match = resolvedCases.find((caseSpec) => caseSpec.id === caseId)
		assertCondition(match !== undefined, `Missing benchmark CLI matrix case: ${caseId}`)
		return match
	})

	return selectedCases
}

async function runBenchmark(
	benchmarkCases: CliMatrixCase[],
	commandName: string,
	installDir: string,
	env: Record<string, string>,
	cleanCwd: string,
	packEntry: NpmPackJsonEntry,
	tarballSha256: string,
): Promise<Record<string, unknown>> {
	const formatReportedCommand = (args: string[]): string => {
		return ["ocx", ...args].join(" ").replaceAll(cleanCwd, "<clean-temp-project>")
	}

	const results: Array<Record<string, unknown>> = []

	for (const command of benchmarkCases) {
		const warmupDurations: number[] = []
		const measuredDurations: number[] = []
		const measuredExitCodes: number[] = []

		const totalRuns = BENCHMARK_WARMUP_RUNS + BENCHMARK_MEASURED_RUNS
		for (let runIndex = 0; runIndex < totalRuns; runIndex += 1) {
			const result = await runInstalledCommand(commandName, command.args, {
				cwd: installDir,
				env,
				timeoutMs: 30_000,
			})

			assertCommandMatchesExpectations(
				`benchmark:${command.id}:run-${runIndex + 1}`,
				result,
				command.expect,
			)

			if (runIndex < BENCHMARK_WARMUP_RUNS) {
				warmupDurations.push(result.durationMs)
				continue
			}

			measuredDurations.push(result.durationMs)
			measuredExitCodes.push(result.exitCode)
		}

		results.push({
			id: command.id,
			command: formatReportedCommand(command.args),
			expectedExitCode: command.expect.exitCode,
			warmupDurationsMs: warmupDurations,
			measuredDurationsMs: measuredDurations,
			measuredExitCodes,
			medianMs: median(measuredDurations),
			minMs: Number(Math.min(...measuredDurations).toFixed(3)),
			maxMs: Number(Math.max(...measuredDurations).toFixed(3)),
		})
	}

	return {
		schemaVersion: 1,
		environment: collectEnvironmentMetadata(),
		artifact: {
			target: "isolated installed ocx command from npm-installed local packed tarball",
			filename: packEntry.filename,
			path: `phase1/artifacts/${packEntry.filename}`,
			sha256: tarballSha256,
		},
		protocol: {
			measuredRunsPerCommand: BENCHMARK_MEASURED_RUNS,
			warmupRunsPerCommand: BENCHMARK_WARMUP_RUNS,
			cachePolicy:
				"No privileged OS cache flush. Each sample is a fresh installed-command process launch against one npm-installed local tarball workspace.",
			commandsUnderTest: benchmarkCases.map((command) => ({
				id: command.id,
				command: formatReportedCommand(command.args),
				expectedExitCode: command.expect.exitCode,
			})),
			medianCalculation: "50th percentile of measuredDurationsMs after warmup runs are excluded.",
		},
		results,
	}
}

async function loadContractManifest(): Promise<ContractManifest> {
	const content = await readFile(CONTRACT_PATH, "utf-8")
	let parsed: unknown
	try {
		parsed = JSON.parse(content)
	} catch (error) {
		throw new Error(
			`Failed to parse contract manifest at ${CONTRACT_PATH}: ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	const manifest = parsed as ContractManifest
	assertCondition(manifest.schemaVersion === 1, "Unsupported contract manifest schemaVersion")
	assertCondition(manifest.packageName.length > 0, "Contract packageName cannot be empty")
	assertCondition(
		manifest.supportedContract.bin.packageJsonPath.length > 0,
		"supportedContract.bin.packageJsonPath cannot be empty",
	)
	assertCondition(
		manifest.supportedContract.entrypoints.main.length > 0,
		"supportedContract.entrypoints.main cannot be empty",
	)
	assertCondition(
		manifest.supportedContract.entrypoints.importSpecifiers.length > 0,
		"supportedContract.entrypoints.importSpecifiers must include at least one import specifier",
	)
	return manifest
}

function parseToolingCommand(argv: string[]): ToolingCommand {
	const candidate = argv[2] as ToolingCommand | undefined
	if (!candidate) {
		return "all"
	}

	const validCommands: ToolingCommand[] = ["all", "pack", "inspect", "verify", "benchmark"]
	assertCondition(
		validCommands.includes(candidate),
		`Invalid command "${candidate}". Use one of: ${validCommands.join(", ")}`,
	)
	return candidate
}

async function main(): Promise<void> {
	const command = parseToolingCommand(process.argv)
	const manifest = await loadContractManifest()

	const packData = await packTarball()
	const tarArchive = await parseTarGzipArchive(packData.tarballPath)
	const tarEntries = listFileEntriesFromTarArchive(tarArchive)
	const packedPackageJsonText = readTarEntryTextFromArchive(tarArchive, "package/package.json")
	const packedPackageJson = toRecord(JSON.parse(packedPackageJsonText), "packed package.json")

	const publishShape = await collectPublishShape(
		packData.packEntry,
		packData.tarballSha256,
		tarEntries,
		packedPackageJson,
	)

	if (command === "pack") {
		console.log(JSON.stringify(publishShape, null, 2))
		return
	}

	if (command === "all" || command === "inspect") {
		await writeJsonFile(BASELINE_OUTPUT_PATHS.packShape, publishShape)
		console.log(`Wrote ${BASELINE_OUTPUT_PATHS.packShape}`)
	}

	if (command === "inspect") {
		return
	}

	const packageVersion = String(packedPackageJson.version ?? "")

	if (command === "all" || command === "verify") {
		await withInstalledSandbox(manifest, packData.tarballPath, async (sandbox) => {
			const tokenValues = {
				PACKAGE_VERSION: packageVersion,
				CLEAN_CWD: sandbox.cleanCwd,
			}
			const resolvedCliCases = manifest.supportedContract.cliMatrix.map((caseSpec) =>
				resolveCliMatrixCase(caseSpec, tokenValues),
			)

			const formatReportedCommand = (args: string[]): string => {
				return ["ocx", ...args].join(" ").replaceAll(sandbox.cleanCwd, "<clean-temp-project>")
			}

			const cliResults: Array<{
				id: string
				command: string
				exitCode: number
				stdout: string
				stderr: string
			}> = []

			for (const resolvedCase of resolvedCliCases) {
				const result = await runInstalledCommand(sandbox.commandName, resolvedCase.args, {
					cwd: sandbox.installDir,
					env: sandbox.env,
					timeoutMs: 30_000,
				})

				cliResults.push({
					id: resolvedCase.id,
					command: formatReportedCommand(resolvedCase.args),
					exitCode: result.exitCode,
					stdout: result.stdout,
					stderr: result.stderr,
				})

				assertCommandMatchesExpectations(resolvedCase.id, result, resolvedCase.expect)
			}

			const importSpecifierChecks: Array<{
				importSpecifier: string
				runtimeExports: string[]
				importCheck: { stdout: string; stderr: string; exitCode: number }
			}> = []

			for (const importSpecifier of manifest.supportedContract.entrypoints.importSpecifiers) {
				const runtimeExports = await captureRuntimeExports(
					sandbox.installDir,
					sandbox.env,
					importSpecifier,
				)
				const importCheck = await verifyImportSideEffects(
					sandbox.installDir,
					sandbox.env,
					importSpecifier,
					manifest.supportedContract.importSideEffects,
				)

				importSpecifierChecks.push({
					importSpecifier,
					runtimeExports,
					importCheck,
				})
			}

			const verificationResult = await verifyContract(
				manifest,
				packData.packEntry,
				packData.tarballSha256,
				{
					tarEntries,
					packedPackageJson,
					installedBinContract: sandbox.installedBinContract,
					importSpecifierChecks,
					cliResults,
				},
			)

			await writeJsonFile(BASELINE_OUTPUT_PATHS.contractVerification, verificationResult)
			console.log(`Wrote ${BASELINE_OUTPUT_PATHS.contractVerification}`)
		})
	}

	if (command === "verify") {
		return
	}

	if (command === "all" || command === "benchmark") {
		await withInstalledSandbox(manifest, packData.tarballPath, async (sandbox) => {
			const tokenValues = {
				PACKAGE_VERSION: packageVersion,
				CLEAN_CWD: sandbox.cleanCwd,
			}
			const resolvedCliCases = manifest.supportedContract.cliMatrix.map((caseSpec) =>
				resolveCliMatrixCase(caseSpec, tokenValues),
			)

			const benchmarkCases = selectBenchmarkCases(resolvedCliCases)
			const benchmarkResult = await runBenchmark(
				benchmarkCases,
				sandbox.commandName,
				sandbox.installDir,
				sandbox.env,
				sandbox.cleanCwd,
				packData.packEntry,
				packData.tarballSha256,
			)

			await writeJsonFile(BASELINE_OUTPUT_PATHS.startupBenchmark, benchmarkResult)
			console.log(`Wrote ${BASELINE_OUTPUT_PATHS.startupBenchmark}`)
		})
	}
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error)
	console.error(`phase1 tooling failed: ${message}`)
	process.exit(1)
})

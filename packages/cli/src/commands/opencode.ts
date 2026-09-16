import { isAbsolute, resolve } from "node:path"
import type { Command } from "commander"
import { ProfileManager } from "../profile/manager"
import { getProfileDir } from "../profile/paths"
import { ConfigError } from "../utils/errors"
import { handleError } from "../utils/handle-error"

interface OpencodeOptions {
	profile?: string
}
type OpenCodeShutdownSignal = "SIGINT" | "SIGTERM"
const OPENCODE_SIGNAL_GRACE_MS = 2500
const OPENCODE_SIGNAL_EXIT_CODES: Record<OpenCodeShutdownSignal, number> = {
	SIGINT: 130,
	SIGTERM: 143,
}

export function resolveOpenCodeBinary(options: { configBin?: string; envBin?: string }): string {
	return options.configBin ?? options.envBin ?? "opencode"
}

export function resolveStableOpenCodeLauncherPath(options: {
	configuredBin: string
	cwd: string
}): string {
	const binary = options.configuredBin
	if (!binary.trim()) throw new ConfigError("OpenCode binary cannot be empty")
	if (isAbsolute(binary) || binary.includes("/") || binary.includes("\\"))
		return resolve(options.cwd, binary)
	const executable = Bun.which(binary)
	if (!executable)
		throw new ConfigError(
			`OpenCode binary "${binary}" was not found in PATH. Install OpenCode V2 (@opencode/cli).`,
		)
	return executable
}

export function buildOpenCodeEnv(options: {
	baseEnv: Record<string, string | undefined>
	profileName: string
	projectConfig: "ignore" | "inherit"
}): Record<string, string | undefined> {
	const env = { ...options.baseEnv }
	for (const key of [
		"OPENCODE_CONFIG",
		"OPENCODE_CONFIG_CONTENT",
		"OPENCODE_DISABLE_PROJECT_CONFIG",
		"OPENCODE_CONFIG_PROJECT_DISABLE",
		"OCX_CONTEXT",
		"OCX_BIN",
		"OCX_TITLE_CONTEXT",
	])
		delete env[key]
	env.OPENCODE_CONFIG_DIR = getProfileDir(options.profileName)
	env.OPENCODE_CONFIG_PROJECT_DISABLE = options.projectConfig === "ignore" ? "true" : "false"
	env.OCX_PROFILE = options.profileName
	return env
}

/** V2.0.3 has command-specific server flags, not a global standalone flag. */
export function buildOpenCodeArgs(args: string[]): string[] {
	if (
		args.some(
			(arg, index) =>
				arg === "--no-standalone" ||
				arg.startsWith("--standalone=") ||
				(arg === "--standalone" && args[index + 1] === "false"),
		)
	)
		throw new ConfigError("OCX profiles require a private server; do not override --standalone.")
	if (
		args.includes("--help") ||
		args.includes("-h") ||
		args.includes("--version") ||
		args.includes("-v")
	)
		return args
	let first = 0
	while (args[first]?.startsWith("-")) {
		const flag = args[first]
		if (flag === "--") break
		first += ["--log-level", "--completions", "--prompt", "--session", "-s", "--server"].includes(
			flag ?? "",
		)
			? 2
			: 1
	}
	const command = args[first]
	const nested = args[first + 1]
	let insertion = first
	if (["run", "mini", "api", "models", "stats"].includes(command ?? "")) insertion = first + 1
	else if (
		(command === "auth" && ["list", "login", "logout", "switch"].includes(nested ?? "")) ||
		(command === "session" && ["list", "delete", "export", "import"].includes(nested ?? ""))
	)
		insertion = first + 2
	else if (
		command === "acp" ||
		command === "serve" ||
		(command === "debug" && nested === "paths") ||
		(command === "plugin" && ["add", "remove"].includes(nested ?? "")) ||
		(command === "mcp" && nested === "add")
	) {
		if (
			command === "serve" &&
			args.some((arg) => arg === "--service" || arg.startsWith("--service="))
		)
			throw new ConfigError(
				"A profile server cannot use --service. Use 'ocx oc serve' for a foreground profile server.",
			)
		return args
	} else if (
		[
			"agent",
			"debug",
			"plugin",
			"mcp",
			"service",
			"pair",
			"upgrade",
			"update",
			"uninstall",
			"auth",
			"session",
		].includes(command ?? "")
	) {
		throw new ConfigError(
			`OpenCode 2.0.3 cannot run '${command}${nested ? ` ${nested}` : ""}' with a private profile server. Use 'ocx oc api <operation>' for profile API inspection, or run 'opencode ${command}' directly for user-wide administration.`,
		)
	}
	// The native parser rejects --server combined with --standalone.
	if (args.includes("--standalone")) return args
	return [...args.slice(0, insertion), "--standalone", ...args.slice(insertion)]
}

export async function requireOpenCodeV2(
	binary: string,
	env: Record<string, string | undefined>,
): Promise<string> {
	const proc = Bun.spawn([binary, "--version"], {
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	})
	const timer = setTimeout(() => proc.kill("SIGKILL"), 10_000)
	try {
		const [output, error, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		])
		const match = /^\s*(?:opencode\s+)?v?(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?\s*$/i.exec(output)
		if (code !== 0 || !match)
			throw new ConfigError(
				`Cannot identify OpenCode at ${binary}: ${error.trim() || output.trim() || `exit ${code}`}`,
			)
		if (match[1] !== "2" || (Number(match[2]) === 0 && Number(match[3]) < 3))
			throw new ConfigError(
				`OCX 3 requires OpenCode V2 (2.0.3 or newer). Found ${output.trim()}. Keep OCX 2 for OpenCode V1.`,
			)
		return output.trim()
	} finally {
		clearTimeout(timer)
	}
}

export function registerOpencodeCommand(program: Command): void {
	program
		.command("oc")
		.alias("opencode")
		.description("Launch OpenCode V2 using a named profile")
		.option("-p, --profile <name>", "Use a named profile")
		.helpOption(false)
		.passThroughOptions()
		.allowUnknownOption()
		.allowExcessArguments(true)
		.action(async (options: OpencodeOptions, command: Command) => {
			try {
				process.exitCode = await runOpencode(command.args, options)
			} catch (error) {
				handleError(error)
			}
		})
}

export async function runOpencode(args: string[], options: OpencodeOptions): Promise<number> {
	const manager = ProfileManager.create()
	const name = await manager.resolveProfile(options.profile)
	const profile = await manager.get(name)
	const env = buildOpenCodeEnv({
		baseEnv: process.env,
		profileName: name,
		projectConfig: profile.ocx.projectConfig,
	})
	const configuredBin = resolveOpenCodeBinary({
		configBin: profile.ocx.bin,
		envBin: process.env.OPENCODE_BIN,
	})
	const binary = resolveStableOpenCodeLauncherPath({ configuredBin, cwd: process.cwd() })
	const nativeArgs = buildOpenCodeArgs(args)
	await requireOpenCodeV2(binary, env)
	const supervisor = createOpenCodeShutdownSupervisor()
	const interrupt = () => supervisor.handleSigint()
	const terminate = () => supervisor.handleSigterm()
	process.on("SIGINT", interrupt)
	process.on("SIGTERM", terminate)
	try {
		const child = Bun.spawn([binary, ...nativeArgs], {
			cwd: process.cwd(),
			env,
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		})
		supervisor.attachChild(child)
		const code = await child.exited
		return supervisor.getRememberedSignalExitCode() ?? code
	} finally {
		supervisor.clearGraceTimer()
		process.off("SIGINT", interrupt)
		process.off("SIGTERM", terminate)
	}
}

function createOpenCodeShutdownSupervisor() {
	let childProcess: ReturnType<typeof Bun.spawn> | null = null
	let graceTimer: ReturnType<typeof setTimeout> | null = null
	let rememberedSignalExitCode: number | null = null
	let hasEscalatedToKill = false

	const clearGraceTimer = () => {
		if (!graceTimer) {
			return
		}

		clearTimeout(graceTimer)
		graceTimer = null
	}

	const killChildImmediately = () => {
		if (!childProcess) {
			return
		}

		if (hasEscalatedToKill) {
			return
		}

		hasEscalatedToKill = true
		childProcess.kill("SIGKILL")
	}

	const startSignalGraceTimer = () => {
		if (graceTimer) {
			return
		}

		graceTimer = setTimeout(() => {
			killChildImmediately()
		}, OPENCODE_SIGNAL_GRACE_MS)
	}

	const requestShutdown = (signal: OpenCodeShutdownSignal) => {
		rememberedSignalExitCode ??= OPENCODE_SIGNAL_EXIT_CODES[signal]

		if (!childProcess) {
			return
		}

		if (graceTimer || hasEscalatedToKill) {
			killChildImmediately()
			return
		}

		childProcess.kill(signal)
		startSignalGraceTimer()
	}

	return {
		attachChild(processToSupervise: ReturnType<typeof Bun.spawn>) {
			childProcess = processToSupervise
		},
		clearGraceTimer,
		getRememberedSignalExitCode() {
			return rememberedSignalExitCode
		},
		handleSigint() {
			requestShutdown("SIGINT")
		},
		handleSigterm() {
			requestShutdown("SIGTERM")
		},
	}
}

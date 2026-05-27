interface NotifyBackendOptions {
	preferCmux: boolean
	tryCmuxNotify: () => Promise<boolean>
	sendDesktopNotification: () => void | Promise<void>
}

export interface DesktopNotificationOptions {
	title: string
	message: string
	subtitle?: string
	sound?: string
	senderBundleId?: string | null
	nativeTabTitle?: string | null
	processName?: string | null
}

interface DesktopNotificationRouterOptions extends DesktopNotificationOptions {
	platform: NodeJS.Platform | string
	sendNodeNotifierNotification: () => void
	sendMacOSNotification?: (options: DesktopNotificationOptions) => Promise<boolean>
}

interface AlerterProcess {
	exited: Promise<number>
	stdout?: ReadableStream | null
}

interface AlerterRuntime {
	which?: (command: string) => string | null | Promise<string | null>
	spawnProcess?: (argv: string[]) => AlerterProcess
	focusBundleId?: (bundleId: string, options?: DesktopNotificationOptions) => Promise<void>
	warn?: (message: string) => void
}

const ALERTER_INSTALL_HINT =
	"install vjeantet/alerter (brew install vjeantet/tap/alerter) and ensure it is on PATH"

export function buildAlerterArguments(options: DesktopNotificationOptions): string[] {
	const argv = ["alerter", "--message", options.message, "--title", options.title]

	if (options.subtitle) {
		argv.push("--subtitle", options.subtitle)
	}

	if (options.sound) {
		argv.push("--sound", options.sound)
	}

	if (options.senderBundleId) {
		argv.push("--sender", options.senderBundleId)
	}

	return argv
}

async function readAlerterOutput(process: AlerterProcess): Promise<string> {
	if (!process.stdout) return ""

	try {
		return (await new Response(process.stdout).text()).trim()
	} catch {
		return ""
	}
}

function shouldActivateBundleId(alerterOutput: string): boolean {
	const normalizedOutput = alerterOutput.trim().toUpperCase()
	if (!normalizedOutput) return false
	if (normalizedOutput === "@CLOSED" || normalizedOutput === "@TIMEOUT") return false
	return true
}

async function focusBundleId(bundleId: string): Promise<void> {
	try {
		const activateProcess = Bun.spawn(
			["osascript", "-e", `tell application id \"${bundleId}\" to activate`],
			{
				stdout: "ignore",
				stderr: "ignore",
			},
		)
		if ((await activateProcess.exited) === 0) return
	} catch {
		// Fall through to `open -b` fallback.
	}

	try {
		const openProcess = Bun.spawn(["open", "-b", bundleId], {
			stdout: "ignore",
			stderr: "ignore",
		})
		await openProcess.exited
	} catch {
		// Best-effort focus only.
	}
}

function toAppleScriptString(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

async function focusVSCodeNativeTab(
	processName: string,
	nativeTabTitle: string,
): Promise<boolean> {
	try {
		const escapedProcessName = toAppleScriptString(processName)
		const escapedTabTitle = toAppleScriptString(nativeTabTitle)
		const result = Bun.spawn(
			[
				"osascript",
				"-e",
				`tell application \"System Events\" to tell process \"${escapedProcessName}\"`,
				"-e",
				"repeat with w in windows",
				"-e",
				"try",
				"-e",
				"tell tab group 1 of w",
				"-e",
				`if exists radio button \"${escapedTabTitle}\" then`,
				"-e",
				'perform action "AXRaise" of w',
				"-e",
				`tell radio button \"${escapedTabTitle}\" to perform action \"AXPress\"`,
				"-e",
				'return "matched"',
				"-e",
				"end if",
				"-e",
				"end tell",
				"-e",
				"end try",
				"-e",
				"end repeat",
				"-e",
				'return "not-found"',
				"-e",
				"end tell",
			],
			{ stdout: "pipe", stderr: "ignore" },
		)
		const [exitCode, output] = await Promise.all([
			result.exited,
			new Response(result.stdout).text(),
		])
		return exitCode === 0 && output.trim() === "matched"
	} catch {
		return false
	}
}

async function focusBundleIdWithContext(
	bundleId: string,
	options?: DesktopNotificationOptions,
): Promise<void> {
	await focusBundleId(bundleId)

	if (
		process.platform === "darwin" &&
		options?.processName === "Code" &&
		options.nativeTabTitle
	) {
		await focusVSCodeNativeTab(options.processName, options.nativeTabTitle)
	}
}

export async function sendMacOSAlerterNotification(
	options: DesktopNotificationOptions,
	runtime: AlerterRuntime = {},
): Promise<boolean> {
	const which = runtime.which ?? Bun.which
	const activateBundle = runtime.focusBundleId ?? focusBundleIdWithContext
	const warn = runtime.warn ?? console.warn

	try {
		const alerterPath = await which("alerter")
		if (!alerterPath) {
			warn(`notify: macOS desktop notification skipped; alerter not found on PATH (${ALERTER_INSTALL_HINT}).`)
			return false
		}

		const alerterArguments = buildAlerterArguments(options)
		const spawnProcess = runtime.spawnProcess ?? ((argv: string[]) => Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" }))
		const process = spawnProcess([alerterPath, ...alerterArguments.slice(1)])
		const [exitCode, alerterOutput] = await Promise.all([
			process.exited,
			readAlerterOutput(process),
		])

		if (exitCode === 0) {
			if (options.senderBundleId && shouldActivateBundleId(alerterOutput)) {
				await activateBundle(options.senderBundleId, options)
			}
			return true
		}

		warn(`notify: macOS desktop notification skipped; alerter exited with code ${exitCode}.`)
		return false
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		warn(`notify: macOS desktop notification skipped; alerter failed (${message}).`)
		return false
	}
}

export async function sendDesktopNotificationByPlatform(
	options: DesktopNotificationRouterOptions,
): Promise<void> {
	const { platform, sendNodeNotifierNotification, sendMacOSNotification, ...notificationOptions } = options

	if (platform === "darwin") {
		await (sendMacOSNotification ?? sendMacOSAlerterNotification)(notificationOptions)
		return
	}

	sendNodeNotifierNotification()
}

export async function sendNotificationWithFallback(options: NotifyBackendOptions): Promise<void> {
	if (!options.preferCmux) {
		await options.sendDesktopNotification()
		return
	}

	try {
		const sentViaCmux = await options.tryCmuxNotify()
		if (sentViaCmux) return
	} catch {
		// Fall through to desktop notification fallback
	}

	await options.sendDesktopNotification()
}

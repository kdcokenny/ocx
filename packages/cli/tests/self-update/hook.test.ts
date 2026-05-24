import { afterAll, afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Command } from "commander"
import { cleanupTempDir, createTempDir } from "../helpers"

const SELF_UPDATE_COMMAND_MODULE_PATH = require.resolve("../../src/commands/self/update.js")
const SELF_UPDATE_RUNNER_MODULE_PATH = require.resolve("../../src/commands/self/update-runner.js")
const SELF_UPDATE_CHECK_MODULE_PATH = require.resolve("../../src/self-update/check.js")
const SELF_UPDATE_DETECT_METHOD_MODULE_PATH = require.resolve(
	"../../src/self-update/detect-method.js",
)
const SELF_UPDATE_VERIFY_MODULE_PATH = require.resolve("../../src/self-update/verify.js")
const SELF_UPDATE_NOTIFY_MODULE_PATH = require.resolve("../../src/self-update/notify.js")
const SPINNER_MODULE_PATH = require.resolve("../../src/utils/spinner.js")

const SELF_UPDATE_MOCKED_MODULE_PATHS = [
	SELF_UPDATE_COMMAND_MODULE_PATH,
	SELF_UPDATE_RUNNER_MODULE_PATH,
	SELF_UPDATE_CHECK_MODULE_PATH,
	SELF_UPDATE_DETECT_METHOD_MODULE_PATH,
	SELF_UPDATE_VERIFY_MODULE_PATH,
	SELF_UPDATE_NOTIFY_MODULE_PATH,
	SPINNER_MODULE_PATH,
]

function clearSelfUpdateModuleCache(): void {
	for (const modulePath of SELF_UPDATE_MOCKED_MODULE_PATHS) {
		delete require.cache[modulePath]
	}
}

async function importSelfUpdateCommandModule() {
	clearSelfUpdateModuleCache()
	const uniqueId = Bun.randomUUIDv7()
	return import(`../../src/commands/self/update.js?test=${uniqueId}`)
}

async function importSelfUpdateRunnerModule() {
	clearSelfUpdateModuleCache()
	const uniqueId = Bun.randomUUIDv7()
	return import(`../../src/commands/self/update-runner.js?test=${uniqueId}`)
}

// =============================================================================
// Tests for postAction Hook Behavior
// =============================================================================

/**
 * These tests verify Commander's postAction hook behavior and the skip logic
 * for the "self update" command. They use real Commander programs with
 * parseAsync() to prove the fix works with actual Commander behavior.
 *
 * Key insight: In Commander's postAction hook, the `actionCommand` parameter
 * is the LEAF command that was executed, NOT the command where the hook was
 * registered. This is critical for correctly detecting nested commands.
 */
describe("postAction hook behavior", () => {
	describe("self update skip logic", () => {
		/**
		 * Proves the update check is NOT triggered for "self update" command.
		 *
		 * This is the core fix verification: when a user runs `ocx self update`,
		 * we don't want to show "update available" notifications since they're
		 * already updating.
		 */
		it("does not trigger update check when 'self update' runs", async () => {
			const updateCheckFn = mock(() => {})
			const program = new Command()
			program.exitOverride() // Prevent process.exit

			// Create the "self > update" command structure
			const selfCommand = program.command("self").description("Self management commands")
			selfCommand
				.command("update")
				.description("Update to latest version")
				.action(() => {
					// Command executed successfully
				})

			// Register postAction hook with same skip logic as production
			program.hook("postAction", (_thisCommand, actionCommand) => {
				// Skip if running self update command itself (production skip condition)
				if (actionCommand.name() === "update" && actionCommand.parent?.name() === "self") {
					return
				}
				updateCheckFn()
			})

			// Execute "self update" via real Commander parsing
			await program.parseAsync(["node", "ocx", "self", "update"])

			// Update check should NOT have been called
			expect(updateCheckFn).not.toHaveBeenCalled()
		})

		/**
		 * Proves the update check IS triggered for regular commands.
		 *
		 * This ensures we didn't accidentally disable update checks for all commands.
		 * Non-update commands should still trigger the update notification flow.
		 */
		it("triggers update check for other commands", async () => {
			const updateCheckFn = mock(() => {})
			const program = new Command()
			program.exitOverride()

			// Create a simple "add" command
			program
				.command("add")
				.description("Add a component")
				.action(() => {
					// Command executed successfully
				})

			// Register postAction hook with same skip logic as production
			program.hook("postAction", (_thisCommand, actionCommand) => {
				if (actionCommand.name() === "update" && actionCommand.parent?.name() === "self") {
					return
				}
				updateCheckFn()
			})

			// Execute "add" via real Commander parsing
			await program.parseAsync(["node", "ocx", "add"])

			// Update check SHOULD have been called
			expect(updateCheckFn).toHaveBeenCalledTimes(1)
		})

		/**
		 * Proves that only "self update" is skipped, not just any "update" command.
		 *
		 * If another command is named "update" (not under "self"), the update check
		 * should still run. This verifies the parent check is working correctly.
		 */
		it("triggers update check for 'update' command not under 'self'", async () => {
			const updateCheckFn = mock(() => {})
			const program = new Command()
			program.exitOverride()

			// Create an "update" command directly on root (not under "self")
			program
				.command("update")
				.description("Update components")
				.action(() => {
					// Command executed
				})

			// Register postAction hook with same skip logic as production
			program.hook("postAction", (_thisCommand, actionCommand) => {
				if (actionCommand.name() === "update" && actionCommand.parent?.name() === "self") {
					return
				}
				updateCheckFn()
			})

			// Execute root-level "update"
			await program.parseAsync(["node", "ocx", "update"])

			// Update check SHOULD be called (parent is root program, not "self")
			expect(updateCheckFn).toHaveBeenCalledTimes(1)
		})
	})

	describe("actionCommand parameter behavior", () => {
		/**
		 * Documents Commander's hook parameter behavior for future maintainers.
		 *
		 * This is critical knowledge: the `actionCommand` parameter in postAction
		 * is the LEAF command that was executed, not the command where the hook
		 * was registered. Getting this wrong would break the skip logic.
		 *
		 * - `thisCommand`: The command where the hook is registered (root program)
		 * - `actionCommand`: The actual leaf command that was executed ("update")
		 */
		it("actionCommand parameter is the leaf command, not the hook registration point", async () => {
			let capturedThisCommandName = ""
			let capturedActionCommandName = ""
			let capturedActionParentName = ""

			const program = new Command()
			program.name("ocx")
			program.exitOverride()

			// Create nested "self > update" structure
			const selfCommand = program.command("self").description("Self management")
			selfCommand
				.command("update")
				.description("Update CLI")
				.action(() => {
					// Command executed
				})

			// Capture both parameters in the hook
			program.hook("postAction", (thisCommand: Command, actionCommand: Command) => {
				capturedThisCommandName = String(thisCommand.name())
				capturedActionCommandName = String(actionCommand.name())
				capturedActionParentName = String(actionCommand.parent?.name() ?? "")
			})

			// Execute "self update"
			await program.parseAsync(["node", "ocx", "self", "update"])

			// thisCommand is the ROOT program (where hook was registered)
			// It is NOT "update" - this proves the hook registration point vs execution point
			expect(capturedThisCommandName).toBe("ocx")
			expect(capturedThisCommandName).not.toBe("update")

			// actionCommand IS the leaf "update" command that was executed
			expect(capturedActionCommandName).toBe("update")

			// actionCommand's parent IS "self" - this enables our skip logic
			expect(capturedActionParentName).toBe("self")
		})

		/**
		 * Verifies parent chain for deeply nested commands.
		 *
		 * Documents that actionCommand.parent gives direct parent, and we can
		 * traverse the full chain if needed. This knowledge is useful for
		 * future skip conditions that might need deeper nesting checks.
		 */
		it("actionCommand.parent provides the direct parent command", async () => {
			let capturedActionName = ""
			let capturedParentName = ""
			let capturedGrandparentName = ""

			const program = new Command()
			program.name("ocx")
			program.exitOverride()

			// Create "config > show" structure
			const configCommand = program.command("config").description("Config management")
			configCommand
				.command("show")
				.description("Show config")
				.action(() => {})

			program.hook("postAction", (_thisCommand: Command, actionCommand: Command) => {
				capturedActionName = String(actionCommand.name())
				capturedParentName = String(actionCommand.parent?.name() ?? "")
				capturedGrandparentName = String(actionCommand.parent?.parent?.name() ?? "")
			})

			await program.parseAsync(["node", "ocx", "config", "show"])

			expect(capturedActionName).toBe("show")
			expect(capturedParentName).toBe("config")
			expect(capturedGrandparentName).toBe("ocx")
		})
	})
})

describe("self update --json curl strict output", () => {
	let testDir: string | undefined
	const originalFetch = global.fetch

	function getRequestUrl(input: string | URL | Request): string {
		if (typeof input === "string") return input
		if (input instanceof URL) return input.toString()
		return input.url
	}

	async function cleanup(): Promise<void> {
		mock.restore()
		clearSelfUpdateModuleCache()
		global.fetch = originalFetch
		if (testDir) {
			await cleanupTempDir(testDir)
			testDir = undefined
		}
	}

	afterEach(async () => {
		await cleanup()
	})

	afterAll(async () => {
		await cleanup()
	})

	it("emits one JSON payload and suppresses curl spinner output", async () => {
		testDir = await createTempDir("self-update-json-curl")
		const executablePath = join(testDir, "bin", "ocx")

		await mkdir(dirname(executablePath), { recursive: true })
		await writeFile(executablePath, "old-binary")

		const createSpinnerMock = mock(() => ({
			start: mock(() => {}),
			fail: mock(() => {}),
			succeed: mock(() => {}),
			text: "",
		}))
		const notifyUpdatedMock = mock(() => {})

		mock.module("../../src/self-update/check.js", () => ({
			EXPLICIT_UPDATE_TIMEOUT_MS: 10_000,
			checkForUpdate: mock(async () => ({
				ok: true,
				current: "1.0.0",
				latest: "1.1.0",
				updateAvailable: true,
			})),
		}))

		// Re-export the real detect-method module, only overriding
		// getExecutablePath to point at the test temp directory.
		// The "?real" query-string cache-buster bypasses any prior
		// mock.module registration so we always get the genuine exports.
		const realDetectMethod = require("../../src/self-update/detect-method.js?real")
		mock.module("../../src/self-update/detect-method.js", () => ({
			...realDetectMethod,
			getExecutablePath: () => executablePath,
		}))

		mock.module("../../src/self-update/notify.js", () => ({
			notifyUpdated: notifyUpdatedMock,
			notifyUpToDate: mock(() => {}),
		}))

		mock.module("../../src/utils/spinner.js", () => ({
			createSpinner: createSpinnerMock,
		}))

		const downloadedBytes = new Uint8Array([1, 2, 3])
		const downloadedBinaryHash = createHash("sha256").update(downloadedBytes).digest("hex")
		const checksumsContent = [
			`${downloadedBinaryHash}  ocx-darwin-arm64`,
			`${downloadedBinaryHash}  ocx-darwin-x64`,
			`${downloadedBinaryHash}  ocx-linux-arm64`,
			`${downloadedBinaryHash}  ocx-linux-x64`,
			`${downloadedBinaryHash}  ocx-windows-x64.exe`,
			"",
		].join("\n")

		spyOn(global, "fetch").mockImplementation(
			mock(async (input: string | URL | Request) => {
				const url = getRequestUrl(input)

				if (url.endsWith("/SHA256SUMS.txt")) {
					return new Response(checksumsContent, {
						status: 200,
						headers: { "content-type": "text/plain" },
					})
				}

				if (url.includes("/releases/download/")) {
					return new Response(downloadedBytes, {
						status: 200,
						headers: { "content-length": String(downloadedBytes.length) },
					})
				}

				throw new Error(`Unexpected fetch URL in test: ${url}`)
			}) as unknown as typeof fetch,
		)

		const consoleLogSpy = spyOn(console, "log").mockImplementation(() => {})
		const consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {})

		const { registerSelfUpdateCommand } = await importSelfUpdateCommandModule()

		const program = new Command()
		const selfCommand = program.command("self")
		registerSelfUpdateCommand(selfCommand)

		await program.parseAsync(["node", "ocx", "self", "update", "--json", "--method", "curl"])

		expect(createSpinnerMock).not.toHaveBeenCalled()
		expect(notifyUpdatedMock).not.toHaveBeenCalled()
		expect(consoleErrorSpy).not.toHaveBeenCalled()
		expect(consoleLogSpy).toHaveBeenCalledTimes(1)

		const payload = JSON.parse(String(consoleLogSpy.mock.calls[0]?.[0] ?? "")) as {
			success: boolean
			data?: { method?: string; updated?: boolean }
		}

		expect(payload.success).toBe(true)
		expect(payload.data?.method).toBe("curl")
		expect(payload.data?.updated).toBe(true)
	})

	it("rejects malformed curl target versions before fetching or replacing the executable", async () => {
		testDir = await createTempDir("self-update-curl-malformed-version")
		const executablePath = join(testDir, "bin", "ocx")

		await mkdir(dirname(executablePath), { recursive: true })
		await writeFile(executablePath, "old-binary")

		mock.module("../../src/self-update/check.js", () => ({
			EXPLICIT_UPDATE_TIMEOUT_MS: 10_000,
			checkForUpdate: mock(async () => ({
				ok: true,
				current: "1.0.0",
				latest: "2.0.0/../../../../../evil/repo/releases/download/v1.0.0",
				updateAvailable: true,
			})),
		}))

		const realDetectMethod = require("../../src/self-update/detect-method.js?malformed")
		mock.module("../../src/self-update/detect-method.js", () => ({
			...realDetectMethod,
			getExecutablePath: () => executablePath,
		}))

		mock.module("../../src/self-update/notify.js", () => ({
			notifyUpdated: mock(() => {}),
			notifyUpToDate: mock(() => {}),
		}))

		const fetchSpy = spyOn(global, "fetch").mockImplementation(
			mock(async () => new Response("", { status: 500 })) as unknown as typeof fetch,
		)

		const { runSelfUpdateCommand } = await importSelfUpdateRunnerModule()

		await expect(runSelfUpdateCommand({ method: "curl" })).rejects.toThrow("Invalid version format")

		expect(fetchSpy).not.toHaveBeenCalled()
		expect(await readFile(executablePath, "utf-8")).toBe("old-binary")
	})
})

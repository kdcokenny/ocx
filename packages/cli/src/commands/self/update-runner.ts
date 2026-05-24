import {
	type CheckFailure,
	checkForUpdate,
	EXPLICIT_UPDATE_TIMEOUT_MS,
} from "../../self-update/check"
import {
	detectInstallMethod,
	type InstallMethod,
	parseInstallMethod,
} from "../../self-update/detect-method"
import {
	atomicReplace,
	cleanupTempFile,
	downloadToTemp,
	getDownloadUrl,
} from "../../self-update/download"
import { notifyUpdated, notifyUpToDate } from "../../self-update/notify"
import { fetchChecksums, verifyChecksum } from "../../self-update/verify"
import { SelfUpdateError } from "../../utils/errors"
import { outputJson } from "../../utils/json-output"
import { isValidSemver } from "../../utils/semver"
import { createSpinner } from "../../utils/spinner"
import type { UpdateOptions } from "./update"

const UPDATE_ERROR_MESSAGES: Record<CheckFailure["reason"], string> = {
	"dev-version":
		"Cannot check for updates in development mode. Install via npm for update support.",
	timeout: "Update check timed out after 10s. Try again or check your network.",
	"network-error": "Cannot reach npm registry. Verify your internet connection.",
	"invalid-response": "Received invalid response from npm registry. Try again later.",
}

interface SelfUpdateResult {
	current: string
	latest: string
	method: InstallMethod
	updated: boolean
}

export async function runSelfUpdateCommand(options: UpdateOptions): Promise<void> {
	const method = options.method ? parseInstallMethod(options.method) : detectInstallMethod()
	const jsonOutput = options.json === true

	const result = await checkForUpdate(undefined, EXPLICIT_UPDATE_TIMEOUT_MS)
	if (!result.ok) {
		throw new SelfUpdateError(UPDATE_ERROR_MESSAGES[result.reason])
	}

	const { current, latest, updateAvailable } = result
	if (!updateAvailable && !options.force) {
		if (jsonOutput) {
			outputJson({
				success: true,
				data: {
					current,
					latest,
					method,
					updated: false,
				} satisfies SelfUpdateResult,
			})
		} else {
			notifyUpToDate(current)
		}
		return
	}

	const targetVersion = latest
	switch (method) {
		case "curl": {
			await updateViaCurl(current, targetVersion, jsonOutput)
			break
		}

		case "npm":
		case "pnpm":
		case "bun":
		case "yarn":
		case "unknown": {
			await updateViaPackageManager(method, current, targetVersion, jsonOutput)
			break
		}
	}

	if (jsonOutput) {
		outputJson({
			success: true,
			data: {
				current,
				latest: targetVersion,
				method,
				updated: true,
			} satisfies SelfUpdateResult,
		})
	}
}

async function updateViaCurl(
	current: string,
	targetVersion: string,
	jsonOutput: boolean,
): Promise<void> {
	if (!isValidSemver(targetVersion)) {
		throw new SelfUpdateError(`Invalid version format: ${targetVersion}`)
	}

	const url = getDownloadUrl(targetVersion)
	const filename = url.split("/").pop()
	if (!filename) {
		throw new SelfUpdateError("Failed to determine binary filename from download URL")
	}

	const checksums = await fetchChecksums(targetVersion)
	const expectedHash = checksums.get(filename)
	if (!expectedHash) {
		throw new SelfUpdateError(`Security error: No checksum found for ${filename}. Update aborted.`)
	}

	const { tempPath, execPath } = await downloadToTemp(targetVersion, { quiet: jsonOutput })
	try {
		await verifyChecksum(tempPath, expectedHash, filename)
	} catch (error) {
		cleanupTempFile(tempPath)
		throw error
	}

	atomicReplace(tempPath, execPath)
	if (!jsonOutput) {
		notifyUpdated(current, targetVersion)
	}
}

async function runPackageManager(cmd: string[]): Promise<void> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
	const exitCode = await proc.exited
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text()
		throw new SelfUpdateError(`Package manager command failed: ${stderr.trim()}`)
	}
}

async function updateViaPackageManager(
	method: Exclude<InstallMethod, "curl">,
	current: string,
	targetVersion: string,
	jsonOutput: boolean,
): Promise<void> {
	if (!isValidSemver(targetVersion)) {
		throw new SelfUpdateError(`Invalid version format: ${targetVersion}`)
	}

	const spin = jsonOutput ? null : createSpinner({ text: `Updating via ${method}...` })
	spin?.start()

	try {
		switch (method) {
			case "npm": {
				await runPackageManager(["npm", "install", "-g", `ocx@${targetVersion}`])
				break
			}
			case "yarn": {
				await runPackageManager(["yarn", "global", "add", `ocx@${targetVersion}`])
				break
			}
			case "pnpm": {
				await runPackageManager(["pnpm", "install", "-g", `ocx@${targetVersion}`])
				break
			}
			case "bun": {
				await runPackageManager(["bun", "install", "-g", `ocx@${targetVersion}`])
				break
			}
			case "unknown": {
				throw new SelfUpdateError(
					"Could not detect install method. Update manually with one of:\n" +
						"  npm install -g ocx@latest\n" +
						"  pnpm install -g ocx@latest\n" +
						"  bun install -g ocx@latest",
				)
			}
		}

		spin?.succeed(`Updated via ${method}`)
		if (!jsonOutput) {
			notifyUpdated(current, targetVersion)
		}
	} catch (error) {
		if (error instanceof SelfUpdateError) {
			spin?.fail(`Update failed`)
			throw error
		}

		spin?.fail(`Update failed`)
		throw new SelfUpdateError(
			`Failed to run ${method}: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}

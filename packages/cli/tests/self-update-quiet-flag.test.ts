/**
 * Self-Update Hook - Quiet Flag Tests
 *
 * Tests that the update check hook respects the --quiet flag.
 * Violation 2 (P2): validate --quiet allows update notifier to write to stderr
 *
 * These tests verify that:
 * - Update notifier runs normally (baseline)
 * - Update notifier is suppressed with --json
 * - Update notifier is suppressed with --quiet
 * - Update notifier is suppressed with both flags
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Command } from "commander"
import { registerUpdateCheckHook } from "../src/self-update/index"

describe("registerUpdateCheckHook - quiet flag handling", () => {
	let mockCommand: Command
	let hookCallback: (thisCommand: Command, actionCommand: Command) => Promise<void>
	let checkForUpdateSpy: ReturnType<typeof spyOn>
	let notifyUpdateSpy: ReturnType<typeof spyOn>

	// Store original state for restoration
	let originalIsTTYDescriptor: PropertyDescriptor | undefined
	let originalEnv: {
		OCX_SELF_UPDATE?: string
		OCX_NO_UPDATE_CHECK?: string
		CI?: string
	}

	beforeEach(async () => {
		// Capture original isTTY descriptor
		originalIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY")

		// Capture original environment variables
		originalEnv = {
			OCX_SELF_UPDATE: process.env.OCX_SELF_UPDATE,
			OCX_NO_UPDATE_CHECK: process.env.OCX_NO_UPDATE_CHECK,
			CI: process.env.CI,
		}

		// Mock the check and notify modules
		const checkModule = await import("../src/self-update/check")
		const notifyModule = await import("../src/self-update/notify")

		checkForUpdateSpy = spyOn(checkModule, "checkForUpdate").mockResolvedValue({
			ok: true,
			updateAvailable: true,
			current: "1.0.0",
			latest: "2.0.0",
		})

		notifyUpdateSpy = spyOn(notifyModule, "notifyUpdate").mockImplementation(() => {})

		// Create a mock Command
		mockCommand = {
			hook: mock((event: string, callback: typeof hookCallback) => {
				if (event === "postAction") {
					hookCallback = callback
				}
			}),
		} as unknown as Command

		// Set up TTY environment for update checks to run
		Object.defineProperty(process.stdout, "isTTY", {
			value: true,
			configurable: true,
		})

		// Clear any env vars that would skip the check
		delete process.env.OCX_SELF_UPDATE
		delete process.env.OCX_NO_UPDATE_CHECK
		delete process.env.CI
	})

	afterEach(() => {
		// Restore spies
		checkForUpdateSpy.mockRestore()
		notifyUpdateSpy.mockRestore()

		// Restore isTTY descriptor
		if (originalIsTTYDescriptor !== undefined) {
			Object.defineProperty(process.stdout, "isTTY", originalIsTTYDescriptor)
		} else {
			delete (process.stdout as { isTTY?: boolean }).isTTY
		}

		// Restore environment variables
		if (originalEnv.OCX_SELF_UPDATE !== undefined) {
			process.env.OCX_SELF_UPDATE = originalEnv.OCX_SELF_UPDATE
		} else {
			delete process.env.OCX_SELF_UPDATE
		}

		if (originalEnv.OCX_NO_UPDATE_CHECK !== undefined) {
			process.env.OCX_NO_UPDATE_CHECK = originalEnv.OCX_NO_UPDATE_CHECK
		} else {
			delete process.env.OCX_NO_UPDATE_CHECK
		}

		if (originalEnv.CI !== undefined) {
			process.env.CI = originalEnv.CI
		} else {
			delete process.env.CI
		}
	})

	it("should run update notifier normally (baseline)", async () => {
		// Register the hook
		registerUpdateCheckHook(mockCommand)

		// Simulate a command action
		const actionCommand = {
			name: () => "validate",
			parent: { name: () => "root" },
			opts: () => ({}), // No flags
		} as unknown as Command

		// Run the hook
		await hookCallback(mockCommand, actionCommand)

		// Verify update check ran
		expect(checkForUpdateSpy).toHaveBeenCalled()
		expect(notifyUpdateSpy).toHaveBeenCalledWith("1.0.0", "2.0.0")
	})

	it("should suppress update notifier with --json flag", async () => {
		// Register the hook
		registerUpdateCheckHook(mockCommand)

		// Simulate a command action with --json
		const actionCommand = {
			name: () => "validate",
			parent: { name: () => "root" },
			opts: () => ({ json: true }),
		} as unknown as Command

		// Run the hook
		await hookCallback(mockCommand, actionCommand)

		// Verify update check did NOT run
		expect(checkForUpdateSpy).not.toHaveBeenCalled()
		expect(notifyUpdateSpy).not.toHaveBeenCalled()
	})

	it("should suppress update notifier with --quiet flag", async () => {
		// Register the hook
		registerUpdateCheckHook(mockCommand)

		// Simulate a command action with --quiet
		const actionCommand = {
			name: () => "validate",
			parent: { name: () => "root" },
			opts: () => ({ quiet: true }),
		} as unknown as Command

		// Run the hook
		await hookCallback(mockCommand, actionCommand)

		// Verify update check did NOT run
		expect(checkForUpdateSpy).not.toHaveBeenCalled()
		expect(notifyUpdateSpy).not.toHaveBeenCalled()
	})

	it("should suppress update notifier with both --json and --quiet flags", async () => {
		// Register the hook
		registerUpdateCheckHook(mockCommand)

		// Simulate a command action with both flags
		const actionCommand = {
			name: () => "validate",
			parent: { name: () => "root" },
			opts: () => ({ json: true, quiet: true }),
		} as unknown as Command

		// Run the hook
		await hookCallback(mockCommand, actionCommand)

		// Verify update check did NOT run
		expect(checkForUpdateSpy).not.toHaveBeenCalled()
		expect(notifyUpdateSpy).not.toHaveBeenCalled()
	})

	it("should skip update notifier for 'self update' command", async () => {
		// Register the hook
		registerUpdateCheckHook(mockCommand)

		// Simulate 'self update' command
		const actionCommand = {
			name: () => "update",
			parent: { name: () => "self" },
			opts: () => ({}),
		} as unknown as Command

		// Run the hook
		await hookCallback(mockCommand, actionCommand)

		// Verify update check did NOT run
		expect(checkForUpdateSpy).not.toHaveBeenCalled()
		expect(notifyUpdateSpy).not.toHaveBeenCalled()
	})
})

import { describe, expect, it, mock } from "bun:test"
import { Command } from "commander"

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
			let capturedThisCommand: Command | null = null
			let capturedActionCommand: Command | null = null

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
			program.hook("postAction", (thisCommand, actionCommand) => {
				capturedThisCommand = thisCommand
				capturedActionCommand = actionCommand
			})

			// Execute "self update"
			await program.parseAsync(["node", "ocx", "self", "update"])

			// Verify captured commands
			expect(capturedThisCommand).not.toBeNull()
			expect(capturedActionCommand).not.toBeNull()

			// thisCommand is the ROOT program (where hook was registered)
			// It is NOT "update" - this proves the hook registration point vs execution point
			expect(capturedThisCommand?.name()).toBe("ocx")
			expect(capturedThisCommand?.name()).not.toBe("update")

			// actionCommand IS the leaf "update" command that was executed
			expect(capturedActionCommand?.name()).toBe("update")

			// actionCommand's parent IS "self" - this enables our skip logic
			expect(capturedActionCommand?.parent?.name()).toBe("self")
		})

		/**
		 * Verifies parent chain for deeply nested commands.
		 *
		 * Documents that actionCommand.parent gives direct parent, and we can
		 * traverse the full chain if needed. This knowledge is useful for
		 * future skip conditions that might need deeper nesting checks.
		 */
		it("actionCommand.parent provides the direct parent command", async () => {
			let capturedActionCommand: Command | null = null

			const program = new Command()
			program.name("ocx")
			program.exitOverride()

			// Create "config > show" structure
			const configCommand = program.command("config").description("Config management")
			configCommand
				.command("show")
				.description("Show config")
				.action(() => {})

			program.hook("postAction", (_thisCommand, actionCommand) => {
				capturedActionCommand = actionCommand
			})

			await program.parseAsync(["node", "ocx", "config", "show"])

			expect(capturedActionCommand).not.toBeNull()
			expect(capturedActionCommand?.name()).toBe("show")
			expect(capturedActionCommand?.parent?.name()).toBe("config")
			expect(capturedActionCommand?.parent?.parent?.name()).toBe("ocx")
		})
	})
})

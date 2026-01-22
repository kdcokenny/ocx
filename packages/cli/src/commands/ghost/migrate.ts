/**
 * Ghost Migrate Command (TEMPORARY)
 *
 * Migrates legacy ghost mode configs to the unified profile system.
 * Will be removed in the next minor version.
 */

import {
	copyFileSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmdirSync,
	rmSync,
	unlinkSync,
} from "node:fs"
import path from "node:path"
import type { Command } from "commander"
import { getProfilesDir, OCX_CONFIG_FILE } from "../../profile/paths"
import { handleError } from "../../utils/handle-error"

/** Legacy ghost config file name */
const GHOST_CONFIG_FILE = "ghost.jsonc"
/** Backup file extension */
const BACKUP_EXT = ".bak"
/** Legacy symlink for stateful profile selection */
const CURRENT_SYMLINK = "current"
/** Directories to flatten from .opencode/ to profile root */
const FLATTEN_DIRS = ["plugin", "agent", "skill", "command"] as const

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Move a file or directory atomically, with cross-device (EXDEV) fallback.
 * On same filesystem: uses fast rename.
 * On cross-device: copies then removes source.
 */
function moveAtomically(source: string, destination: string, isDir: boolean): void {
	try {
		renameSync(source, destination)
	} catch (err: unknown) {
		if (err instanceof Error && "code" in err && err.code === "EXDEV") {
			// Cross-device: copy then remove
			if (isDir) {
				cpSync(source, destination, { recursive: true })
				rmSync(source, { recursive: true, force: true })
			} else {
				copyFileSync(source, destination)
				unlinkSync(source)
			}
		} else {
			throw err
		}
	}
}

// =============================================================================
// TYPES
// =============================================================================

interface ProfileAction {
	type: "rename" | "move-dir"
	profileName: string
	source: string
	destination: string
	backup: string
}

interface SymlinkAction {
	type: "delete-symlink"
	path: string
}

interface SkippedProfile {
	profileName: string
	reason: string
}

interface MigrationPlan {
	profiles: ProfileAction[]
	skipped: SkippedProfile[]
	symlink: SymlinkAction | null
	symlinkSkipped: { path: string; reason: string } | null
}

// =============================================================================
// PLAN PHASE
// =============================================================================

/**
 * Plan phase: Discover what needs to be migrated without any I/O mutations.
 * Follows Law of Atomic Predictability - pure function with no side effects.
 */
function planMigration(): MigrationPlan {
	const profilesDir = getProfilesDir()
	const plan: MigrationPlan = {
		profiles: [],
		skipped: [],
		symlink: null,
		symlinkSkipped: null,
	}

	// Early exit: profiles directory doesn't exist
	if (!existsSync(profilesDir)) {
		return plan
	}

	// Discover profiles with ghost.jsonc
	const entries = readdirSync(profilesDir, { withFileTypes: true })
	for (const entry of entries) {
		// Skip non-directories and the legacy symlink
		if (!entry.isDirectory() || entry.name === CURRENT_SYMLINK) continue

		const profileName = entry.name
		const ghostConfig = path.join(profilesDir, profileName, GHOST_CONFIG_FILE)
		const ocxConfig = path.join(profilesDir, profileName, OCX_CONFIG_FILE)

		// Skip if no ghost.jsonc exists
		if (!existsSync(ghostConfig)) continue

		// Check for conflict: ocx.jsonc already exists
		if (existsSync(ocxConfig)) {
			plan.skipped.push({
				profileName,
				reason: `${OCX_CONFIG_FILE} already exists`,
			})
			continue
		}

		// Check for conflict: backup file already exists (prevents overwriting pre-existing .bak)
		const backupPath = ghostConfig + BACKUP_EXT
		if (existsSync(backupPath)) {
			plan.skipped.push({
				profileName,
				reason: `backup file already exists: ${GHOST_CONFIG_FILE}${BACKUP_EXT}`,
			})
			continue
		}

		plan.profiles.push({
			type: "rename",
			profileName,
			source: ghostConfig,
			destination: ocxConfig,
			backup: backupPath,
		})
	}

	// Plan .opencode/ flattening for each profile
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name === CURRENT_SYMLINK) continue

		const profileName = entry.name
		const profileDir = path.join(profilesDir, profileName)
		const dotOpencode = path.join(profileDir, ".opencode")

		// Skip if no .opencode directory
		if (!existsSync(dotOpencode)) continue

		for (const dir of FLATTEN_DIRS) {
			const source = path.join(dotOpencode, dir)
			const destination = path.join(profileDir, dir)

			// Skip if source doesn't exist
			if (!existsSync(source)) continue

			// Verify source is actually a directory
			try {
				const stat = lstatSync(source)
				if (!stat.isDirectory()) {
					plan.skipped.push({
						profileName,
						reason: `.opencode/${dir} is not a directory`,
					})
					continue
				}
			} catch {
				continue // Can't stat, skip
			}

			// Check for conflict: destination already exists
			if (existsSync(destination)) {
				plan.skipped.push({
					profileName,
					reason: `${dir}/ exists in both .opencode/ and profile root`,
				})
				continue
			}

			// Check for backup conflict
			const backupPath = source + BACKUP_EXT
			if (existsSync(backupPath)) {
				plan.skipped.push({
					profileName,
					reason: `backup already exists: .opencode/${dir}${BACKUP_EXT}`,
				})
				continue
			}

			plan.profiles.push({
				type: "move-dir",
				profileName,
				source,
				destination,
				backup: backupPath,
			})
		}
	}

	// Check profiles/current symlink
	const currentPath = path.join(profilesDir, CURRENT_SYMLINK)
	if (existsSync(currentPath)) {
		try {
			const stat = lstatSync(currentPath)
			if (stat.isSymbolicLink()) {
				plan.symlink = { type: "delete-symlink", path: currentPath }
			} else if (stat.isDirectory()) {
				plan.symlinkSkipped = { path: currentPath, reason: "is a directory, not a symlink" }
			} else {
				plan.symlinkSkipped = { path: currentPath, reason: "is a file, not a symlink" }
			}
		} catch (error) {
			plan.symlinkSkipped = {
				path: currentPath,
				reason: `cannot access: ${error instanceof Error ? error.message : "unknown error"}`,
			}
		}
	}

	return plan
}

// =============================================================================
// EXECUTE PHASE
// =============================================================================

/**
 * Execute phase: Perform the migration with backup and rollback support.
 * Follows Law of Fail Fast - any failure triggers immediate rollback.
 *
 * Flow:
 * 1. Create backups (ghost.jsonc -> ghost.jsonc.bak)
 * 2. Rename original to destination (ghost.jsonc -> ocx.jsonc)
 * 3. Delete symlink if exists
 * 4. On success: delete backups
 * 5. On failure: rollback everything
 */
function executeMigration(plan: MigrationPlan): void {
	const completedBackups: { path: string; isDir: boolean }[] = []
	const completedRenames: {
		source: string
		destination: string
		backup: string
		isDir: boolean
	}[] = []

	try {
		// Step 1: Create backups first (copy, not move)
		for (const action of plan.profiles) {
			if (action.type === "rename") {
				copyFileSync(action.source, action.backup)
			} else {
				// move-dir: recursive copy for directories
				cpSync(action.source, action.backup, { recursive: true })
			}
			completedBackups.push({ path: action.backup, isDir: action.type === "move-dir" })
		}

		// Step 2: Move originals to destinations (handles cross-device)
		for (const action of plan.profiles) {
			moveAtomically(action.source, action.destination, action.type === "move-dir")
			completedRenames.push({
				source: action.source,
				destination: action.destination,
				backup: action.backup,
				isDir: action.type === "move-dir",
			})
		}

		// Step 3: Delete symlink (re-verify it's still a symlink to prevent TOCTOU race)
		if (plan.symlink) {
			try {
				const stat = lstatSync(plan.symlink.path)
				if (stat.isSymbolicLink()) {
					unlinkSync(plan.symlink.path)
				}
			} catch {
				// File no longer exists or can't be accessed, skip
			}
		}

		// Step 4: Success! Delete backups
		for (const backup of completedBackups) {
			try {
				if (backup.isDir) {
					rmSync(backup.path, { recursive: true, force: true })
				} else {
					unlinkSync(backup.path)
				}
			} catch {
				// Best effort cleanup, ignore errors
			}
		}
	} catch (error) {
		// Rollback: restore from backups
		for (const rename of completedRenames) {
			try {
				// Remove destination if it exists
				if (existsSync(rename.destination)) {
					if (rename.isDir) {
						rmSync(rename.destination, { recursive: true, force: true })
					} else {
						unlinkSync(rename.destination)
					}
				}
				// Ensure parent directory exists before restoring
				mkdirSync(path.dirname(rename.source), { recursive: true })
				// Restore from backup
				if (existsSync(rename.backup)) {
					if (rename.isDir) {
						cpSync(rename.backup, rename.source, { recursive: true })
					} else {
						copyFileSync(rename.backup, rename.source)
					}
				}
			} catch {
				// Best effort rollback
			}
		}

		// Clean up any remaining backups
		for (const backup of completedBackups) {
			try {
				if (existsSync(backup.path)) {
					if (backup.isDir) {
						rmSync(backup.path, { recursive: true, force: true })
					} else {
						unlinkSync(backup.path)
					}
				}
			} catch {
				// Best effort cleanup
			}
		}

		throw error
	}

	// Step 5: Best-effort cleanup of empty .opencode/ directories
	// Runs AFTER backups are deleted to avoid triggering rollback on cleanup failure
	try {
		const processedProfiles = new Set(
			plan.profiles.filter((a) => a.type === "move-dir").map((a) => a.profileName),
		)
		for (const profileName of processedProfiles) {
			const profileDir = path.join(getProfilesDir(), profileName)
			const dotOpencode = path.join(profileDir, ".opencode")

			if (existsSync(dotOpencode)) {
				const remaining = readdirSync(dotOpencode)
				// Remove only if empty
				if (remaining.length === 0) {
					try {
						rmdirSync(dotOpencode)
					} catch {
						// Best effort
					}
				}
			}
		}
	} catch {
		// Best effort cleanup - don't fail the migration for cleanup issues
	}
}

// =============================================================================
// OUTPUT
// =============================================================================

/**
 * Print the migration plan (for dry-run or after execution).
 */
function printPlan(plan: MigrationPlan, dryRun: boolean): void {
	const prefix = dryRun ? "[DRY-RUN] " : ""

	// Early exit: nothing to do
	if (
		plan.profiles.length === 0 &&
		plan.skipped.length === 0 &&
		!plan.symlink &&
		!plan.symlinkSkipped
	) {
		console.log(`${prefix}Nothing to migrate.`)
		return
	}

	console.log(`${prefix}🔄 Migrating from ghost mode...\n`)

	// Print profile actions
	if (plan.profiles.length > 0 || plan.skipped.length > 0) {
		console.log("Profiles:")
		for (const action of plan.profiles) {
			if (action.type === "rename") {
				console.log(`  ✓ ${action.profileName}: ${GHOST_CONFIG_FILE} → ${OCX_CONFIG_FILE}`)
			} else {
				// move-dir
				const dirName = path.basename(action.source)
				console.log(`  ✓ ${action.profileName}: .opencode/${dirName}/ → ${dirName}/`)
			}
		}
		for (const skipped of plan.skipped) {
			console.log(`  ⚠ ${skipped.profileName}: skipped (${skipped.reason})`)
		}
		console.log()
	}

	// Print symlink actions
	if (plan.symlink || plan.symlinkSkipped) {
		console.log("Symlink:")
		if (plan.symlink) {
			console.log(`  ✓ Removed profiles/${CURRENT_SYMLINK}`)
		}
		if (plan.symlinkSkipped) {
			console.log(`  ⚠ profiles/${CURRENT_SYMLINK}: skipped (${plan.symlinkSkipped.reason})`)
		}
		console.log()
	}

	if (!dryRun && (plan.profiles.length > 0 || plan.symlink)) {
		console.log("✅ Migration complete!")
	}
}

// =============================================================================
// COMMAND
// =============================================================================

interface MigrateOptions {
	dryRun?: boolean
}

/**
 * The migrate command handler.
 */
async function runMigrate(options: MigrateOptions): Promise<void> {
	const plan = planMigration()

	// Dry-run: just print the plan
	if (options.dryRun) {
		printPlan(plan, true)
		return
	}

	// Early exit: nothing to migrate
	if (plan.profiles.length === 0 && !plan.symlink) {
		printPlan(plan, false)
		return
	}

	// Execute and print results
	executeMigration(plan)
	printPlan(plan, false)
}

/**
 * Register the ghost migrate command.
 */
export function registerGhostMigrateCommand(ghost: Command): void {
	ghost
		.command("migrate")
		.description("Migrate from ghost mode to unified profile system")
		.option("--dry-run", "Preview changes without making them")
		.action(async (options: MigrateOptions) => {
			try {
				await runMigrate(options)
			} catch (error) {
				handleError(error)
			}
		})
}

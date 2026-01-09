/**
 * Terminal title and tmux window naming utilities.
 *
 * Provides cross-environment terminal identification by setting both
 * the terminal title (via ANSI OSC escape) and tmux window name (if applicable).
 */

import path from "node:path"
import { isTTY } from "./env.js"
import type { GitInfo } from "./git-context.js"

const MAX_BRANCH_LENGTH = 20

/**
 * Checks if the current process is running inside a tmux session.
 *
 * @returns true if inside tmux, false otherwise
 *
 * @example
 * ```ts
 * if (isInsideTmux()) {
 *   console.log("Running inside tmux")
 * }
 * ```
 */
export function isInsideTmux(): boolean {
	return Boolean(process.env.TMUX)
}

/**
 * Sets the tmux window name for the current session.
 *
 * This function:
 * 1. Renames the current window to the specified name
 * 2. Disables automatic-rename to prevent tmux from overwriting it
 *
 * @param name - The name to set for the tmux window
 *
 * @example
 * ```ts
 * setTmuxWindowName("ghost: my-project")
 * ```
 */
export function setTmuxWindowName(name: string): void {
	// Early exit: not inside tmux
	if (!isInsideTmux()) {
		return
	}

	// Rename the current window
	Bun.spawnSync(["tmux", "rename-window", name])

	// Disable automatic-rename to prevent tmux from overwriting our name
	Bun.spawnSync(["tmux", "set-window-option", "automatic-rename", "off"])
}

/**
 * Sets the terminal title using ANSI OSC escape sequence.
 *
 * Uses OSC 0 (Operating System Command) which sets both window title
 * and icon name on supported terminals.
 *
 * @param title - The title to set for the terminal window
 *
 * @example
 * ```ts
 * setTerminalTitle("ghost: my-project")
 * ```
 */
export function setTerminalTitle(title: string): void {
	// Early exit: not a TTY
	if (!isTTY) {
		return
	}

	// OSC 0: Set window title and icon name
	// Format: ESC ] 0 ; <title> BEL
	process.stdout.write(`\x1b]0;${title}\x07`)
}

/**
 * Sets the terminal name across all supported environments.
 *
 * This is the main export that handles both:
 * - tmux window naming (if inside tmux)
 * - Standard terminal title (via ANSI escape)
 *
 * @param name - The name to set for the terminal
 *
 * @example
 * ```ts
 * // In ghost opencode command
 * setTerminalName(`ghost: ${projectName}`)
 * ```
 */
export function setTerminalName(name: string): void {
	setTmuxWindowName(name)
	setTerminalTitle(name)
}

/**
 * Formats the terminal name for ghost mode sessions.
 *
 * Format: ghost[profileName]:repoName/branch
 *
 * @param cwd - Current working directory
 * @param profileName - Active profile name
 * @param gitInfo - Git repository information
 * @returns Formatted terminal name
 *
 * @example
 * ```ts
 * formatTerminalName("/path/to/repo", "default", { repoName: "ocx", branch: "main" })
 * // Returns: "ghost[default]:ocx/main"
 *
 * formatTerminalName("/path/to/repo", "work", { repoName: null, branch: null })
 * // Returns: "ghost[work]:repo"
 * ```
 */
export function formatTerminalName(cwd: string, profileName: string, gitInfo: GitInfo): string {
	const repoName = gitInfo.repoName ?? path.basename(cwd)

	// Early exit: no branch info
	if (!gitInfo.branch) {
		return `ghost[${profileName}]:${repoName}`
	}

	// Truncate long branch names to keep terminal title readable
	const branch =
		gitInfo.branch.length > MAX_BRANCH_LENGTH
			? `${gitInfo.branch.slice(0, MAX_BRANCH_LENGTH - 3)}...`
			: gitInfo.branch

	return `ghost[${profileName}]:${repoName}/${branch}`
}

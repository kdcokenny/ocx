/**
 * Terminal detection utilities.
 *
 * Provides functions to detect the current terminal environment,
 * particularly useful for choosing terminal-specific behaviors.
 *
 * @module kdco-primitives/terminal-detect
 */

/**
 * Check if the current process is running inside a tmux session.
 *
 * Detects tmux by checking the TMUX environment variable, which tmux
 * sets to the socket path and session info when spawning child processes.
 *
 * @returns `true` if running inside tmux, `false` otherwise
 *
 * @example
 * ```ts
 * if (isInsideTmux()) {
 *   // Use tmux-specific commands (new-window, split-pane, etc.)
 *   await openTmuxWindow({ windowName: "dev", cwd: projectDir })
 * } else {
 *   // Fall back to platform-specific terminal
 *   await openPlatformTerminal(projectDir)
 * }
 * ```
 */
export function isInsideTmux(): boolean {
	// Law 1: Early Exit - simple boolean check, no complex parsing needed
	// The TMUX env var contains socket info like "/tmp/tmux-1000/default,12345,0"
	// We only care if it's set (truthy), not its contents
	return !!process.env.TMUX
}

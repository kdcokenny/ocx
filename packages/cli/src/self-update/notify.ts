// Copyright 2024-2026 the OCX authors. MIT license.

import kleur from "kleur"

/**
 * Display "already up to date" message.
 *
 * Output format:
 *   info: ocx unchanged - 1.2.2
 */
export function notifyUpToDate(version: string): void {
	console.error(`${kleur.cyan("info")}: ocx unchanged - ${kleur.dim(version)}`)
}

/**
 * Display successful update message.
 *
 * Output format:
 *     ocx updated - 1.3.0 (from 1.2.2)
 */
export function notifyUpdated(from: string, to: string): void {
	console.error(`  ${kleur.green("ocx updated")} - ${to} (from ${from})`)
}

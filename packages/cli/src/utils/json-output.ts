/**
 * JSON output utilities for CI/CD integration
 * Following GitHub CLI patterns for consistent --json flag handling
 */

import type { ErrorCode } from "./errors"

// JSON response envelope
export interface JsonResponse<T = unknown> {
	success: boolean
	data?: T
	error?: {
		code: ErrorCode
		message: string
	}
	meta?: {
		timestamp: string
		version: string
	}
}

/**
 * Output data as JSON
 */
export function outputJson(data: unknown): void {
	console.log(JSON.stringify(data, null, 2))
}

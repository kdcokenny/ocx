import { z } from "zod"

export type ActiveLaunchContext =
	| { mode: "plain" }
	| { mode: "ocx"; ocxBin: string; profile: string }

export type PersistedLaunchMetadata =
	| { mode: "plain" }
	| { mode: "ocx"; ocxBin: string; profile: string }

export interface PersistedLaunchMetadataInput {
	launchMode?: string | null
	ocxBin?: string | null
	profile?: string | null
}

const ocxContextMarkerSchema = z.literal("1")

function normalizeOptionalNonEmpty(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim()
	return trimmed ? trimmed : undefined
}

function requireNonEmptyField(
	value: string | undefined,
	fieldName: string,
	source: string,
): string {
	if (value) {
		return value
	}

	throw new Error(`${source} requires ${fieldName} to be set to a non-empty value`)
}

export function parseActiveLaunchContext(
	env: Record<string, string | undefined> = process.env,
): ActiveLaunchContext {
	const markerResult = ocxContextMarkerSchema.safeParse(env.OCX_CONTEXT?.trim())
	if (!markerResult.success) {
		return { mode: "plain" }
	}

	const ocxBin = requireNonEmptyField(
		normalizeOptionalNonEmpty(env.OCX_BIN),
		"OCX_BIN",
		"Invalid OCX launch context (OCX_CONTEXT=1)",
	)
	const profile = requireNonEmptyField(
		normalizeOptionalNonEmpty(env.OCX_PROFILE),
		"OCX_PROFILE",
		"Invalid OCX launch context (OCX_CONTEXT=1)",
	)

	return {
		mode: "ocx",
		ocxBin,
		profile,
	}
}

export function parsePersistedLaunchMetadata(
	input: PersistedLaunchMetadataInput,
): PersistedLaunchMetadata {
	const launchMode = normalizeOptionalNonEmpty(input.launchMode)

	// Legacy rows did not persist launch metadata - treat as plain for backward compatibility.
	if (!launchMode) {
		return { mode: "plain" }
	}

	if (launchMode === "plain") {
		return { mode: "plain" }
	}

	if (launchMode !== "ocx") {
		throw new Error(`Invalid persisted launch metadata: unsupported launchMode "${launchMode}"`)
	}

	const ocxBin = requireNonEmptyField(
		normalizeOptionalNonEmpty(input.ocxBin),
		"ocxBin",
		"Invalid persisted launch metadata (launchMode=ocx)",
	)
	const profile = requireNonEmptyField(
		normalizeOptionalNonEmpty(input.profile),
		"profile",
		"Invalid persisted launch metadata (launchMode=ocx)",
	)

	return {
		mode: "ocx",
		ocxBin,
		profile,
	}
}

export function buildSessionLaunchArgv(
	sessionID: string,
	launchMetadata: ActiveLaunchContext | PersistedLaunchMetadata,
): string[] {
	const normalizedSessionID = normalizeOptionalNonEmpty(sessionID)
	if (!normalizedSessionID) {
		throw new Error("Session id is required to build launch argv")
	}

	if (launchMetadata.mode === "plain") {
		return ["opencode", "--session", normalizedSessionID]
	}

	return [
		launchMetadata.ocxBin,
		"opencode",
		"-p",
		launchMetadata.profile,
		"--session",
		normalizedSessionID,
	]
}

export function toPersistedLaunchMetadata(
	launchContext: ActiveLaunchContext,
): PersistedLaunchMetadata {
	if (launchContext.mode === "plain") {
		return { mode: "plain" }
	}

	return {
		mode: "ocx",
		ocxBin: launchContext.ocxBin,
		profile: launchContext.profile,
	}
}

export function serializePersistedLaunchMetadata(metadata: PersistedLaunchMetadata): {
	launchMode: "plain" | "ocx"
	profile: string | null
	ocxBin: string | null
} {
	if (metadata.mode === "plain") {
		return {
			launchMode: "plain",
			profile: null,
			ocxBin: null,
		}
	}

	return {
		launchMode: "ocx",
		profile: metadata.profile,
		ocxBin: metadata.ocxBin,
	}
}

export interface OscTitleContext {
	readonly mayWriteOscTitle: boolean
	readonly baseTitle: string
}

const OCX_TITLE_CONTEXT_ENV_KEY = "OCX_TITLE_CONTEXT"
const OSC_TITLE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g

function toNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null
	}

	const normalized = value.trim()
	if (!normalized) {
		return null
	}

	return normalized
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseOscTitleContext(
	env: Record<string, string | undefined> = process.env,
): OscTitleContext | null {
	const rawContext = toNonEmptyString(env[OCX_TITLE_CONTEXT_ENV_KEY])
	if (!rawContext) {
		return null
	}

	let parsedContext: unknown
	try {
		parsedContext = JSON.parse(rawContext)
	} catch {
		return null
	}

	if (!isRecord(parsedContext)) {
		return null
	}

	if (typeof parsedContext.mayWriteOscTitle !== "boolean") {
		return null
	}

	const baseTitle = toNonEmptyString(parsedContext.baseTitle)
	if (!baseTitle) {
		return null
	}

	return {
		mayWriteOscTitle: parsedContext.mayWriteOscTitle,
		baseTitle,
	}
}

export function sanitizeOscTitleText(title: string): string {
	return title.replace(OSC_TITLE_CONTROL_CHARACTERS, " ").trim()
}

export function writeOscTitleBestEffort(
	title: string,
	writer: Pick<NodeJS.WriteStream, "write"> = process.stdout,
): void {
	const sanitizedTitle = sanitizeOscTitleText(title)
	if (!sanitizedTitle) {
		return
	}

	queueMicrotask(() => {
		try {
			writer.write(`\u001B]0;${sanitizedTitle}\u0007`)
		} catch {
			// Best-effort: title ownership belongs to launcher cleanup semantics.
		}
	})
}

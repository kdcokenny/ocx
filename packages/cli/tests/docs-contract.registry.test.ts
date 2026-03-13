import { describe, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { runRegistryListCore } from "../src/commands/registry"
import { BUILTIN_COMPONENT_TYPES } from "../src/schemas/registry"
import { cleanupTempDir, createTempDir, expectStrictJsonSuccess, runCLIIsolated } from "./helpers"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")

const REGISTRY_CLI_DOC_PATH = join(REPO_ROOT, "docs", "cli", "registry.mdx")
const REGISTRY_STARTER_AGENTS_PATH = join(REPO_ROOT, "examples", "registry-starter", "AGENTS.md")
const OCX_KIT_AGENTS_PATH = join(REPO_ROOT, "workers", "ocx-kit", "AGENTS.md")

function expectObject(value: unknown, label: string): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>
	}

	throw new Error(`${label} must be a JSON object. Received: ${JSON.stringify(value)}`)
}

function expectString(value: unknown, label: string): string {
	if (typeof value === "string" && value.trim().length > 0) {
		return value
	}

	throw new Error(`${label} must be a non-empty string. Received: ${JSON.stringify(value)}`)
}

function expectBoolean(value: unknown, label: string): boolean {
	if (typeof value === "boolean") {
		return value
	}

	throw new Error(`${label} must be a boolean. Received: ${JSON.stringify(value)}`)
}

function extractBalancedJsonObjects(source: string, label: string): string[] {
	let depth = 0
	let inString = false
	let isEscaped = false
	let objectStart = -1
	const objects: string[] = []

	for (let index = 0; index < source.length; index += 1) {
		const char = source[index]
		if (!char) {
			continue
		}

		if (inString) {
			if (isEscaped) {
				isEscaped = false
				continue
			}

			if (char === "\\") {
				isEscaped = true
				continue
			}

			if (char === '"') {
				inString = false
			}

			continue
		}

		if (char === '"') {
			inString = true
			continue
		}

		if (char === "{") {
			if (depth === 0) {
				objectStart = index
			}

			depth += 1
			continue
		}

		if (char === "}") {
			if (depth === 0) {
				continue
			}

			depth -= 1
			if (depth === 0 && objectStart >= 0) {
				objects.push(source.slice(objectStart, index + 1))
				objectStart = -1
			}
		}
	}

	if (depth !== 0) {
		throw new Error(`${label}: Found unterminated JSON object in fenced code block.`)
	}

	if (objects.length === 0) {
		throw new Error(`${label}: Could not find any JSON object in fenced code block.`)
	}

	return objects
}

interface MarkdownCodeBlock {
	language: string
	content: string
	startLine: number
	endLine: number
}

function isFenceLine(
	line: string,
): { fenceChar: "`" | "~"; length: number; language: string } | null {
	const match = line.match(/^\s*(`{3,}|~{3,})(.*)$/)
	if (!match?.[1]) {
		return null
	}

	const fence = match[1]
	const fenceChar = fence[0]
	if (fenceChar !== "`" && fenceChar !== "~") {
		return null
	}

	return {
		fenceChar,
		length: fence.length,
		language: match[2]?.trim() ?? "",
	}
}

function isFenceCloser(line: string, fenceChar: "`" | "~", minLength: number): boolean {
	const trimmed = line.trim()
	if (trimmed.length < minLength) {
		return false
	}

	for (const char of trimmed) {
		if (char !== fenceChar) {
			return false
		}
	}

	return true
}

function extractMarkdownCodeBlocks(markdown: string, fileLabel: string): MarkdownCodeBlock[] {
	const lines = markdown.split(/\r?\n/)
	const codeBlocks: MarkdownCodeBlock[] = []

	for (let index = 0; index < lines.length; index += 1) {
		const openingFence = isFenceLine(lines[index] ?? "")
		if (!openingFence) {
			continue
		}

		const contentStart = index + 1
		const contentLines: string[] = []
		let closingLine = -1

		for (let cursor = contentStart; cursor < lines.length; cursor += 1) {
			if (isFenceCloser(lines[cursor] ?? "", openingFence.fenceChar, openingFence.length)) {
				closingLine = cursor
				break
			}

			contentLines.push(lines[cursor] ?? "")
		}

		if (closingLine < 0) {
			throw new Error(`${fileLabel}: Unterminated fenced code block starting at line ${index + 1}.`)
		}

		codeBlocks.push({
			language: openingFence.language,
			content: contentLines.join("\n"),
			startLine: index + 1,
			endLine: closingLine + 1,
		})

		index = closingLine
	}

	return codeBlocks
}

function extractRegistryListJsonExample(
	markdown: string,
	fileLabel: string,
): Record<string, unknown> {
	const commandPattern = /^\s*(?:[$>#]\s*)?ocx\s+registry\s+list\b[^\n]*\s--json(?:\s|$)/m
	const codeBlocks = extractMarkdownCodeBlocks(markdown, fileLabel)
	const registryListBlocks = codeBlocks.filter((block) => commandPattern.test(block.content))

	if (registryListBlocks.length === 0) {
		throw new Error(
			`${fileLabel}: Could not find a fenced code block containing 'ocx registry list --json'.`,
		)
	}

	const blocksWithJson: Array<{ block: MarkdownCodeBlock; jsonCandidates: string[] }> = []
	const extractionFailures: string[] = []

	for (const block of registryListBlocks) {
		const label = `${fileLabel}: registry list output block at lines ${block.startLine}-${block.endLine}`

		try {
			blocksWithJson.push({
				block,
				jsonCandidates: extractBalancedJsonObjects(block.content, label),
			})
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			extractionFailures.push(message)
		}
	}

	if (blocksWithJson.length === 0) {
		const locations = registryListBlocks.map((block) => `lines ${block.startLine}-${block.endLine}`)
		const extractionDiagnostics =
			extractionFailures.length > 0
				? `\nJSON extraction diagnostics:\n${extractionFailures.map((failure) => `- ${failure}`).join("\n")}`
				: ""
		throw new Error(
			`${fileLabel}: Found command examples for 'ocx registry list --json' (${locations.join(", ")}) but none included a JSON object payload in the same fenced block.${extractionDiagnostics}`,
		)
	}

	if (blocksWithJson.length > 1) {
		const locations = blocksWithJson.map(({ block }) => `lines ${block.startLine}-${block.endLine}`)
		throw new Error(
			`${fileLabel}: Found multiple fenced blocks with both 'ocx registry list --json' and JSON payload (${locations.join(", ")}). Keep one canonical block for contract checks.`,
		)
	}

	const [selectedBlock] = blocksWithJson
	if (!selectedBlock) {
		throw new Error(
			`${fileLabel}: Internal test error while selecting registry list --json fenced code block.`,
		)
	}
	const { jsonCandidates } = selectedBlock

	const parsedCandidates: Array<{ value: Record<string, unknown> }> = []
	const parseFailures: string[] = []

	for (const candidate of jsonCandidates) {
		try {
			parsedCandidates.push({
				value: expectObject(JSON.parse(candidate), `${fileLabel} registry list --json example`),
			})
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			parseFailures.push(`${message}\n--- JSON candidate ---\n${candidate}\n----------------------`)
		}
	}

	if (parsedCandidates.length === 0) {
		throw new Error(
			`${fileLabel}: Failed to parse JSON object from registry list output block. ${parseFailures.join("\n")}`,
		)
	}

	const envelopeCandidates = parsedCandidates.filter(
		(candidate) => "success" in candidate.value && "data" in candidate.value,
	)

	if (envelopeCandidates.length === 1) {
		return envelopeCandidates[0].value
	}

	if (envelopeCandidates.length > 1) {
		throw new Error(
			`${fileLabel}: Found multiple JSON envelope candidates with top-level 'success' and 'data' in the same code block; expected exactly one canonical example.`,
		)
	}

	if (parsedCandidates.length > 1) {
		throw new Error(
			`${fileLabel}: Found multiple JSON objects in the registry list output block but none matched expected envelope keys ('success', 'data').`,
		)
	}

	return parsedCandidates[0].value
}

function compareShapeKeys(expectedKeys: string[], actualKeys: string[], label: string): void {
	const missingKeys = expectedKeys.filter((key) => !actualKeys.includes(key))
	const extraKeys = actualKeys.filter((key) => !expectedKeys.includes(key))
	if (missingKeys.length === 0 && extraKeys.length === 0) {
		return
	}

	throw new Error(
		`${label} drifted from runtime contract. Missing keys: [${missingKeys.join(", ") || "none"}], extra keys: [${extraKeys.join(", ") || "none"}]. Runtime keys: [${expectedKeys.join(", ")}], docs keys: [${actualKeys.join(", ")}].`,
	)
}

function assertCliSuccess(
	result: { exitCode: number; stdout: string; stderr: string },
	commandLabel: string,
): void {
	if (result.exitCode === 0) {
		return
	}

	throw new Error(
		`${commandLabel} failed with exitCode=${result.exitCode}.\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n--------------`,
	)
}

async function captureRuntimeRegistryListEnvelope(): Promise<Record<string, unknown>> {
	const tempDir = await createTempDir("docs-contract-registry-envelope")

	try {
		const initResult = await runCLIIsolated(["init"], tempDir, { OCX_SELF_UPDATE: "off" })
		assertCliSuccess(initResult, "ocx init")

		const registryListResult = await runCLIIsolated(["registry", "list", "--json"], tempDir, {
			OCX_SELF_UPDATE: "off",
		})
		const strictJsonPayload = expectStrictJsonSuccess(registryListResult)
		return expectObject(strictJsonPayload, "runtime registry list --json payload")
	} finally {
		await cleanupTempDir(tempDir)
	}
}

function extractComponentTypesTable(markdown: string, fileLabel: string): string[] {
	const lines = markdown.split(/\r?\n/)
	const headingIndex = lines.findIndex((line) => /^\s*##\s+Component Types\s*$/.test(line))

	if (headingIndex < 0) {
		throw new Error(`${fileLabel}: Could not find '## Component Types' heading.`)
	}

	const sectionEnd = (() => {
		for (let index = headingIndex + 1; index < lines.length; index += 1) {
			if (/^\s*##\s+/.test(lines[index] ?? "")) {
				return index
			}
		}

		return lines.length
	})()

	const parseTableCells = (line: string): string[] => {
		return line
			.replace(/^\|/, "")
			.replace(/\|$/, "")
			.split("|")
			.map((cell) => cell.trim())
	}

	const isDividerRow = (line: string): boolean => {
		const cells = parseTableCells(line)
		return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
	}

	let foundAnyTable = false

	for (let index = headingIndex + 1; index < sectionEnd; index += 1) {
		const line = lines[index]?.trim()
		if (!line?.startsWith("|")) {
			continue
		}

		const tableStart = index
		const tableLines: string[] = []
		let cursor = index

		for (; cursor < sectionEnd; cursor += 1) {
			const candidateLine = lines[cursor]?.trim()
			if (!candidateLine) {
				if (tableLines.length > 0) {
					break
				}
				continue
			}

			if (!candidateLine.startsWith("|")) {
				if (tableLines.length > 0) {
					break
				}
				continue
			}

			tableLines.push(candidateLine)
		}

		index = cursor - 1
		if (tableLines.length === 0) {
			continue
		}

		foundAnyTable = true

		if (tableLines.length < 2) {
			continue
		}

		const headerCells = parseTableCells(tableLines[0])
		const firstHeaderCell = headerCells[0]?.trim()
		if (firstHeaderCell !== "Type" || !isDividerRow(tableLines[1])) {
			continue
		}

		const dataRows = tableLines.filter((row, rowIndex) => rowIndex > 1 && !isDividerRow(row))
		const documentedTypes: string[] = []

		for (const row of dataRows) {
			const cells = parseTableCells(row)
			const rawTypeCell = cells[0]
			if (!rawTypeCell) {
				continue
			}

			const normalizedType = rawTypeCell.replace(/^`([^`]+)`$/, "$1").trim()
			if (!normalizedType) {
				continue
			}

			documentedTypes.push(normalizedType)
		}

		if (documentedTypes.length === 0) {
			throw new Error(
				`${fileLabel}: Found component types table near line ${tableStart + 1} but did not find any data rows with a first-column component type.`,
			)
		}

		return documentedTypes
	}

	if (!foundAnyTable) {
		throw new Error(
			`${fileLabel}: Found '## Component Types' heading at line ${headingIndex + 1} but could not find a markdown table in that section.`,
		)
	}

	throw new Error(
		`${fileLabel}: Found '## Component Types' heading at line ${headingIndex + 1} but could not find a qualifying component types table (expected first header cell 'Type' followed by a markdown divider row).`,
	)
}

function assertComponentTypeTableParity(markdown: string, fileLabel: string): void {
	const runtimeTypes = [...BUILTIN_COMPONENT_TYPES] as string[]
	assertCanonicalV2TypeList(runtimeTypes, "runtime BUILTIN_COMPONENT_TYPES")

	const documentedTypes = extractComponentTypesTable(markdown, fileLabel)
	assertCanonicalV2TypeList(documentedTypes, `${fileLabel} component types table`)

	const duplicateTypes = documentedTypes.filter(
		(type, index) => documentedTypes.indexOf(type) !== index,
	)
	if (duplicateTypes.length > 0) {
		throw new Error(
			`${fileLabel}: Component types table contains duplicate entries: ${[...new Set(duplicateTypes)].join(", ")}.`,
		)
	}

	const missingTypes = runtimeTypes.filter((type) => !documentedTypes.includes(type))
	const extraTypes = documentedTypes.filter((type) => !runtimeTypes.includes(type))

	if (missingTypes.length === 0 && extraTypes.length === 0) {
		return
	}

	throw new Error(
		`${fileLabel}: Component types table drifted from runtime schema. Missing runtime types in docs: [${missingTypes.join(", ") || "none"}]. Extra docs-only types: [${extraTypes.join(", ") || "none"}]. Runtime types: [${runtimeTypes.join(", ")}].`,
	)
}

function assertCanonicalV2TypeList(types: string[], label: string): void {
	const legacyPrefixed = types.filter((type) => type.startsWith("ocx:"))
	if (legacyPrefixed.length > 0) {
		throw new Error(
			`${label} must use canonical unprefixed V2 types only. Found legacy prefixed entries: [${legacyPrefixed.join(", ")}].`,
		)
	}

	const requiredCanonicalTypes = ["bundle", "profile"]
	const missingCanonicalTypes = requiredCanonicalTypes.filter((type) => !types.includes(type))
	if (missingCanonicalTypes.length > 0) {
		throw new Error(
			`${label} is missing required canonical V2 component types: [${missingCanonicalTypes.join(", ")}].`,
		)
	}
}

describe("registry docs/runtime contracts", () => {
	it("runtime component types are canonical unprefixed V2 values", () => {
		assertCanonicalV2TypeList(
			[...BUILTIN_COMPONENT_TYPES] as string[],
			"runtime BUILTIN_COMPONENT_TYPES",
		)
	})

	it("docs/cli/registry.mdx keeps registry list --json payload aligned with runtime", async () => {
		const markdown = await readFile(REGISTRY_CLI_DOC_PATH, "utf-8")
		const docsPayload = extractRegistryListJsonExample(markdown, REGISTRY_CLI_DOC_PATH)
		const runtimeEnvelopePayload = await captureRuntimeRegistryListEnvelope()

		const runtimeDataPayload = runRegistryListCore({
			getRegistries: () => ({
				kdco: { url: "https://ocx.kdco.dev" },
			}),
		})

		compareShapeKeys(
			Object.keys(runtimeEnvelopePayload).sort(),
			Object.keys(docsPayload).sort(),
			`${REGISTRY_CLI_DOC_PATH} payload`,
		)

		const runtimeEntry = runtimeDataPayload.registries[0]
		if (!runtimeEntry) {
			throw new Error(
				"Runtime regression: runRegistryListCore did not return a sample registry entry for shape comparison.",
			)
		}

		const runtimeKeys = Object.keys(runtimeEntry).sort()

		const docsSuccess = expectBoolean(docsPayload.success, "docs payload.success")
		const runtimeSuccess = expectBoolean(runtimeEnvelopePayload.success, "runtime payload.success")
		if (docsSuccess !== runtimeSuccess) {
			throw new Error(
				`${REGISTRY_CLI_DOC_PATH}: docs payload.success must be ${JSON.stringify(runtimeSuccess)} to match runtime success envelope semantics. Received: ${JSON.stringify(docsSuccess)}.`,
			)
		}
		const docsData = expectObject(docsPayload.data, "docs payload.data")
		compareShapeKeys(
			Object.keys(runtimeDataPayload).sort(),
			Object.keys(docsData).sort(),
			`${REGISTRY_CLI_DOC_PATH} payload.data`,
		)
		expectBoolean(docsData.locked, "docs payload.data.locked")

		const docsRegistries = docsData.registries
		if (!Array.isArray(docsRegistries) || docsRegistries.length === 0) {
			throw new Error(
				`${REGISTRY_CLI_DOC_PATH}: docs payload.data.registries must be a non-empty array for contract testing.`,
			)
		}

		for (const [index, rawRegistry] of docsRegistries.entries()) {
			const registry = expectObject(
				rawRegistry,
				`${REGISTRY_CLI_DOC_PATH} payload.data.registries[${index}]`,
			)

			expectString(registry.name, `${REGISTRY_CLI_DOC_PATH} payload.data.registries[${index}].name`)
			expectString(registry.url, `${REGISTRY_CLI_DOC_PATH} payload.data.registries[${index}].url`)

			compareShapeKeys(
				runtimeKeys,
				Object.keys(registry).sort(),
				`${REGISTRY_CLI_DOC_PATH} payload.data.registries[${index}]`,
			)
		}
	})

	it("examples/registry-starter/AGENTS.md component types table matches runtime schema", async () => {
		const markdown = await readFile(REGISTRY_STARTER_AGENTS_PATH, "utf-8")
		assertComponentTypeTableParity(markdown, REGISTRY_STARTER_AGENTS_PATH)
	})

	it("workers/ocx-kit/AGENTS.md component types table matches runtime schema", async () => {
		const markdown = await readFile(OCX_KIT_AGENTS_PATH, "utf-8")
		assertComponentTypeTableParity(markdown, OCX_KIT_AGENTS_PATH)
	})
})

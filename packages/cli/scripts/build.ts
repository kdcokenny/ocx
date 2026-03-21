/**
 * Build script for OCX CLI
 * Compiles TypeScript to JavaScript
 */

import { readFileSync } from "node:fs"

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"))

type BuildLog = Awaited<ReturnType<typeof Bun.build>>["logs"][number]

function formatBuildLog(log: BuildLog): string {
	const logLevel = log.level.toUpperCase()
	const logPosition = log.position
		? ` (${log.position.file}:${log.position.line}:${log.position.column})`
		: ""

	return `[${logLevel}] ${log.message}${logPosition}`
}

function printBuildLogs(logs: BuildLog[]): void {
	if (logs.length === 0) {
		console.error("No build diagnostics were reported.")
		return
	}

	for (const log of logs) {
		console.error(formatBuildLog(log))
	}
}

let buildResult: Awaited<ReturnType<typeof Bun.build>>

try {
	buildResult = await Bun.build({
		entrypoints: ["./src/index.ts"],
		outdir: "./dist",
		target: "bun",
		format: "esm",
		minify: true,
		sourcemap: "external",
		define: {
			__VERSION__: JSON.stringify(pkg.version),
		},
	})
} catch (error) {
	console.error("✗ Build failed before Bun.build() could complete.")
	console.error(error)
	process.exit(1)
}

if (!buildResult.success) {
	console.error("✗ Build failed: Bun.build() reported errors.")
	printBuildLogs(buildResult.logs)
	process.exit(1)
}

const warningLogs = buildResult.logs.filter((log) => log.level === "warning")
if (warningLogs.length > 0) {
	console.warn("Build completed with warnings:")
	for (const log of warningLogs) {
		console.warn(formatBuildLog(log))
	}
}

console.log(`✓ Build complete: ./dist/index.js (v${pkg.version})`)

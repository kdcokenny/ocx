/**
 * Format Validation Result
 *
 * Formats validation results into human-readable output
 */

import kleur from "kleur"
import type { ValidationResult } from "./validate-registry-types"

/**
 * Format a validation result into human-readable text
 * @param result - The validation result to format
 * @returns Formatted text output
 */
export function formatValidationResult(result: ValidationResult): string {
	const lines: string[] = []

	// Metadata section
	if (result.metadata) {
		lines.push("")
		lines.push("Registry Metadata")
		lines.push(`  ${kleur.green("✓")} Name: ${result.metadata.name}`)
		lines.push(`  ${kleur.green("✓")} Namespace: ${result.metadata.namespace}`)
		lines.push(`  ${kleur.green("✓")} Version: ${result.metadata.version}`)
		lines.push(`  ${kleur.green("✓")} Author: ${result.metadata.author}`)
	}

	// Stats section
	lines.push("")
	lines.push(`Components (${result.stats.componentsCount} total)`)
	lines.push(`Files (${result.stats.filesCount} total)`)

	// Errors section
	if (result.errors.length > 0) {
		lines.push("")
		lines.push(kleur.red("Errors"))
		for (const error of result.errors) {
			lines.push(`  ${kleur.red("✗")} ${error.type}: ${error.message}`)
			if (error.component) {
				lines.push(`    Component: ${error.component}`)
			}
		}
	}

	// Warnings section
	if (result.warnings.length > 0) {
		lines.push("")
		lines.push(kleur.yellow("Warnings"))
		for (const warning of result.warnings) {
			lines.push(`  ${kleur.yellow("⚠")} ${warning.type}: ${warning.message}`)
			if (warning.suggestion) {
				lines.push(`    ${kleur.dim(warning.suggestion)}`)
			}
		}
	}

	// Summary
	lines.push("")
	lines.push("Summary")
	if (result.valid && result.warnings.length === 0) {
		lines.push(`  ${kleur.green("✓")} Valid registry`)
	} else if (result.valid) {
		lines.push(`  ${kleur.green("✓")} Valid registry`)
		lines.push(`  ${kleur.yellow("⚠")} ${result.warnings.length} warning(s)`)
	} else {
		lines.push(`  ${kleur.red("✗")} Invalid registry`)
		lines.push(`  ${kleur.red("✗")} ${result.errors.length} error(s)`)
	}

	return lines.join("\n")
}

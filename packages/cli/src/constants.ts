/**
 * OCX URL Constants
 *
 * Centralized URL definitions to avoid hardcoding throughout the codebase.
 */

import pkg from "../package.json" with { type: "json" }

// Base domains
export const OCX_DOMAIN = "ocx.kdco.dev"
export const GITHUB_REPO = "kdcokenny/ocx"

// OCX URLs
export const OCX_SCHEMA_URL = `https://${OCX_DOMAIN}/schemas/v3/ocx.json`
export const REGISTRY_SCHEMA_UNVERSIONED_URL = `https://${OCX_DOMAIN}/schemas/registry.json`
export const REGISTRY_SCHEMA_LATEST_MAJOR = 3

export function getRegistrySchemaUrl(major: number): string {
	return `https://${OCX_DOMAIN}/schemas/v${major}/registry.json`
}

export const REGISTRY_SCHEMA_LATEST_URL = getRegistrySchemaUrl(REGISTRY_SCHEMA_LATEST_MAJOR)

// CLI Version (single source of truth from package.json)
export const CLI_VERSION: string = pkg.version

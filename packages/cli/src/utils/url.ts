/**
 * Normalize a registry URL by removing trailing slashes.
 * Ensures consistent URL comparison and prevents double-slash issues.
 */
export function normalizeRegistryUrl(url: string): string {
	return url.trim().replace(/\/+$/, "")
}

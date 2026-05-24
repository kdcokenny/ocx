import { describe, expect, it } from "bun:test"
import { getDownloadUrl } from "../../src/self-update/download"

describe("self-update download URLs", () => {
	it("rejects malformed versions before constructing release URLs", () => {
		const malicious = "2.0.0/../../../../../evil/repo/releases/download/v1.0.0"

		expect(() => getDownloadUrl(malicious)).toThrow("Invalid version format")
	})
})

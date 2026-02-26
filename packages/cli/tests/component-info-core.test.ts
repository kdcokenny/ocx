import { describe, expect, it } from "bun:test"
import { runComponentInfoCore } from "../src/commands/component/info"

describe("component info core", () => {
	it("should export runComponentInfoCore function", () => {
		// Verify the function exists and is exported
		expect(typeof runComponentInfoCore).toBe("function")

		// Verify it's an async function (returns a Promise)
		expect(runComponentInfoCore.constructor.name).toBe("AsyncFunction")
	})
})

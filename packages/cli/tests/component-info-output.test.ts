import { describe, expect, it, spyOn } from "bun:test"
import type { ComponentInfoResult } from "../src/commands/component/info"
import { formatComponentInfoOutput } from "../src/commands/component/info"

describe("component info output formatting", () => {
	describe("formatComponentInfoOutput", () => {
		it("should format JSON output when json flag is true", () => {
			const result: ComponentInfoResult = {
				component: {
					name: "test-skill",
					type: "ocx:skill",
					description: "Test skill for token estimation",
					files: ["skill-guide.md", "examples.md"],
					dependencies: [],
				},
				tokenEstimates: {
					claude: 2847,
					gpt4o: 2912,
					gemini: 2831,
					average: 2863,
				},
				totalFiles: 2,
				totalBytes: 12480,
			}

			// Spy on console.log to capture output
			const consoleSpy = spyOn(console, "log")

			formatComponentInfoOutput(result, { json: true, quiet: false, verbose: false })

			// Should have called console.log once with JSON
			expect(consoleSpy).toHaveBeenCalledTimes(1)

			// Parse the output as JSON
			const output = consoleSpy.mock.calls[0][0] as string
			const parsed = JSON.parse(output)

			// Verify JSON structure
			expect(parsed).toHaveProperty("success", true)
			expect(parsed).toHaveProperty("component")
			expect(parsed.component).toHaveProperty("name", "test-skill")
			expect(parsed.component).toHaveProperty("type", "ocx:skill")
			expect(parsed.component).toHaveProperty("description")
			expect(parsed).toHaveProperty("tokenEstimates")
			expect(parsed.tokenEstimates).toHaveProperty("claude", 2847)
			expect(parsed.tokenEstimates).toHaveProperty("gpt4o", 2912)
			expect(parsed.tokenEstimates).toHaveProperty("gemini", 2831)
			expect(parsed.tokenEstimates).toHaveProperty("average", 2863)
			expect(parsed).toHaveProperty("stats")
			expect(parsed.stats).toHaveProperty("totalFiles", 2)
			expect(parsed.stats).toHaveProperty("totalBytes", 12480)

			consoleSpy.mockRestore()
		})
	})
})

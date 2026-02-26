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
					average: 2880,
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
			expect(parsed.tokenEstimates).toHaveProperty("average", 2880)
			expect(parsed).toHaveProperty("stats")
			expect(parsed.stats).toHaveProperty("totalFiles", 2)
			expect(parsed.stats).toHaveProperty("totalBytes", 12480)

			consoleSpy.mockRestore()
		})

		it("should format human-readable output when json flag is false", () => {
			const result: ComponentInfoResult = {
				component: {
					name: "personal-coding-standards",
					type: "ocx:skill",
					description: "Design principles and testing style guidelines",
					files: ["skill-guide.md", "examples.md", "test-guide.md"],
					dependencies: [],
				},
				tokenEstimates: {
					claude: 2847,
					gpt4o: 2912,
					average: 2880,
				},
				totalFiles: 3,
				totalBytes: 12480,
			}

			// Spy on console.log to capture output
			const consoleSpy = spyOn(console, "log")

			formatComponentInfoOutput(result, { json: false, quiet: false, verbose: false })

			// Should have called console.log multiple times for formatted output
			expect(consoleSpy.mock.calls.length).toBeGreaterThan(0)

			// Combine all output
			const fullOutput = consoleSpy.mock.calls.map((call) => call[0]).join("\n")

			// Verify key content is present
			expect(fullOutput).toContain("personal-coding-standards")
			expect(fullOutput).toContain("ocx:skill")
			expect(fullOutput).toContain("Design principles and testing style guidelines")
			expect(fullOutput).toContain("Token Estimates")
			expect(fullOutput).toContain("Claude")
			expect(fullOutput).toContain("GPT-4o")
			expect(fullOutput).toContain("2,847")
			expect(fullOutput).toContain("2,912")

			consoleSpy.mockRestore()
		})

		it("should format JSON output with dependencies field when present", () => {
			const result: ComponentInfoResult = {
				component: {
					name: "researcher",
					type: "ocx:agent",
					description: "Research agent with web search",
					files: ["agent.md"],
					dependencies: ["web-search"],
				},
				tokenEstimates: {
					claude: 2847,
					gpt4o: 2912,
					average: 2880,
				},
				totalFiles: 3,
				totalBytes: 8192,
				dependencies: {
					components: [
						{
							name: "web-search",
							qualifiedName: "kdco/web-search",
							type: "ocx:tool",
							description: "Web search integration",
							tokenEstimates: {
								claude: 1200,
								gpt4o: 1250,
								average: 1225,
							},
							totalFiles: 2,
							totalBytes: 4288,
						},
					],
					cumulative: {
						tokenEstimates: {
							claude: 4047,
							gpt4o: 4162,
							average: 4104,
						},
						totalFiles: 5,
						totalBytes: 12480,
					},
				},
			}

			const consoleSpy = spyOn(console, "log")
			formatComponentInfoOutput(result, { json: true, quiet: false, verbose: false })

			expect(consoleSpy).toHaveBeenCalledTimes(1)
			const output = consoleSpy.mock.calls[0][0] as string
			const parsed = JSON.parse(output)

			// Verify dependencies are included
			expect(parsed).toHaveProperty("dependencies")
			expect(parsed.dependencies).toHaveProperty("components")
			expect(parsed.dependencies.components).toHaveLength(1)
			expect(parsed.dependencies.components[0]).toHaveProperty("name", "web-search")
			expect(parsed.dependencies.components[0]).toHaveProperty("qualifiedName", "kdco/web-search")
			expect(parsed.dependencies).toHaveProperty("cumulative")
			expect(parsed.dependencies.cumulative.tokenEstimates).toHaveProperty("average", 4104)

			consoleSpy.mockRestore()
		})

		it("should format human-readable output with dependencies section", () => {
			const result: ComponentInfoResult = {
				component: {
					name: "researcher",
					type: "ocx:agent",
					description: "Research agent with web search",
					files: ["agent.md"],
					dependencies: ["web-search"],
				},
				tokenEstimates: {
					claude: 2847,
					gpt4o: 2912,
					average: 2880,
				},
				totalFiles: 3,
				totalBytes: 8192,
				dependencies: {
					components: [
						{
							name: "web-search",
							qualifiedName: "kdco/web-search",
							type: "ocx:tool",
							description: "Web search integration",
							tokenEstimates: {
								claude: 1200,
								gpt4o: 1250,
								average: 1225,
							},
							totalFiles: 2,
							totalBytes: 4288,
						},
					],
					cumulative: {
						tokenEstimates: {
							claude: 4047,
							gpt4o: 4162,
							average: 4104,
						},
						totalFiles: 5,
						totalBytes: 12480,
					},
				},
			}

			const consoleSpy = spyOn(console, "log")
			formatComponentInfoOutput(result, { json: false, quiet: false, verbose: false })

			const fullOutput = consoleSpy.mock.calls.map((call) => call[0]).join("\n")

			// Verify dependency section is present
			expect(fullOutput).toContain("Dependencies:")
			expect(fullOutput).toContain("kdco/web-search")
			expect(fullOutput).toContain("ocx:tool")
			expect(fullOutput).toContain("Cumulative Estimates")

			consoleSpy.mockRestore()
		})
	})
})

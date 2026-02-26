import { describe, expect, it } from "bun:test"
import type { ComponentInfoOptions, ComponentInfoResult } from "../src/commands/component/info"

describe("component info types", () => {
	it("should have ComponentInfoOptions with withDependencies field", () => {
		// Test that ComponentInfoOptions can be created with withDependencies
		const options: ComponentInfoOptions = {
			cwd: "/test",
			json: false,
			quiet: false,
			verbose: false,
			profile: "test",
			withDependencies: true,
		}

		expect(options.withDependencies).toBe(true)
	})

	it("should have ComponentInfoResult with optional dependencies field", () => {
		// Test that ComponentInfoResult can be created with dependencies
		const result: ComponentInfoResult = {
			component: {
				name: "test",
				type: "ocx:agent",
				description: "Test component",
				files: [],
				dependencies: [],
			},
			tokenEstimates: {
				claude: 100,
				gpt4o: 100,
				average: 100,
			},
			totalFiles: 1,
			totalBytes: 100,
			dependencies: {
				components: [
					{
						name: "dep",
						qualifiedName: "test/dep",
						type: "ocx:skill",
						description: "Dependency",
						tokenEstimates: {
							claude: 50,
							gpt4o: 50,
							average: 50,
						},
						totalFiles: 1,
						totalBytes: 50,
					},
				],
				cumulative: {
					tokenEstimates: {
						claude: 150,
						gpt4o: 150,
						average: 150,
					},
					totalFiles: 2,
					totalBytes: 150,
				},
			},
		}

		expect(result.dependencies).toBeDefined()
		expect(result.dependencies?.components).toHaveLength(1)
		expect(result.dependencies?.components[0].name).toBe("dep")
		expect(result.dependencies?.cumulative.totalFiles).toBe(2)
	})

	it("should allow ComponentInfoResult without dependencies field", () => {
		// Test backward compatibility - dependencies field is optional
		const result: ComponentInfoResult = {
			component: {
				name: "test",
				type: "ocx:agent",
				description: "Test component",
				files: [],
				dependencies: [],
			},
			tokenEstimates: {
				claude: 100,
				gpt4o: 100,
				average: 100,
			},
			totalFiles: 1,
			totalBytes: 100,
		}

		expect(result.dependencies).toBeUndefined()
	})
})

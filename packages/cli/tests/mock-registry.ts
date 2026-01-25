import type { Server } from "bun"

export interface RouteOverride {
	status: number
	body?: string
	delay?: number
	malformed?: boolean
}

export interface MockRegistry {
	server: Server<unknown>
	url: string
	stop: () => void
	setFileContent: (componentName: string, fileName: string, content: string) => void
	setRouteError: (pathPattern: string, status: number, body?: string) => void
	setRouteTimeout: (pathPattern: string, delayMs: number) => void
	setRouteMalformed: (pathPattern: string) => void
	clearRouteOverrides: () => void
}

/**
 * Start a mock HTTP registry server for testing
 */
export function startMockRegistry(): MockRegistry {
	const customFiles = new Map<string, string>()
	const routeOverrides = new Map<string, RouteOverride>()

	const components = {
		"test-plugin": {
			name: "test-plugin",
			type: "ocx:plugin",
			description: "A test plugin",
			files: [{ path: "index.ts", target: ".opencode/plugin/test-plugin.ts" }],
			dependencies: [],
			npmDependencies: ["lodash@^4.17.21"],
		},
		"test-skill": {
			name: "test-skill",
			type: "ocx:skill",
			description: "A test skill",
			files: [{ path: "SKILL.md", target: ".opencode/skill/test-skill/SKILL.md" }],
			dependencies: ["test-plugin"],
		},
		"test-agent": {
			name: "test-agent",
			type: "ocx:agent",
			description: "A test agent",
			files: [{ path: "agent.md", target: ".opencode/agent/test-agent.md" }],
			dependencies: ["test-skill"],
			opencode: {
				mcp: {
					"test-mcp": {
						type: "remote",
						url: "https://mcp.test.com",
					},
				},
			},
		},
		// Profile component for testing profile installation
		"test-profile": {
			name: "test-profile",
			type: "ocx:profile",
			description: "A test profile for registry installation",
			files: [
				{ path: "ocx.jsonc", target: "ocx.jsonc" },
				{ path: "opencode.jsonc", target: "opencode.jsonc" },
				{ path: "AGENTS.md", target: "AGENTS.md" },
			],
			dependencies: [],
		},
		// Profile with dependencies for testing flat installation
		"test-profile-with-deps": {
			name: "test-profile-with-deps",
			type: "ocx:profile",
			description: "Test profile with dependencies for regression testing",
			files: [
				{ path: "ocx.jsonc", target: "ocx.jsonc" },
				{ path: "opencode.jsonc", target: "opencode.jsonc" },
				{ path: "AGENTS.md", target: "AGENTS.md" },
			],
			dependencies: ["test-plugin"],
		},
		// Components for testing MCP merge regression
		"test-mcp-provider": {
			name: "test-mcp-provider",
			type: "ocx:plugin",
			description: "A component that provides MCP servers",
			files: [{ path: "index.ts", target: ".opencode/plugin/test-mcp-provider.ts" }],
			dependencies: [],
			opencode: {
				mcp: {
					"provider-mcp": {
						type: "remote",
						url: "https://mcp.provider.com",
					},
				},
				plugin: ["provider-plugin"],
			},
		},
		// Component with string command shorthand MCP
		"test-local-mcp": {
			name: "test-local-mcp",
			type: "ocx:plugin",
			description: "A component with local MCP using string command",
			files: [{ path: "index.ts", target: ".opencode/plugin/test-local-mcp.ts" }],
			dependencies: [],
			opencode: {
				mcp: {
					"local-server": {
						type: "local",
						command: "npx some-mcp-server --port 3000",
					},
				},
			},
		},
		"test-no-mcp": {
			name: "test-no-mcp",
			type: "ocx:plugin",
			description: "A component without MCP that depends on test-mcp-provider",
			files: [{ path: "index.ts", target: ".opencode/plugin/test-no-mcp.ts" }],
			dependencies: ["test-mcp-provider"],
			opencode: {
				tools: {
					"some-tool": true,
				},
				plugin: ["no-mcp-plugin"],
			},
		},
	}

	const server = Bun.serve({
		port: 0, // Random port
		async fetch(req) {
			const url = new URL(req.url)
			const path = url.pathname

			// Check for route overrides first
			for (const [pattern, override] of routeOverrides) {
				if (path.includes(pattern) || path === pattern) {
					if (override.delay) {
						await Bun.sleep(override.delay)
					}
					if (override.malformed) {
						return new Response("not valid json {{{", {
							status: 200,
							headers: { "content-type": "application/json" },
						})
					}
					return new Response(override.body ?? "", {
						status: override.status,
						statusText: override.status >= 500 ? "Server Error" : "Error",
					})
				}
			}

			if (path === "/index.json") {
				return Response.json({
					name: "Test Registry",
					namespace: "kdco",
					version: "1.0.0",
					author: "Test Author",
					components: Object.values(components).map((c) => ({
						name: c.name,
						type: c.type,
						description: c.description,
					})),
				})
			}

			const componentMatch = path.match(/^\/components\/(.+)\.json$/)
			if (componentMatch) {
				const name = componentMatch[1]
				const component = components[name as keyof typeof components]
				if (component) {
					return Response.json({
						name: component.name,
						"dist-tags": {
							latest: "1.0.0",
						},
						versions: {
							"1.0.0": component,
						},
					})
				}
			}

			const fileMatch = path.match(/^\/components\/(.+)\/(.+)$/)
			if (fileMatch) {
				const [, name, filePath] = fileMatch
				const customKey = `${name}:${filePath}`
				if (customFiles.has(customKey)) {
					return new Response(customFiles.get(customKey))
				}
				// Return proper default content for profile files
				if (name === "test-profile") {
					if (filePath === "ocx.jsonc") {
						return new Response(JSON.stringify({ registries: {} }, null, 2))
					}
					if (filePath === "opencode.jsonc") {
						return new Response(JSON.stringify({}, null, 2))
					}
					if (filePath === "AGENTS.md") {
						return new Response("# Test Profile\n\nTest profile instructions.")
					}
				}
				if (name === "test-profile-with-deps") {
					if (filePath === "ocx.jsonc") {
						return new Response(JSON.stringify({ registries: {} }, null, 2))
					}
					if (filePath === "opencode.jsonc") {
						return new Response(JSON.stringify({}, null, 2))
					}
					if (filePath === "AGENTS.md") {
						return new Response("# Test Profile With Deps\n\nTest profile with dependencies.")
					}
				}
				return new Response(`Content of ${filePath} for ${name}`)
			}

			return new Response("Not Found", { status: 404 })
		},
	})

	return {
		server,
		url: `http://localhost:${server.port}`,
		stop: () => server.stop(),
		setFileContent: (componentName: string, fileName: string, content: string) => {
			customFiles.set(`${componentName}:${fileName}`, content)
		},
		setRouteError: (pathPattern: string, status: number, body?: string) => {
			routeOverrides.set(pathPattern, { status, body })
		},
		setRouteTimeout: (pathPattern: string, delayMs: number) => {
			routeOverrides.set(pathPattern, { status: 200, delay: delayMs })
		},
		setRouteMalformed: (pathPattern: string) => {
			routeOverrides.set(pathPattern, { status: 200, malformed: true })
		},
		clearRouteOverrides: () => {
			routeOverrides.clear()
		},
	}
}

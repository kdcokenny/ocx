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
	clearFileContent: () => void
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
			type: "plugin",
			description: "A test plugin",
			files: [{ path: "index.ts", target: "plugins/test-plugin.ts" }],
			dependencies: [],
		},
		"test-skill": {
			name: "test-skill",
			type: "skill",
			description: "A test skill",
			files: [{ path: "SKILL.md", target: "skills/test-skill/SKILL.md" }],
			dependencies: ["test-plugin"],
		},
		"test-agent": {
			name: "test-agent",
			type: "agent",
			description: "A test agent",
			files: [{ path: "agent.md", target: "agents/test-agent.md" }],
			dependencies: ["test-skill"],
		},
		"test-command": {
			name: "test-command",
			type: "command",
			description: "A test command",
			files: [{ path: "COMMAND.md", target: "commands/test-command.md" }],
			dependencies: [],
		},
		"test-command-singular": {
			name: "test-command-singular",
			type: "command",
			description: "A test command with singular target",
			files: [{ path: "COMMAND.md", target: "command/test-command-singular.md" }],
			dependencies: [],
		},
		"collision-command-a": {
			name: "collision-command-a",
			type: "command",
			description: "First command that collides after adaptive root resolution",
			files: [{ path: "A.md", target: "command/shared-collision.md" }],
			dependencies: [],
		},
		"collision-command-b": {
			name: "collision-command-b",
			type: "command",
			description: "Second command that collides after adaptive root resolution",
			files: [{ path: "B.md", target: "commands/shared-collision.md" }],
			dependencies: [],
		},
		"collision-parent": {
			name: "collision-parent",
			type: "bundle",
			description: "Parent component that pulls colliding dependencies",
			files: [],
			dependencies: ["collision-command-a", "collision-command-b"],
		},
		researcher: {
			name: "researcher",
			type: "agent",
			description: "Researcher fixture for strict JSON tests",
			files: [{ path: "agent.md", target: "agents/researcher.md" }],
			dependencies: [],
		},
		// Profile component for testing profile installation
		"test-profile": {
			name: "test-profile",
			type: "profile",
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
			type: "profile",
			description: "Test profile with dependencies for regression testing",
			files: [
				{ path: "ocx.jsonc", target: "ocx.jsonc" },
				{ path: "opencode.jsonc", target: "opencode.jsonc" },
				{ path: "AGENTS.md", target: "AGENTS.md" },
			],
			dependencies: ["test-plugin"],
		},
		"test-profile-with-command-deps": {
			name: "test-profile-with-command-deps",
			type: "profile",
			description: "Test profile with command dependency for adaptive root resolution",
			files: [
				{ path: "ocx.jsonc", target: "ocx.jsonc" },
				{ path: "opencode.jsonc", target: "opencode.jsonc" },
				{ path: "AGENTS.md", target: "AGENTS.md" },
				{ path: "keep", target: "command/.keep" },
			],
			dependencies: ["test-command-singular"],
		},
		"test-profile-with-file-collision": {
			name: "test-profile-with-file-collision",
			type: "profile",
			description: "Profile with colliding file targets after adaptive root resolution",
			files: [
				{ path: "ocx.jsonc", target: "ocx.jsonc" },
				{ path: "opencode.jsonc", target: "opencode.jsonc" },
				{ path: "AGENTS.md", target: "AGENTS.md" },
				{ path: "alpha.md", target: "command/shared-profile-collision.md" },
				{ path: "beta.md", target: "commands/shared-profile-collision.md" },
			],
			dependencies: [],
		},
		"test-profile-malicious-embedded": {
			name: "test-profile-malicious-embedded",
			type: "profile",
			description: "Profile with malicious embedded traversal target",
			files: [
				{ path: "ocx.jsonc", target: "ocx.jsonc" },
				{ path: "opencode.jsonc", target: "opencode.jsonc" },
				{ path: "AGENTS.md", target: "AGENTS.md" },
				{ path: "evil.txt", target: ".opencode/../victim.txt" },
			],
			dependencies: [],
		},
		// Components for testing MCP merge regression
		"test-mcp-provider": {
			name: "test-mcp-provider",
			type: "plugin",
			description: "A component that provides MCP servers",
			files: [{ path: "index.ts", target: "plugins/test-mcp-provider.ts" }],
			dependencies: [],
		},
		// Component with string command shorthand MCP
		"test-local-mcp": {
			name: "test-local-mcp",
			type: "plugin",
			description: "A component with local MCP using string command",
			files: [{ path: "index.ts", target: "plugins/test-local-mcp.ts" }],
			dependencies: [],
		},
		"test-no-mcp": {
			name: "test-no-mcp",
			type: "plugin",
			description: "A component without MCP that depends on test-mcp-provider",
			files: [{ path: "index.ts", target: "plugins/test-no-mcp.ts" }],
			dependencies: ["test-mcp-provider"],
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
					$schema: "https://ocx.kdco.dev/schemas/v3/registry.json",
					name: "Test Registry",
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
						// Use req.url to get the base URL dynamically
						const baseUrl = `http://${url.host}`
						return new Response(JSON.stringify({ registries: { kdco: { url: baseUrl } } }, null, 2))
					}
					if (filePath === "opencode.jsonc") {
						return new Response(JSON.stringify({}, null, 2))
					}
					if (filePath === "AGENTS.md") {
						return new Response("# Test Profile With Deps\n\nTest profile with dependencies.")
					}
				}
				if (name === "test-profile-with-command-deps") {
					if (filePath === "ocx.jsonc") {
						const baseUrl = `http://${url.host}`
						return new Response(JSON.stringify({ registries: { kdco: { url: baseUrl } } }, null, 2))
					}
					if (filePath === "opencode.jsonc") {
						return new Response(JSON.stringify({}, null, 2))
					}
					if (filePath === "AGENTS.md") {
						return new Response(
							"# Test Profile With Command Deps\n\nTest profile with command deps.",
						)
					}
					if (filePath === "keep") {
						return new Response("keep")
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
		clearFileContent: () => {
			customFiles.clear()
		},
	}
}

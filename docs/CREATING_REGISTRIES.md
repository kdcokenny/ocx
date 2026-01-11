# Creating OCX Registries

OCX registries are collections of components (agents, skills, plugins, commands) distributed as JSON packuments. This guide covers how to build and distribute your own registry.

> **See also:** [Registry Protocol Specification](./REGISTRY_PROTOCOL.md) for the HTTP API that registries must implement.

## Quick Start (Cloudflare Workers)

See `examples/registry-starter` for a minimal reference implementation. This guide covers how to build and distribute your own registry using Cloudflare Workers with static assets.

```bash
# Build the registry (generates dist/)
bun run build

# Deploy to Cloudflare Workers
bun run deploy
```

The build step runs `ocx build . --out dist` which:
1. Validates `registry.jsonc` against the schema
2. Generates `index.json` and component packuments
3. Copies component files to `dist/components/`
4. Generates `.well-known/ocx.json` for discovery

## Registry Philosophy

OCX follows the **Cargo + ShadCN model**:

1. **Namespace as Identity**: Every registry declares a `namespace` (e.g., `kdco`). Components are referenced as `namespace/component` (e.g., `kdco/researcher`).
2. **Clean Component Names**: Components within a registry use clean names (`researcher`, not `kdco-researcher`). The namespace provides provenance.
3. **Explicit Trust**: Cross-namespace dependencies require the user to have that registry configured. No auto-fetching from unknown sources.
4. **Own Your Code**: Components are copied into your project with clean filenames. The lockfile tracks provenance.

## Structure

A registry source directory should look like this:

```
my-registry/
├── registry.jsonc    # Registry manifest
└── files/            # Component source files
    ├── agent/
    ├── plugin/
    ├── skill/
    └── command/
```

### registry.jsonc

OCX uses **Cargo-style union types** for a clean developer experience: use strings for simple cases, objects when you need more control.

```json
{
  "name": "My Extensions",
  "namespace": "my",
  "version": "1.0.0",
  "author": "Your Name",
  "components": [
    {
      "name": "cool-plugin",
      "type": "ocx:plugin",
      "description": "Does something cool",
      "files": ["plugin/my-cool-plugin.ts"],
      "dependencies": []
    }
  ]
}
```

**Key fields:**
- `namespace`: Your registry's unique identifier (lowercase, alphanumeric, hyphens). Users reference components as `namespace/component`.
- `name`: Clean component name (no prefix required). The namespace provides provenance.
- `dependencies`: Use bare names for same-namespace deps (`["utils"]`), qualified names for cross-namespace (`["other/utils"]`).

## Cargo-Style Patterns

### Files

Use string shorthand when the target can be auto-inferred from the path:

```json
// String shorthand (recommended)
"files": ["plugin/my-plugin.ts"]
// Expands to: { "path": "plugin/my-plugin.ts", "target": ".opencode/plugin/my-plugin.ts" }

// Full object (when you need a custom target)
"files": [
  {
    "path": "skill/my-skill/SKILL.md",
    "target": ".opencode/skill/my-skill/SKILL.md"
  }
]
```

### MCP Servers

MCP servers are configured inside the `opencode` block using URL shorthand for remote servers:

```json
"opencode": {
  "mcp": {
    "context7": "https://mcp.context7.com/mcp"
  }
}
// Expands to: { "type": "remote", "url": "https://...", "enabled": true }

// Full object (for local servers or advanced config)
"opencode": {
  "mcp": {
    "local-mcp": {
      "type": "local",
      "command": ["node", "server.js", "--port", "3000"],
      "environment": { "DEBUG": "true" }
    }
  }
}
```

### OpenCode Config Block

Components can specify settings to merge into the user's `opencode.jsonc`:

```json
{
  "name": "my-agent",
  "type": "ocx:agent",
  "files": ["agent/my-agent.md"],
  "dependencies": [],
  "opencode": {
    "plugin": ["@some-org/opencode-plugin"],
    "tools": {
      "webfetch": false
    },
    "agent": {
      "my-agent": {
        "tools": {
          "read": true,
          "write": true,
          "bash": false
        },
        "temperature": 0.7
      }
    },
    "instructions": ["Always follow best practices"]
  }
}
```

| Field | Description |
|-------|-------------|
| `opencode.mcp` | MCP servers (URL shorthand or full config) |
| `opencode.plugin` | npm packages added to `opencode.jsonc` plugin array |
| `opencode.tools` | Global tool enable/disable settings |
| `opencode.agent` | Per-agent configuration (tools, temperature, permission, prompt) |
| `opencode.permission` | Permission settings for bash/edit/mcp |
| `opencode.instructions` | Global instructions appended to config |
| `npmDependencies` | Array of npm packages required by this component |
| `permission` | Permission level for the component (`dangerous`, `normal`) |

## Component Types

| Type | Target Directory | Description |
|------|-----------------|-------------|
| `ocx:agent` | `agent/` | Markdown files defining specialized agents. |
| `ocx:skill` | `skill/` | Instruction sets (must follow `.opencode/skill/<name>/SKILL.md`). |
| `ocx:plugin` | `plugin/` | TypeScript/JavaScript extensions for tools and hooks. |
| `ocx:command` | `command/` | Markdown templates for TUI commands. |
| `ocx:tool` | `tool/` | Custom tool implementations. |
| `ocx:bundle` | N/A | Virtual components that install multiple other components. |

## Building

Use the OCX CLI to validate and build your registry:

```bash
ocx build ./my-registry --out dist
```

This command will:
1. Validate your `registry.jsonc` against the Zod schema.
2. Verify that all listed dependencies exist (same-namespace) or are properly qualified (cross-namespace).
3. Generate an `index.json` and individual packument files (e.g., `cool-plugin.json`) in the output directory.

## Distribution

OCX registries are static JSON files served via Cloudflare Workers static assets, or any static file host (Vercel, Netlify, GitHub Pages, etc.).

### Hosted Registry Structure

After running `ocx build`, your `dist/` folder contains:

```
dist/
├── .well-known/
│   └── ocx.json           # Discovery endpoint
├── index.json             # Registry index
└── components/
    ├── cool-plugin.json   # Component packument
    └── cool-plugin/
        └── plugin.ts      # Raw file content
```

### Cloudflare Workers (Recommended)

This registry uses Cloudflare Workers with static assets. The `wrangler.jsonc` config points to `dist/` as the assets directory:

```jsonc
{
  "name": "kdco-registry",
  "assets": { "directory": "./dist" }
}
```

Deploy with `wrangler deploy` after building.

### Registry Discovery (Optional)

Add a `/.well-known/ocx.json` endpoint to enable automatic discovery:

```json
{
  "version": 1,
  "registry": "/index.json"
}
```

This allows users to register using just the domain:
```bash
ocx registry add https://example.com --name my
```

Without discovery, users must specify the full index URL.

### Adding and Using Registries

Users can add your registry using:
```bash
ocx registry add https://example.com/registry --name my
```

After adding the registry, users install components with:
```bash
ocx add my/cool-plugin
```

## Dependencies

### Same-Namespace Dependencies

Use bare component names for dependencies within the same registry:

```json
{
  "name": "researcher",
  "dependencies": ["background-agents", "utils"]
}
```

These resolve to `my/background-agents` and `my/utils` automatically.

### Cross-Namespace Dependencies

Use qualified names for dependencies from other registries:

```json
{
  "name": "researcher",
  "dependencies": ["background-agents", "acme/shared-utils"]
}
```

The user must have the `acme` registry configured in their `ocx.jsonc` for cross-namespace deps to resolve.

## Conflict Handling

If a user tries to install a component that would overwrite an existing file from a different component:

```bash
$ ocx add acme/researcher
Error: File conflict detected
  .opencode/agent/researcher.md already exists (installed from kdco/researcher)

To resolve:
  1. Remove existing file and update ocx.lock
  2. Or rename existing file manually
  3. Then retry: ocx add acme/researcher
```

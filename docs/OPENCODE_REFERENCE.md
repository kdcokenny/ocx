# OpenCode Developer Reference

A comprehensive reference for AI agents developing OCX components. This document covers plugin development, configuration, agent setup, skills, and extension patterns.

---

## Table of Contents

1. [Plugin Development](#1-plugin-development)
2. [Configuration (opencode.jsonc)](#2-configuration-opencodejsonc)
3. [Agent Configuration](#3-agent-configuration)
4. [Skills & Instructions](#4-skills--instructions)
5. [Custom Tools](#5-custom-tools)
6. [MCP Server Configuration](#6-mcp-server-configuration)
7. [Permissions](#7-permissions)
8. [CLI Reference](#8-cli-reference)
9. [SDK Reference](#9-sdk-reference)
10. [Rules & Instructions](#10-rules--instructions)

---

## 1. Plugin Development

Plugins extend OpenCode by hooking into events and customizing behavior.

### Plugin Locations

- **Project-level**: `.opencode/plugin/`
- **Global**: `~/.config/opencode/plugin/`
- **npm packages**: Configured in `opencode.json`

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-helicone-session", "@my-org/custom-plugin"]
}
```

### Adding npm Plugins with OCX

OCX supports adding npm plugins directly without a registry using the `npm:` protocol:

```bash
ocx add npm:<package-name>[@version]
```

This adds the package to the `plugin` array in `opencode.jsonc`. OpenCode will install and load the plugin at runtime.

#### Examples

```bash
# Latest version
ocx add npm:opencode-plugin-foo

# Specific version
ocx add npm:opencode-plugin-foo@1.0.0

# Scoped package
ocx add npm:@scope/plugin

# Mix with registry components
ocx add kdco/researcher npm:some-plugin
```

The plugin is added to your configuration:

```json
{
  "plugin": ["opencode-plugin-foo"]
}
```

Or with a version constraint:

```json
{
  "plugin": [{ "name": "opencode-plugin-foo", "version": "1.0.0" }]
}
```

### Basic Plugin Structure

```typescript
import type { Plugin } from "@opencode-ai/plugin"

export const MyPlugin: Plugin = async ({ project, client, $, directory, worktree }) => {
  console.log("Plugin initialized!")

  return {
    // Hook implementations
  }
}
```

#### Context Object Properties

| Property    | Description                                      |
|-------------|--------------------------------------------------|
| `project`   | Current project information                      |
| `directory` | Current working directory                        |
| `worktree`  | Git worktree path                                |
| `client`    | OpenCode SDK client for AI interaction           |
| `$`         | Bun's shell API for executing commands           |

### Plugin Dependencies

Add external npm packages via `package.json` in your config directory:

```json title=".opencode/package.json"
{
  "dependencies": {
    "shescape": "^2.1.0"
  }
}
```

### Available Events

#### Session Events
- `session.created` / `session.updated` / `session.deleted`
- `session.idle` - Session completed
- `session.compacted` - Context was compacted
- `session.error` / `session.status` / `session.diff`

#### Tool Events
- `tool.execute.before` - Before tool execution (can modify/abort)
- `tool.execute.after` - After tool execution

#### File Events
- `file.edited` - File was modified
- `file.watcher.updated` - File system change detected

#### Message Events
- `message.updated` / `message.removed`
- `message.part.updated` / `message.part.removed`

#### Permission Events
- `permission.updated` / `permission.replied`

#### TUI Events
- `tui.prompt.append` / `tui.command.execute` / `tui.toast.show`

#### Other Events
- `command.executed` / `installation.updated` / `server.connected`
- `lsp.updated` / `lsp.client.diagnostics`
- `todo.updated`

### Plugin Examples

#### .env Protection
```javascript
export const EnvProtection = async ({ project, client, $, directory, worktree }) => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool === "read" && output.args.filePath.includes(".env")) {
        throw new Error("Do not read .env files")
      }
    },
  }
}
```

#### Send Notifications
```javascript
export const NotificationPlugin = async ({ project, client, $, directory, worktree }) => {
  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        await $`osascript -e 'display notification "Session completed!" with title "opencode"'`
      }
    },
  }
}
```

#### Custom Tools via Plugin
```typescript
import { type Plugin, tool } from "@opencode-ai/plugin"

export const CustomToolsPlugin: Plugin = async (ctx) => {
  return {
    tool: {
      mytool: tool({
        description: "This is a custom tool",
        args: {
          foo: tool.schema.string(),
        },
        async execute(args, ctx) {
          return `Hello ${args.foo}!`
        },
      }),
    },
  }
}
```

#### Compaction Hooks
```typescript
export const CompactionPlugin: Plugin = async (ctx) => {
  return {
    "experimental.session.compacting": async (input, output) => {
      // Inject additional context
      output.context.push(`
## Custom Context
Include any state that should persist across compaction.
`)
      // Or replace entire prompt:
      // output.prompt = "Your custom compaction prompt..."
    },
  }
}
```

### Load Order

1. Global config (`~/.config/opencode/opencode.json`)
2. Project config (`opencode.json`)
3. Global plugin directory (`~/.config/opencode/plugin/`)
4. Project plugin directory (`.opencode/plugin/`)

---

## 2. Configuration (opencode.jsonc)

### File Format

OpenCode supports **JSON** and **JSONC** (JSON with Comments):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  // Theme configuration
  "theme": "opencode",
  "model": "anthropic/claude-sonnet-4-5",
  "auto_update": true
}
```

### Configuration Locations (Merged)

1. **Global**: `~/.config/opencode/opencode.json`
2. **Project**: `opencode.json` (project root)
3. **Custom path**: `OPENCODE_CONFIG` environment variable
4. **Custom directory**: `OPENCODE_CONFIG_DIR` environment variable

### Core Options

| Option | Type | Description |
|--------|------|-------------|
| `$schema` | string | Schema URL for validation |
| `theme` | string | UI theme name |
| `model` | string | Default model (`provider/model-id`) |
| `small_model` | string | Model for lightweight tasks |
| `auto_update` | boolean/`"notify"` | Auto-update behavior |
| `default_agent` | string | Default primary agent |
| `share` | `"manual"`/`"auto"`/`"disabled"` | Session sharing mode |

### Tools Configuration

```json
{
  "tools": {
    "write": false,
    "bash": false,
    "mymcp_*": false
  }
}
```

### Provider Configuration

```json
{
  "provider": {
    "anthropic": {
      "options": {
        "timeout": 600000,
        "setCacheKey": true
      }
    }
  },
  "disabled_providers": ["openai"],
  "enabled_providers": ["anthropic"]
}
```

### TUI Configuration

```json
{
  "tui": {
    "scroll_speed": 3,
    "scroll_acceleration": { "enabled": true },
    "diff_style": "auto"
  }
}
```

### Server Configuration

```json
{
  "server": {
    "port": 4096,
    "host": "0.0.0.0",
    "mdns": true,
    "cors": ["http://localhost:5173"]
  }
}
```

### Compaction Configuration

```json
{
  "compaction": {
    "auto": true,
    "prune": true
  }
}
```

### File Watcher Configuration

```json
{
  "watcher": {
    "include": ["src/**/*.ts", "*.json"],
    "exclude": ["node_modules/**", "dist/**", ".git/**"]
  }
}
```

### Variable Substitution

#### Environment Variables
```json
{
  "model": "{env:OPENCODE_MODEL}",
  "provider": {
    "anthropic": {
      "options": {
        "apiKey": "{env:ANTHROPIC_API_KEY}"
      }
    }
  }
}
```

#### File Contents
```json
{
  "provider": {
    "openai": {
      "options": {
        "apiKey": "{file:~/.secrets/openai-key}"
      }
    }
  }
}
```

---

## 3. Agent Configuration

Agents are specialized AI assistants for specific tasks.

### Agent Types

| Type | Description |
|------|-------------|
| `primary` | Main agents you interact with directly (Tab to switch) |
| `subagent` | Specialized assistants invoked by primary agents or via `@mention` |

### Built-in Agents

| Agent | Mode | Description |
|-------|------|-------------|
| `build` | primary | Default agent with all tools enabled |
| `plan` | primary | Analysis mode with `edit`/`bash` set to `ask` |
| `general` | subagent | General-purpose research and multi-step tasks |
| `explore` | subagent | Fast codebase exploration |

### JSON Configuration

```json
{
  "agent": {
    "code-reviewer": {
      "description": "Reviews code for best practices",
      "mode": "subagent",
      "model": "anthropic/claude-sonnet-4-20250514",
      "temperature": 0.1,
      "prompt": "You are a code reviewer. Focus on security and performance.",
      "steps": 10,
      "tools": {
        "write": false,
        "edit": false
      },
      "permission": {
        "bash": "ask"
      }
    }
  }
}
```

### Markdown Configuration

Place files in `~/.config/opencode/agent/` or `.opencode/agent/`:

```markdown title="~/.config/opencode/agent/review.md"
---
description: Reviews code for quality and best practices
mode: subagent
model: anthropic/claude-sonnet-4-20250514
temperature: 0.1
tools:
  write: false
  edit: false
  bash: false
permission:
  edit: deny
  bash:
    "git diff": allow
    "git log*": allow
    "*": ask
---

You are in code review mode. Focus on:

- Code quality and best practices
- Potential bugs and edge cases
- Performance implications
- Security considerations

Provide constructive feedback without making direct changes.
```

### Agent Options Reference

| Option | Type | Description |
|--------|------|-------------|
| `description` | string | **Required.** Brief description of agent purpose |
| `mode` | `primary`/`subagent`/`all` | Agent mode (default: `all`) |
| `model` | string | Model override (`provider/model-id`) |
| `temperature` | number | 0.0-1.0 (lower = more focused) |
| `steps` | number | Max agentic iterations before forced response |
| `prompt` | string | Custom system prompt (supports `{file:path}`) |
| `tools` | object | Tool enable/disable map |
| `permission` | object | Permission overrides |
| `disable` | boolean | Disable the agent |

### Temperature Guidelines

| Range | Use Case |
|-------|----------|
| 0.0-0.2 | Code analysis, planning (focused/deterministic) |
| 0.3-0.5 | General development (balanced) |
| 0.6-1.0 | Brainstorming, exploration (creative) |

### Additional Model Options

Pass provider-specific options directly:

```json
{
  "agent": {
    "deep-thinker": {
      "model": "openai/gpt-5",
      "reasoningEffort": "high",
      "textVerbosity": "low"
    }
  }
}
```

---

## 4. Skills & Instructions

Skills are reusable instructions loaded on-demand via the `skill` tool.

### Skill Locations

- **Project config**: `.opencode/skills/<name>/SKILL.md`
- **Global config**: `~/.config/opencode/skills/<name>/SKILL.md`
- **Claude-compatible**: `.claude/skills/<name>/SKILL.md`
- **Global Claude**: `~/.claude/skills/<name>/SKILL.md`

### SKILL.md Format

```markdown
---
name: git-release
description: Create consistent releases and changelogs
license: MIT
compatibility: opencode
metadata:
  audience: maintainers
  workflow: github
---

## What I do

- Draft release notes from merged PRs
- Propose a version bump
- Provide a copy-pasteable `gh release create` command

## When to use me

Use this when you are preparing a tagged release.
Ask clarifying questions if the target versioning scheme is unclear.
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | 1-64 chars, lowercase alphanumeric with hyphens |
| `description` | Yes | 1-1024 chars, specific enough for agent selection |
| `license` | No | License identifier |
| `compatibility` | No | Compatibility info |
| `metadata` | No | String-to-string map for custom data |

### Name Validation Rules

- 1-64 characters
- Lowercase alphanumeric with single hyphen separators
- Cannot start/end with `-`
- No consecutive `--`
- Must match directory name
- Regex: `^[a-z0-9]+(-[a-z0-9]+)*$`

### Skill Permissions

```json
{
  "permission": {
    "skill": {
      "pr-review": "allow",
      "internal-*": "deny",
      "experimental-*": "ask",
      "*": "allow"
    }
  }
}
```

### Per-Agent Skill Permissions

```json
{
  "agent": {
    "plan": {
      "permission": {
        "skill": {
          "internal-*": "allow"
        }
      }
    }
  }
}
```

### Disable Skills for Agent

```json
{
  "agent": {
    "plan": {
      "tools": {
        "skill": false
      }
    }
  }
}
```

---

## 5. Custom Tools

Custom tools are functions the LLM can call during conversations.

### Tool Locations

- **Project**: `.opencode/tool/`
- **Global**: `~/.config/opencode/tool/`

### Basic Tool Structure

```typescript
import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Query the project database",
  args: {
    query: tool.schema.string().describe("SQL query to execute"),
  },
  async execute(args) {
    return `Executed query: ${args.query}`
  },
})
```

The **filename** becomes the **tool name**.

### Multiple Tools Per File

```typescript
import { tool } from "@opencode-ai/plugin"

export const add = tool({
  description: "Add two numbers",
  args: {
    a: tool.schema.number().describe("First number"),
    b: tool.schema.number().describe("Second number"),
  },
  async execute(args) {
    return args.a + args.b
  },
})

export const multiply = tool({
  description: "Multiply two numbers",
  args: {
    a: tool.schema.number().describe("First number"),
    b: tool.schema.number().describe("Second number"),
  },
  async execute(args) {
    return args.a * args.b
  },
})
```

Creates tools: `math_add` and `math_multiply`.

### Tool Context

```typescript
export default tool({
  description: "Get project information",
  args: {},
  async execute(args, context) {
    const { agent, sessionID, messageID } = context
    return `Agent: ${agent}, Session: ${sessionID}`
  },
})
```

### Using External Languages

Python example:

```python title=".opencode/tool/add.py"
import sys
a = int(sys.argv[1])
b = int(sys.argv[2])
print(a + b)
```

```typescript title=".opencode/tool/python-add.ts"
import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Add two numbers using Python",
  args: {
    a: tool.schema.number().describe("First number"),
    b: tool.schema.number().describe("Second number"),
  },
  async execute(args) {
    const result = await Bun.$`python3 .opencode/tool/add.py ${args.a} ${args.b}`.text()
    return result.trim()
  },
})
```

---

## 6. MCP Server Configuration

MCP (Model Context Protocol) servers add external tools to OpenCode.

### Local MCP Server

```json
{
  "mcp": {
    "my-local-mcp": {
      "type": "local",
      "command": ["npx", "-y", "my-mcp-command"],
      "enabled": true,
      "environment": {
        "MY_ENV_VAR": "value"
      },
      "timeout": 5000
    }
  }
}
```

### Remote MCP Server

```json
{
  "mcp": {
    "my-remote-mcp": {
      "type": "remote",
      "url": "https://mcp.example.com/mcp",
      "enabled": true,
      "headers": {
        "Authorization": "Bearer {env:API_KEY}"
      }
    }
  }
}
```

### OAuth Configuration

```json
{
  "mcp": {
    "oauth-server": {
      "type": "remote",
      "url": "https://mcp.example.com/mcp",
      "oauth": {
        "clientId": "{env:MCP_CLIENT_ID}",
        "clientSecret": "{env:MCP_CLIENT_SECRET}",
        "scope": "tools:read tools:execute"
      }
    }
  }
}
```

### MCP Server Options

#### Local Server Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `type` | `"local"` | Yes | Server type |
| `command` | string[] | Yes | Command to run |
| `environment` | object | No | Environment variables |
| `enabled` | boolean | No | Enable on startup |
| `timeout` | number | No | Timeout in ms (default: 5000) |

#### Remote Server Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `type` | `"remote"` | Yes | Server type |
| `url` | string | Yes | Server URL |
| `headers` | object | No | HTTP headers |
| `oauth` | object/false | No | OAuth config or disable |
| `enabled` | boolean | No | Enable on startup |
| `timeout` | number | No | Timeout in ms (default: 5000) |

### Per-Agent MCP Tools

```json
{
  "mcp": {
    "my-mcp": {
      "type": "local",
      "command": ["bun", "x", "my-mcp-command"]
    }
  },
  "tools": {
    "my-mcp*": false
  },
  "agent": {
    "my-agent": {
      "tools": {
        "my-mcp*": true
      }
    }
  }
}
```

---

## 7. Permissions

Control which actions require approval.

### Permission Values

| Value | Behavior |
|-------|----------|
| `"allow"` | Run without approval |
| `"ask"` | Prompt for approval |
| `"deny"` | Disable the tool |

### Default Permissions

Most operations are allowed by default. Exceptions:
- `doom_loop`: `ask`
- `external_directory`: `ask`

### Global Permissions

```json
{
  "permission": {
    "edit": "allow",
    "bash": "ask",
    "skill": "ask",
    "webfetch": "deny",
    "doom_loop": "ask",
    "external_directory": "ask"
  }
}
```

### Bash Command Permissions

```json
{
  "permission": {
    "bash": {
      "git push": "ask",
      "git status": "allow",
      "terraform *": "deny",
      "*": "ask"
    }
  }
}
```

### Skill Permissions

```json
{
  "permission": {
    "skill": {
      "*": "deny",
      "git-*": "allow",
      "frontend/*": "ask"
    }
  }
}
```

### Per-Agent Permissions

```json
{
  "permission": {
    "bash": { "git push": "ask" }
  },
  "agent": {
    "build": {
      "permission": {
        "bash": { "git push": "allow" }
      }
    }
  }
}
```

### Markdown Agent Permissions

```markdown
---
description: Code review without edits
mode: subagent
permission:
  edit: deny
  bash:
    "git diff": allow
    "git log*": allow
    "*": ask
  webfetch: deny
---
```

---

## 8. CLI Reference

### Core Commands

| Command | Description |
|---------|-------------|
| `opencode` | Start TUI |
| `opencode run [message]` | Non-interactive mode |
| `opencode serve` | Start headless server |
| `opencode web` | Start server with web interface |

### Agent Commands

```bash
opencode agent create    # Create new agent
opencode agent list      # List agents
```

### Auth Commands

```bash
opencode auth login      # Configure API keys
opencode auth list       # List authenticated providers
opencode auth logout     # Remove credentials
```

### MCP Commands

```bash
opencode mcp add         # Add MCP server
opencode mcp list        # List MCP servers
opencode mcp auth [name] # Authenticate OAuth server
opencode mcp logout      # Remove OAuth credentials
```

### Session Commands

```bash
opencode session list    # List sessions
opencode export [id]     # Export session as JSON
opencode import <file>   # Import session
```

### Other Commands

```bash
opencode models          # List available models
opencode stats           # Show usage statistics
opencode upgrade         # Update OpenCode
```

### Global Flags

| Flag | Description |
|------|-------------|
| `--help`, `-h` | Display help |
| `--version`, `-v` | Print version |
| `--print-logs` | Print logs to stderr |
| `--log-level` | DEBUG, INFO, WARN, ERROR |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENCODE_CONFIG` | Custom config file path |
| `OPENCODE_CONFIG_DIR` | Custom config directory |
| `OPENCODE_PERMISSION` | Inline JSON permissions |
| `OPENCODE_DISABLE_AUTOUPDATE` | Disable updates |
| `OPENCODE_EXPERIMENTAL` | Enable experimental features |

---

## 9. SDK Reference

### Installation

```bash
npm install @opencode-ai/sdk
```

### Create Instance

```javascript
import { createOpencode } from "@opencode-ai/sdk"

const { client } = await createOpencode({
  host: "127.0.0.1",
  port: 4096,
  config: {
    model: "anthropic/claude-3-5-sonnet-20241022"
  }
})
```

### Client Only

```javascript
import { createOpencodeClient } from "@opencode-ai/sdk"

const client = createOpencodeClient({
  baseUrl: "http://localhost:4096"
})
```

### Key APIs

```javascript
// Health check
const health = await client.global.health()

// Sessions
const session = await client.session.create({ body: { title: "My session" } })
const sessions = await client.session.list()

// Send prompt
const result = await client.session.prompt({
  path: { id: session.id },
  body: {
    model: { providerID: "anthropic", modelID: "claude-3-5-sonnet-20241022" },
    parts: [{ type: "text", text: "Hello!" }]
  }
})

// Inject context without AI response
await client.session.prompt({
  path: { id: session.id },
  body: {
    noReply: true,
    parts: [{ type: "text", text: "Context info..." }]
  }
})

// Event stream
const events = await client.event.subscribe()
for await (const event of events.stream) {
  console.log("Event:", event.type)
}
```

---

## 10. Rules & Instructions

### AGENTS.md

Create `AGENTS.md` in project root for project-specific instructions:

```markdown title="AGENTS.md"
# Project Guidelines

## Project Structure
- `packages/` - Workspace packages
- `infra/` - Infrastructure definitions

## Code Standards
- Use TypeScript with strict mode
- Follow existing patterns
```

### Locations

| Location | Scope |
|----------|-------|
| `./AGENTS.md` | Project-specific |
| `~/.config/opencode/AGENTS.md` | Global (all sessions) |

### Custom Instructions

Reference additional instruction files:

```json
{
  "instructions": [
    "CONTRIBUTING.md",
    "docs/guidelines.md",
    ".cursor/rules/*.md"
  ]
}
```

### Initialize AGENTS.md

```bash
opencode
# Then run /init command in TUI
```

---

## Built-in Tools Reference

| Tool | Description |
|------|-------------|
| `bash` | Execute shell commands |
| `edit` | Modify files via string replacement |
| `write` | Create/overwrite files |
| `read` | Read file contents |
| `grep` | Search file contents (regex) |
| `glob` | Find files by pattern |
| `list` | List directory contents |
| `patch` | Apply patches |
| `skill` | Load skill definitions |
| `todowrite` | Manage todo lists |
| `todoread` | Read todo lists |
| `webfetch` | Fetch web content |
| `lsp` | (Experimental) LSP integration |

---

## Commands Configuration

### JSON Format

```json
{
  "command": {
    "test": {
      "run": "Run the full test suite with coverage.",
      "description": "Run tests with coverage",
      "agent": "build",
      "model": "anthropic/claude-3-5-sonnet-20241022"
    }
  }
}
```

### Markdown Format

```markdown title=".opencode/command/test.md"
---
description: Run tests with coverage
agent: build
model: anthropic/claude-3-5-sonnet-20241022
---

Run the full test suite with coverage report.
Focus on failing tests and suggest fixes.
```

### Command Placeholders

| Placeholder | Description |
|-------------|-------------|
| `$ARGUMENTS` | All arguments |
| `$1`, `$2`, ... | Positional arguments |
| `` !`command` `` | Shell output injection |
| `@filepath` | File content inclusion |

---

## Formatter Configuration

```json
{
  "formatter": {
    "prettier": {
      "disabled": true
    },
    "custom-prettier": {
      "command": ["npx", "prettier", "--write", "$FILE"],
      "environment": { "NODE_ENV": "development" },
      "extensions": [".js", ".ts", ".jsx", ".tsx"]
    }
  }
}
```

---

## Best Practices for OCX Components

1. **Plugin Development**
   - Use TypeScript for type safety with `@opencode-ai/plugin`
   - Handle errors gracefully in hooks
   - Use `tool.execute.before` for validation/modification
   - Use `session.idle` for completion notifications

2. **Agent Configuration**
   - Set appropriate `temperature` for the use case
   - Use `steps` to control costs
   - Disable unnecessary tools for focused agents
   - Use descriptive `description` for agent selection

3. **Skills**
   - Keep descriptions concise but specific
   - Follow naming conventions strictly
   - Include clear "when to use" sections
   - Validate frontmatter completeness

4. **Custom Tools**
   - Provide detailed argument descriptions
   - Return meaningful results
   - Handle errors appropriately
   - Use context when needed

5. **Permissions**
   - Start restrictive, allow as needed
   - Use wildcards for grouped permissions
   - Override per-agent when appropriate

# AGENTS.md

Guidelines for AI agents working on this OCX registry.

## Overview

This is an OCX component registry - a collection of reusable AI components that extend OpenCode.
OCX follows the "Copy. Paste. Own." philosophy: components are copied into projects, giving users
full ownership and control.

**Runtime:** Bun (v1.3.5+)
**Build Tool:** OCX CLI (`bunx ocx build`)
**Deploy:** Cloudflare Workers, Vercel, or Netlify (static assets)

## Quick Reference

```bash
# Build the registry
bun run build

# Local development
bun run dev

# Deploy to Cloudflare
bun run deploy
```

## The 5 Laws of Elegant Defense

All code in this registry should follow these principles:

### 1. Early Exit

Guard clauses at the top of functions. Fail fast, return early.

```typescript
function processComponent(component: unknown) {
  if (!component) return null
  if (!isValid(component)) throw new ValidationError("Invalid component")
  // Happy path continues...
}
```

### 2. Parse, Don't Validate

Use Zod schemas at boundaries. Transform unknown data into typed data once.

```typescript
import { z } from "zod"

const ComponentSchema = z.object({
  name: z.string(),
  type: z.enum([
    "skill",
    "plugin",
    "agent",
    "command",
    "tool",
    "bundle",
    "profile"
  ]),
})

// Parse once at the boundary
const component = ComponentSchema.parse(rawInput)
// Now `component` is fully typed
```

### 3. Atomic Predictability

Same input → same output. No hidden state, no surprises.

```typescript
// Good: Pure function
function formatName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-")
}

// Bad: Hidden state
let counter = 0
function formatName(name: string): string {
  return `${name}-${counter++}` // Different output each call!
}
```

### 4. Fail Fast, Fail Loud

Clear errors immediately. Don't swallow exceptions or return ambiguous results.

```typescript
// Good: Clear error
throw new NotFoundError(`Component "${name}" not found in registry`)

// Bad: Silent failure
return null // Caller has no idea why
```

### 5. Intentional Naming

Code reads like a sentence. Names reveal intent.

```typescript
// Good: Clear intent
const isComponentInstalled = components.has(name)
const shouldSkipValidation = options.force === true

// Bad: Cryptic
const flag = c.has(n)
const skip = o.f === true
```

---

## Registry Structure

```
my-registry/
├── registry.jsonc         # Registry manifest (required)
├── files/                  # Component source files
│   ├── skills/
│   │   └── my-skill/
│   │       └── SKILL.md
│   ├── plugins/
│   │   └── my-plugin.ts
│   └── agents/
│       └── my-agent.md
├── dist/                   # Built output (generated)
│   ├── index.json          # Registry index
│   ├── .well-known/
│   │   └── ocx.json        # Discovery endpoint
│   └── components/
│       ├── my-skill.json
│       └── my-skill/
│           └── skills/my-skill/SKILL.md
└── wrangler.jsonc          # Cloudflare config
```

### registry.jsonc

The registry manifest defines your components:

```json
{
  "$schema": "https://ocx.kdco.dev/schemas/v2/registry.json",
  "name": "My Registry",
  "version": "0.0.1",
  "author": "Your Name",
  "components": [
    {
      "name": "my-skill",
      "type": "skill",
      "description": "A helpful skill",
      "files": ["skills/my-skill/SKILL.md"]
    }
  ]
}
```

`name` is display metadata. Runtime component identity comes from the alias configured
with `ocx registry add <url> --name <alias>`, and users reference components as
`<alias>/<component>`.

---

## Installation Scopes

Components can be installed at different scopes depending on their purpose:

- **Profile scope** (`ocx add <component> --profile <name>`) - Installs to `~/.config/opencode/profiles/<name>/`. Used for global settings, instructions, and MCP servers that apply across projects.
- **Project scope** (`ocx add <component>`) - Installs to `.opencode/` in the current project. Used for project-specific components.
- **Profile components** (`type: "profile"`) - Special components that create/update entire profiles with their own `ocx.jsonc`, `opencode.jsonc`, and instruction files.

---

## Component Types

OCX supports the following component types:

| Type | Purpose | File Format |
|------|---------|-------------|
| `skill` | Instructions for AI behavior | Markdown (SKILL.md) |
| `plugin` | Code that extends OpenCode | TypeScript |
| `agent` | Agent role definitions | Markdown |
| `command` | Custom TUI commands | Markdown |
| `tool` | Custom tool implementations | TypeScript |
| `bundle` | Collection of components | JSON manifest |
| `profile` | Shareable profile configuration | JSON |

### Skills (skill)

Skills teach AI assistants how to perform specific tasks.

**File:** `files/skills/{name}/SKILL.md`

```markdown
# Skill Name

Brief description of what this skill enables.

## TL;DR

One-paragraph summary for quick reference.

## When to Use

- Condition 1
- Condition 2
- Condition 3

## Instructions

Detailed instructions the AI should follow...

### Step 1: Do This

Explanation...

### Step 2: Then That

Explanation...

## Examples

Show good and bad examples...

## What NOT to Do

- Anti-pattern 1
- Anti-pattern 2
```

### Plugins (plugin)

Plugins add functionality to OpenCode through hooks and tools.

**File:** `files/plugins/{name}.ts`

```typescript
import type { Plugin, PluginContext, ToolDefinition } from "opencode"

// Define custom tools
const myTool: ToolDefinition = {
  name: "my-tool",
  description: "Does something useful",
  parameters: {
    type: "object",
    properties: {
      input: { type: "string", description: "The input value" }
    },
    required: ["input"]
  },
  execute: async (params, ctx) => {
    return { result: `Processed: ${params.input}` }
  }
}

// Export the plugin
export default {
  name: "my-plugin",
  version: "1.0.0",

  // Lifecycle hooks
  onSessionStart: async (ctx: PluginContext) => {
    console.log("Session started")
  },

  onSessionEnd: async (ctx: PluginContext) => {
    console.log("Session ended")
  },

  // Register tools
  tools: [myTool],

  // Registry-level settings are declared in registry.jsonc under component `opencode`
} satisfies Plugin
```

#### Plugin Hooks

| Hook | When It Fires |
|------|---------------|
| `onSessionStart` | New session begins |
| `onSessionEnd` | Session terminates |
| `onMessage` | User sends a message |
| `onResponse` | AI generates a response |
| `onToolCall` | Before a tool executes |
| `onToolResult` | After a tool returns |
| `onError` | An error occurs |

#### Plugin Context

The `PluginContext` provides access to:

```typescript
interface PluginContext {
  session: {
    id: string
    startedAt: Date
    messages: Message[]
  }
  config: Record<string, unknown>
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
  }
  log: {
    info(message: string): void
    warn(message: string): void
    error(message: string): void
  }
}
```

### Agents (agent)

Agents define specialized AI roles with specific permissions and behaviors.

**File:** `files/agents/{name}.md`

```markdown
# Agent: Code Reviewer

You are a meticulous code reviewer focused on quality and best practices.

## Role

- Review code for bugs, security issues, and style problems
- Suggest improvements with clear explanations
- Be constructive and educational, not critical

## Permissions

- Read any file in the codebase
- Run static analysis tools
- Cannot modify files directly (suggest changes only)

## Forbidden Actions

- Never approve code with known security vulnerabilities
- Never skip tests or linting checks
- Never make changes without explaining why

## Response Format

Use this structure for reviews:

### Summary
Brief overview of the code quality

### Issues Found
- [SEVERITY] Description of issue
  - Location: file:line
  - Suggestion: How to fix

### Recommendations
Prioritized list of improvements
```

### Commands (command)

Commands add custom TUI commands to OpenCode's command palette.

**File:** `files/commands/{name}.md`

````markdown
# Command: Run Tests

Execute project test suite with coverage reporting.

## Description

Runs the full test suite using the project's configured test runner and generates
a coverage report.

## Usage

Type `/tests` in the command palette or use the keyboard shortcut `Cmd+T`.

## Implementation

This command runs:
```bash
npm test -- --coverage
```

The results are displayed in a dedicated output panel.
````

### Tools (tool)

Tools provide custom functionality that can be called by AI assistants during conversations.

**File:** `files/tools/{name}.ts`

```typescript
import type { Tool } from "opencode"

export default {
  name: "calculate-complexity",
  description: "Analyze code complexity metrics",
  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Path to the file to analyze"
      }
    },
    required: ["filePath"]
  },
  execute: async (params, ctx) => {
    const content = await ctx.fs.readFile(params.filePath)
    const complexity = analyzeComplexity(content)
    return {
      cyclomaticComplexity: complexity.cyclomatic,
      cognitiveComplexity: complexity.cognitive,
      recommendations: complexity.recommendations
    }
  }
} satisfies Tool
```

### Bundles (bundle)

Bundles aggregate multiple components for easy installation.

```json
{
  "name": "starter-kit",
  "type": "bundle",
  "description": "Everything you need to get started",
  "dependencies": [
    "my-skill",
    "code-reviewer",
    "kdco/background-agents"
  ]
}
```

### Profiles (profile)

Profiles are shareable configurations that include OCX settings, OpenCode config, and instruction files. They're installed to `~/.config/opencode/profiles/<name>/`.

**Structure:**
```
files/profiles/my-profile/
├── ocx.jsonc          # OCX settings (registries, exclude/include patterns)
├── opencode.jsonc     # OpenCode config (MCP servers, tools, etc.)
└── AGENTS.md          # Profile-level instructions
```

**Registry component:**
```json
{
  "name": "my-profile",
  "type": "profile",
  "description": "My custom development profile",
  "files": [
    {
      "path": "profiles/my-profile/ocx.jsonc",
      "target": "ocx.jsonc"
    },
    {
      "path": "profiles/my-profile/opencode.jsonc",
      "target": "opencode.jsonc"
    },
    {
      "path": "profiles/my-profile/AGENTS.md",
      "target": "AGENTS.md"
    }
  ]
}
```

**Usage:**
```bash
# Install profile from registry
ocx profile add my-profile --source my/my-profile --global

# Use the profile
ocx opencode -p my-profile
```

---

## OpenCode Configuration

Components can inject configuration into the user's `opencode.jsonc`:

### MCP Servers

```typescript
opencode: {
  mcp: {
    "remote-api": {
      type: "remote",
      url: "https://api.example.com/mcp",
      headers: {
        "Authorization": "Bearer ${MCP_API_KEY}"
      }
    },
    "local-tool": {
      type: "local",
      command: "npx",
      args: ["-y", "my-mcp-server"]
    }
  }
}
```

### Tool Configuration

```typescript
opencode: {
  tools: {
    "*": false,       // Block all tools by default
    "Read": true,     // Allow read access
    "Edit": true,     // Allow editing
    "Bash": true      // Allow shell commands
  }
}
```

### Permissions

```typescript
opencode: {
  permission: {
    bash: {
      "npm test": "allow",
      "bun run *": "allow",
      "rm -rf *": "deny",
      "sudo *": "deny",
      "*": "ask"
    },
    edit: {
      "src/**/*.ts": "allow",
      "*.lock": "deny",
      "node_modules/**": "deny",
      "*": "ask"
    }
  }
}
```

### Custom Instructions

Use the `instructions` array to load instruction files from custom paths instead of root AGENTS.md:

```typescript
opencode: {
  instructions: [
    "instructions/coding-standards.md",
    "instructions/api-guidelines.md"
  ]
}
```

**Path Resolution for Registry Components:**
- Registry `opencode.instructions` paths are **install-root-relative** (not cwd-relative)
- OCX resolves them to absolute paths at runtime based on installation scope
- **Absolute paths are NOT allowed** in registry components
- User-defined `opencode.jsonc` instructions remain OpenCode-native (cwd-relative)

**Example**: `instructions/style-guide.md` resolves to:
- **Project**: `.opencode/instructions/style-guide.md`
- **Profile**: `~/.config/opencode/profiles/myprofile/instructions/style-guide.md`
- **Global**: `~/.config/opencode/instructions/style-guide.md`

This prevents registry components from polluting the root instruction file.

---

## TUI Plugins

OpenCode TUI plugins (`*.tui.tsx`) are **not** part of `opencode.jsonc`. They live in a separate file,
`~/.config/opencode/tui.json`, whose `plugin` array holds absolute paths or npm names. Declare a
top-level `tui` block (a sibling of `opencode`, **not** a component `type`) and OCX merges it there:

```json
{
  "name": "my-plugin",
  "type": "plugin",
  "files": ["plugins/my-plugin/status.tui.tsx"],
  "tui": {
    "plugin": ["./plugins/my-plugin/status.tui.tsx"]
  }
}
```

- `./…` entries are resolved to the **absolute install path** of the shipped file (`tui.json`
  requires absolute paths); npm names and absolute paths pass through unchanged.
- `ocx add` adds + dedupes into `tui.json`, preserving unrelated third-party entries.
- `ocx update` reconciles against the component's new `tui` block (adds new entries, drops ones the
  component no longer declares).
- `ocx remove` leaves `tui.json` untouched.

A component may declare `opencode`, `tui`, or both — they target different files.

---

## File Patterns

Components can specify files in two formats:

### String Shorthand

Simple relative path:

```json
{
  "files": ["skills/my-skill/SKILL.md"]
}
```

### Object Notation

For advanced control:

```json
{
  "files": [
    {
      "path": "skills/my-skill/SKILL.md",
      "target": "skills/my-skill.md"
    }
  ]
}
```

---

## Dependencies

Components can depend on other components:

### Same Registry

Use bare name:

```json
{
  "dependencies": ["my-other-skill"]
}
```

### External Registry

Use qualified name (alias/component):

```json
{
  "dependencies": ["kdco/background-agents", "kdco/notify"]
}
```

---

## Build & Deploy

### Build Command

```bash
# Build registry to dist/
bunx ocx build . --out dist

# Or use the npm script
bun run build
```

### Output Structure

```
dist/
├── index.json              # Registry manifest
├── .well-known/
│   └── ocx.json            # Discovery endpoint
└── components/
    ├── my-skill.json
    ├── my-skill/
    │   └── skills/my-skill/SKILL.md
    ├── my-plugin.json
    └── my-plugin/
        └── plugins/my-plugin.ts
```

### Deploy to Cloudflare

```bash
bun run deploy
# Or manually: wrangler deploy
```

### Deploy to Vercel

Push to GitHub and connect to Vercel. The `vercel.json` handles configuration.

### Deploy to Netlify

Push to GitHub and connect to Netlify. The `netlify.toml` handles configuration.

---

## Documentation Sources

For comprehensive documentation, refer to:

- **OpenCode Reference:** https://ocx.kdco.dev/reference/opencode
- **OCX CLI Documentation:** https://ocx.kdco.dev/cli/commands
- **Registry Protocol:** https://ocx.kdco.dev/registries/protocol

---

## Best Practices

### Instruction Files (AGENTS.md, CLAUDE.md, CONTEXT.md)

OpenCode supports multiple instruction file types, but follow these guidelines:

1. **Use AGENTS.md as primary** - Modern standard, clearly scoped for AI agents
2. **CLAUDE.md as fallback** - For legacy compatibility only
3. **Avoid CONTEXT.md** - Deprecated, ambiguous naming

**"First type wins" behavior:**
- When OpenCode discovers instruction files, it uses the **first type** it finds at each directory level
- If `AGENTS.md` exists, `CLAUDE.md` and `CONTEXT.md` in the **same directory** are ignored
- Priority: `AGENTS.md` > `CLAUDE.md` > `CONTEXT.md`

**Registry component guidelines:**
- **DO NOT** install instruction files to root `AGENTS.md` from registry components
- **DO** use custom paths with the `opencode.instructions` option:
  ```typescript
  opencode: {
    instructions: [
      "instructions/my-component-guide.md",
      "instructions/my-plugin-guidelines.md"
    ]
  }
  ```
- Paths are **install-root-relative** and OCX resolves them at runtime
- **Absolute paths are NOT allowed** in registry components
- This prevents registry components from polluting root instruction files and gives users explicit control

### Skills

1. **Be specific** - Target one task well rather than many tasks poorly
2. **Include examples** - Show what good output looks like
3. **Add anti-patterns** - Show what NOT to do
4. **Keep it scannable** - Use headers, bullets, and short paragraphs

### Plugins

1. **Minimal dependencies** - Keep plugins lightweight
2. **Handle errors** - Never let exceptions bubble up silently
3. **Type everything** - Use TypeScript strictly
4. **Document hooks** - Explain when and why each hook fires

### Agents

1. **Clear scope** - Define exactly what the agent should and shouldn't do
2. **Set boundaries** - Explicit forbidden actions prevent mistakes
3. **Provide format** - Tell the agent how to structure responses

### General

1. **Semantic versioning** - Use semver for registry versions
2. **Descriptive names** - Component names should explain their purpose
3. **Complete metadata** - Fill in description, author, and all fields

---

## Adding a New Component

### 1. Create the File

```bash
# For a skill
mkdir -p files/skills/my-new-skill
touch files/skills/my-new-skill/SKILL.md

# For a plugin
touch files/plugins/my-plugin.ts

# For an agent
touch files/agents/my-agent.md
```

### 2. Update registry.jsonc

```json
{
  "components": [
    // ... existing components
    {
      "name": "my-new-skill",
      "type": "skill",
      "description": "Description of what it does",
      "files": ["skills/my-new-skill/SKILL.md"]
    }
  ]
}
```

### 3. Build and Test

```bash
bun run build
# Verify dist/ contains your component
```

### 4. Deploy

```bash
bun run deploy
```

---

## Troubleshooting

### Build Fails

1. Check `registry.jsonc` syntax (must be valid JSONC)
2. Verify all files in `files` arrays exist
3. Run `bunx ocx build . --out dist --verbose` for details

### Component Not Found After Deploy

1. Verify the build completed successfully
2. Check the component appears in `dist/index.json`
3. Clear CDN cache if using one

### Plugin Not Loading

1. Ensure the plugin exports a default object
2. Check TypeScript syntax is valid
3. Verify `satisfies Plugin` type assertion

---

## Example: Complete Skill

Here's a full example of a well-structured skill:

```markdown
# Code Review

A systematic approach to reviewing code changes.

## TL;DR

Review code in layers: correctness, security, performance, style. Provide actionable
feedback with specific line references and suggested fixes.

## When to Use

- Pull request reviews
- Pre-commit code checks
- Learning/teaching code quality

## Instructions

### Layer 1: Correctness

1. Does the code do what it's supposed to?
2. Are edge cases handled?
3. Are there any logic errors?

### Layer 2: Security

1. Is user input validated?
2. Are secrets protected?
3. Are there injection vulnerabilities?

### Layer 3: Performance

1. Any unnecessary loops or allocations?
2. Could this be optimized?
3. Are there N+1 query problems?

### Layer 4: Style

1. Does it follow project conventions?
2. Is naming clear and consistent?
3. Is complexity manageable?

## Examples

**Good feedback:**
> Line 42: This loop iterates over all users but only needs the first match.
> Consider using `Array.find()` for O(1) early exit:
> ```javascript
> const user = users.find(u => u.id === targetId)
> ```

**Bad feedback:**
> This code is inefficient.

## What NOT to Do

- Don't nitpick style when there are correctness issues
- Don't request changes without explaining why
- Don't approve code you don't understand
```

---

*Generated by OCX Registry Starter. Visit https://github.com/kdcokenny/ocx for more information.*

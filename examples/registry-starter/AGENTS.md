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
  type: z.enum(["ocx:skill", "ocx:plugin", "ocx:agent", "ocx:bundle"]),
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
│   ├── skill/
│   │   └── my-skill/
│   │       └── SKILL.md
│   ├── plugin/
│   │   └── my-plugin.ts
│   └── agent/
│       └── my-agent.md
├── dist/                   # Built output (generated)
│   ├── index.json          # Registry index
│   ├── .well-known/
│   │   └── ocx.json        # Discovery endpoint
│   └── ...                 # Component files
└── wrangler.jsonc          # Cloudflare config
```

### registry.jsonc

The registry manifest defines your components:

```json
{
  "$schema": "https://ocx.kdco.dev/schema.json",
  "name": "My Registry",
  "namespace": "my-namespace",
  "version": "0.0.1",
  "author": "Your Name",
  "components": [
    {
      "name": "my-skill",
      "type": "ocx:skill",
      "description": "A helpful skill",
      "files": ["skill/my-skill/SKILL.md"]
    }
  ]
}
```

---

## Component Types

OCX supports four component types:

| Type | Purpose | File Format |
|------|---------|-------------|
| `ocx:skill` | Instructions for AI behavior | Markdown (SKILL.md) |
| `ocx:plugin` | Code that extends OpenCode | TypeScript |
| `ocx:agent` | Agent role definitions | Markdown |
| `ocx:bundle` | Collection of components | JSON manifest |

### Skills (ocx:skill)

Skills teach AI assistants how to perform specific tasks.

**File:** `files/skill/{name}/SKILL.md`

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

### Plugins (ocx:plugin)

Plugins add functionality to OpenCode through hooks and tools.

**File:** `files/plugin/{name}.ts`

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

  // Inject configuration
  config: {
    mcp: {
      "my-server": {
        type: "remote",
        url: "https://api.example.com/mcp"
      }
    }
  }
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

### Agents (ocx:agent)

Agents define specialized AI roles with specific permissions and behaviors.

**File:** `files/agent/{name}.md`

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

### Bundles (ocx:bundle)

Bundles aggregate multiple components for easy installation.

```json
{
  "name": "starter-kit",
  "type": "ocx:bundle",
  "description": "Everything you need to get started",
  "dependencies": [
    "my-skill",
    "code-reviewer",
    "kdco/background-agents"
  ]
}
```

---

## OpenCode Configuration

Components can inject configuration into the user's `opencode.jsonc`:

### MCP Servers

```typescript
config: {
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
config: {
  tools: {
    enabled: ["Read", "Edit", "Bash"],   // Allow these tools
    disabled: ["Write"],                  // Block these tools
    "*": { confirmation: true }           // Require confirmation for all
  }
}
```

### Permissions

```typescript
config: {
  permissions: {
    bash: {
      allow: ["npm test", "bun run *"],
      deny: ["rm -rf *", "sudo *"]
    },
    edit: {
      allow: ["src/**/*.ts"],
      deny: ["*.lock", "node_modules/**"]
    }
  }
}
```

---

## File Patterns

Components can specify files in two formats:

### String Shorthand

Simple relative path:

```json
{
  "files": ["skill/my-skill/SKILL.md"]
}
```

### Object Notation

For advanced control:

```json
{
  "files": [
    {
      "source": "skill/my-skill/SKILL.md",
      "target": ".opencode/skills/my-skill.md",
      "transform": "minify"
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

Use qualified name (namespace/component):

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
├── skill/
│   └── my-skill/
│       └── SKILL.md
└── plugin/
    └── my-plugin.ts
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

- **OpenCode Reference:** https://raw.githubusercontent.com/kdcokenny/ocx/main/docs/OPENCODE_REFERENCE.md
- **OCX CLI Documentation:** https://github.com/kdcokenny/ocx
- **Registry Protocol:** https://raw.githubusercontent.com/kdcokenny/ocx/main/docs/REGISTRY_PROTOCOL.md

---

## Best Practices

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
mkdir -p files/skill/my-new-skill
touch files/skill/my-new-skill/SKILL.md

# For a plugin
touch files/plugin/my-plugin.ts

# For an agent
touch files/agent/my-agent.md
```

### 2. Update registry.jsonc

```json
{
  "components": [
    // ... existing components
    {
      "name": "my-new-skill",
      "type": "ocx:skill",
      "description": "Description of what it does",
      "files": ["skill/my-new-skill/SKILL.md"]
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

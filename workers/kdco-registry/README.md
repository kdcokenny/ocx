# KDCO Registry

> Curated OpenCode extensions for enhanced AI-assisted development.

## Quick Start

```bash
ocx init
ocx registry add https://registry.kdco.dev --name kdco
ocx add kdco/workspace
```

> **Tip:** Use `--global` to add the registry to your global config (used when no profile is active).

Browse available components with `ocx search kdco/`.

## Bundles

| Name | Description | Command |
|------|-------------|---------|
| workspace | Full KDCO experience | `ocx add kdco/workspace` |
| philosophy | Code quality philosophies | `ocx add kdco/philosophy` |

## Components

Install individually if you don't want the full bundle.

### Agents

| Name | Description | Command |
|------|-------------|---------|
| researcher | External research via MCP | `ocx add kdco/researcher` |
| scribe | Documentation specialist | `ocx add kdco/scribe` |
| coder | Code implementation | `ocx add kdco/coder` |

### Plugins

| Name | Description | Command |
|------|-------------|---------|
| background-agents | Async task execution | `ocx add kdco/background-agents` |
| notify | OS notifications | `ocx add kdco/notify` |
| workspace-plugin | Plan management | `ocx add kdco/workspace-plugin` |
| worktree | Auto-manages Git worktrees for isolated AI sessions with seamless terminal spawning | `ocx add kdco/worktree` |

### Skills

| Name | Description | Command |
|------|-------------|---------|
| plan-protocol | Implementation plan guidelines | `ocx add kdco/plan-protocol` |
| code-philosophy | The 5 Laws of Elegant Defense | `ocx add kdco/code-philosophy` |
| frontend-philosophy | The 5 Pillars of Intentional UI | `ocx add kdco/frontend-philosophy` |

## Web Search Setup

The researcher agent uses **Exa** by default (free, no auth required).

### Adding Custom Search Engines

You can integrate any MCP-compatible search server. The pattern involves:

1. **Configure the MCP server** with command and environment
2. **Store secrets securely** using file-based or environment variables
3. **Enable tools** for the researcher agent using a glob pattern

#### Security Best Practices

**Preferred: File-based secrets** — keeps API keys out of config files:

```bash
mkdir -p ~/.secrets && chmod 700 ~/.secrets
echo "your-api-key" > ~/.secrets/service-api-key
chmod 600 ~/.secrets/service-api-key
```

Reference in config with `{file:~/.secrets/service-api-key}`.

**Alternative: Environment variables** — useful for CI/CD:

```jsonc
"environment": { "API_KEY": "{env:SERVICE_API_KEY}" }
```

#### Example: Kagi

[Kagi](https://kagi.com) provides privacy-focused search (requires a paid subscription).

1. **Get your session token** from Kagi's settings

2. **Create a secret file** (requires Node.js 22+ for `npx`):
   ```bash
   mkdir -p ~/.secrets && chmod 700 ~/.secrets
   echo "YOUR_KAGI_SESSION_TOKEN" > ~/.secrets/kagi-session-token
   chmod 600 ~/.secrets/kagi-session-token
   ```

3. **Add the MCP server** to your `opencode.jsonc`:
   ```jsonc
   {
     "mcp": {
       "kagi": {
         "type": "local",
         "command": ["npx", "-y", "github:czottmann/kagi-ken-mcp"],
         "environment": {
           "KAGI_SESSION_TOKEN": "{file:~/.secrets/kagi-session-token}"
         }
       }
     },
     "agent": {
       "researcher": {
         "tools": { "kagi_*": true }
       }
     }
    }
    ```

#### Enabling Tools

Use glob patterns to grant the researcher agent access to MCP tools:

```jsonc
{
  "agent": {
    "researcher": {
      "tools": { "prefix_*": true }
    }
  }
}
```

Replace `prefix_*` with the tool prefix for your search engine (e.g., `kagi_*`, `tavily_*`).

## Creating Your Own Registry

See [Creating OCX Registries](../../docs/CREATING_REGISTRIES.md) for how to build and distribute your own component registry.

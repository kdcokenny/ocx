# OCX

The missing package manager for OpenCode extensions.

## Why OCX?

- 📦 **Extensions made easy** — Dependencies, MCP servers, config merging handled automatically
- 👻 **Ghost Mode** — Work in any repo with YOUR config. Zero modifications. Isolated profiles.
- 🔒 **Auditable** — SHA-256 verified, version-pinned, code you can review

![OCX Demo](./assets/demo.gif)

## Installation

OCX supports macOS (x64, Apple Silicon), Linux (x64, arm64), and Windows (x64).

```bash
# Recommended (macOS/Linux)
curl -fsSL https://ocx.kdco.dev/install.sh | sh

# Or via npm (any platform)
npm install -g ocx
```

The install script handles PATH configuration automatically or prints instructions if manual setup is needed.

## Quick Start

### Option A: Add an npm Plugin (Fastest)

```bash
ocx init
ocx add npm:@franlol/opencode-md-table-formatter
```

That's it. Plugin added to your `opencode.jsonc`.

### Option B: Use a Curated Registry

Registries bundle related components with automatic dependency resolution:

```bash
ocx registry add https://registry.kdco.dev --name kdco
ocx add kdco/workspace
```

After installation, components live in `.opencode/` where you can customize freely.

### Create Your Own Registry

Scaffold a complete registry with one-click deploy support:

```bash
npx ocx init --registry my-registry
```

| Option | Description |
|--------|-------------|
| `--namespace <name>` | Registry namespace (default: directory name) |
| `--author <name>` | Author name (default: git user.name) |
| `--local <path>` | Use custom local template |
| `--canary` | Use latest from main branch |
| `--force` | Skip confirmation prompts |

See [examples/registry-starter](./examples/registry-starter) for the full template with deploy buttons for Cloudflare, Vercel, and Netlify.

## What OCX Handles

- **npm Dependencies** — Plugins need packages? Installed automatically. No manual `package.json` editing.
- **MCP Servers** — Registered to your config with one command. No manual JSON.
- **Config Merging** — Components bring settings that merge safely with yours.
- **Lockfiles** — Track versions, verify integrity with SHA-256 hashes.
- **Dependency Resolution** — Component A needs B? Both installed in correct order.
- **Own Your Code** — Everything lives in `.opencode/`. Customize freely.
- **Version Compatibility** — Registries declare minimum versions. Clear warnings, not blocking errors.
- **Ghost Mode** — Work in any repo without modifying it. Your config, their code.

## Auditable by Default

Every component is version-pinned and verified by SHA-256 hash. Before updating, see exactly what changed:

```bash
ocx diff kdco/workspace-plugin
```

- **Detect** — See every upstream change before updating
- **Verify** — SHA-256 hashes catch tampering
- **Pin** — Lockfiles prevent silent updates
- **Audit** — Code lives in your repo, not fetched at runtime

*Your AI agent never runs code you haven't reviewed.*

## Philosophy

OCX follows the **ShadCN model**: components are copied into your project, not hidden in `node_modules`. You own the code—customize freely.

Like **Cargo**, OCX resolves dependencies, pins versions, and verifies integrity. Unlike traditional package managers, everything is auditable and local.

## Commands

| Command | Description |
|---------|-------------|
| `ocx add <components...>` | Add components (`namespace/component`) or npm plugins (`npm:<package>`) |
| `ocx update [component]` | Update to latest version |
| `ocx diff [component]` | Show upstream changes |
| `ocx registry add <url>` | Add a registry |

[Full CLI Reference →](./docs/CLI.md)

### Ghost Mode — Your setup, any repo

Ghost mode lets you work in repositories without modifying them, using your own portable configuration and profile isolation. Perfect for drive-by contributions to open source projects—or keeping work and personal configs completely separate.

#### Quick Start

```bash
# One-time setup
ocx ghost init              # Creates your first profile
ocx ghost config            # Edit your active profile

# Add registries
ocx ghost registry add https://registry.kdco.dev --name kdco
ocx ghost registry list

# Use in any repo (without touching it)
cd ~/oss/some-project
ocx ghost add npm:@franlol/opencode-md-table-formatter  # Add npm plugins
ocx ghost add kdco/workspace   # Or use registries
ocx ghost opencode             # Runs OpenCode with YOUR config
```

#### Profile Management

Profiles keep your configurations isolated and portable:

```
~/.config/opencode/profiles/
├── current -> default       # Active profile
├── default/
│   ├── ghost.jsonc
│   └── opencode.jsonc
└── work/
    └── ...
```

**Essential profile commands:**

- `ghost profile list` - List all profiles
- `ghost profile add <name>` - Create a new profile  
- `ghost profile use <name>` - Switch to a profile
- `ghost profile remove <name>` - Delete a profile

Or use the `OCX_PROFILE` environment variable to temporarily switch profiles.

#### Commands

| Command | Alias | Description |
|---------|-------|-------------|
| `ocx ghost init` | `ocx g init` | Initialize ghost mode |
| `ocx ghost config` | `ocx g config` | Edit ghost config in $EDITOR |
| `ocx ghost registry add <url> [--name <name>]` | `ocx g registry add` | Add a registry |
| `ocx ghost registry remove <name>` | `ocx g registry remove` | Remove a registry |
| `ocx ghost registry list` | `ocx g registry list` | List registries |
| `ocx ghost add <component>` | `ocx g add` | Add component or npm plugin |
| `ocx ghost search <query>` | `ocx g search` | Search ghost registries |
| `ocx ghost opencode [path] [args...]` | `ocx g opencode` | Run OpenCode with ghost config (optional project path) |

> **How it works:** Ghost mode uses symlink isolation to run OpenCode without seeing the project's config. New files created during a ghost session are automatically synced back to your real project in real-time. Ghost mode also sets informative terminal names (`ghost[profile]:repo/branch`) for easy session identification (configurable via `renameWindow` or `--no-rename`). Git, LSPs, and file editing all work normally—changes go directly to the real project files.

#### Config Location

Ghost config is stored at `~/.config/opencode/profiles/<profile-name>/ghost.jsonc` (or `$XDG_CONFIG_HOME/opencode/profiles/<profile-name>/ghost.jsonc`).
OpenCode configuration for ghost mode is stored alongside it in `opencode.jsonc`.

```jsonc
// ~/.config/opencode/profiles/default/ghost.jsonc
{
  // Component registries (Record<name, url>)
  "registries": {
    "default": "https://registry.opencode.ai",
    "kdco": "https://registry.kdco.dev"
  },
  
  // Where to install components (relative to profile dir)
  "componentPath": ".opencode"
}
```

#### Key Differences from Normal Mode

| Aspect | Normal Mode | Ghost Mode |
|--------|-------------|------------|
| Config location | `./ocx.jsonc` in project | `~/.config/opencode/profiles/<name>/ghost.jsonc` |
| Modifies repo | Yes | No |
| Per-project settings | Yes | Profile-isolated |
| Requires `ocx init` | Yes | No (uses ghost config) |

#### Customizing File Visibility

By default, ghost mode hides all OpenCode project files (AGENTS.md, .opencode/, etc.) from the symlink farm. You can customize which files are included using glob patterns in your ghost config:

```jsonc
// ~/.config/opencode/profiles/default/ghost.jsonc
{
  "registries": {
    "kdco": "https://registry.kdco.dev"
  },
  
  // Safety limit for symlink farm creation (0 = unlimited)
  "maxFiles": 10000,
  
  // Include specific OpenCode files in ghost sessions
  "include": [
    "**/AGENTS.md",           // Include all AGENTS.md files
    ".opencode/skills/**"     // Include skills directory
  ],
  
  // Exclude patterns filter the include results  
  "exclude": [
    "**/vendor/**"            // But not files in vendor directories
  ]
}
```

This follows the TypeScript-style include/exclude model—no confusing negation patterns.

**📖 Full command reference available in [docs/CLI.md](./docs/CLI.md).**

**Looking for the KDCO registry?** See [workers/kdco-registry](./workers/kdco-registry) for components like `kdco/workspace`, `kdco/researcher`, and more.

## Project structure

OCX manages components within the `.opencode/` directory of your project:

```
.opencode/
├── agent/            # Subagents (researcher, scribe)
├── plugin/           # Project plugins (workspace tools, rule injection)
├── skill/            # Reusable instructions (protocols, philosophies)
├── command/          # Custom TUI commands
└── tool/             # Custom tool implementations
```

## Configuration

### `ocx.jsonc`
The user-editable configuration file.

```jsonc
{
  "$schema": "https://ocx.kdco.dev/schema.json",
  "registries": {
    "kdco": {
      "url": "https://registry.kdco.dev"
    }
  },
  "lockRegistries": false
}
```

### `ocx.lock`
Auto-generated lockfile tracking installed versions, hashes, and targets.

## OpenCode Feature Matrix

OCX supports the full range of OpenCode configuration options:

| Feature | Status | Notes |
|---------|--------|-------|
| **Components** |||
| Agents (`.opencode/agent/*.md`) | ✅ | Full support |
| Skills (`.opencode/skill/<name>/SKILL.md`) | ✅ | Full support |
| Plugins (file-based `.opencode/plugin/*.ts`) | ✅ | Full support |
| Plugins (npm packages) | ✅ | Via `ocx add npm:<package>` |
| Commands (`.opencode/command/*.md`) | ✅ | Full support |
| Bundles (meta-components) | ✅ | Full support |
| **opencode.jsonc Config** |||
| `plugin` (npm package array) | ✅ | Via `ocx add npm:<package>` |
| `mcp` (MCP servers) | ✅ | URL shorthand + full objects |
| `tools` (enable/disable patterns) | ✅ | Full support |
| `agent` (per-agent config) | ✅ | tools, temperature, permission, prompt |
| `instructions` (global instructions) | ✅ | Appended from components |
| **MCP Server Config** |||
| Remote servers (`type: remote`) | ✅ | URL shorthand supported |
| Local servers (`type: local`) | ✅ | Full support |
| Headers, environment, oauth | ✅ | Full support |
| **Schema Design** |||
| Cargo-style union types | ✅ | String shorthand + full objects |
| File string shorthand | ✅ | Auto-generates target path |
| MCP URL shorthand | ✅ | `"https://..."` → remote server |

## What's Shipped

- ✅ SHA-256 integrity verification
- ✅ Lockfile support
- ✅ Multi-registry composition
- ✅ Dependency resolution
- ✅ Config merging
- ✅ Version compatibility warnings

Have ideas? [Open an issue](https://github.com/kdcokenny/ocx/issues).

## Disclaimer

This project is not built by the OpenCode team and is not affiliated with [OpenCode](https://github.com/sst/opencode) in any way.

## License

MIT

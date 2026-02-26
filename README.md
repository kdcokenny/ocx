# OCX

[![CI](https://github.com/kdcokenny/ocx/actions/workflows/ci.yml/badge.svg)](https://github.com/kdcokenny/ocx/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ocx.svg)](https://www.npmjs.com/package/ocx)
[![License](https://img.shields.io/github/license/kdcokenny/ocx.svg)](https://github.com/kdcokenny/ocx/blob/main/LICENSE)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/kdcokenny/ocx)

Your OpenCode config, anywhere.

## Why OCX?

- 👻 **Profiles** — Work in any repo with YOUR config. Control exactly what OpenCode sees.
- 📦 **Registries** — npm plugins, MCP servers, components from curated registries.
- 🔒 **Auditable** — SHA-256 verified, version-pinned, code you own.

![OCX Profiles Demo](./assets/profiles-demo.gif)

*Demo uses [oh-my-opencode](./docs/guides/oh-my-opencode.md). See [more guides](./docs/guides/).*

## Installation

OCX supports macOS (x64, Apple Silicon), Linux (x64, arm64), and Windows (x64).

```bash
# Recommended (macOS/Linux)
curl -fsSL https://ocx.kdco.dev/install.sh | sh

# Or via npm (any platform)
npm install -g ocx
```

The install script handles PATH configuration automatically or prints instructions if manual setup is needed.

## Quick Start: Profiles

Work in any repo without modifying it. Your config, their code.

```bash
# One-time setup
ocx init --global           # Initialize global profiles
ocx profile add work        # Create a work profile

# Install pre-configured profile (optional)
ocx registry add https://ocx-kit.kdco.dev --name kit --global
ocx profile add work --from kit/omo

# Use in any repo
cd ~/oss/some-project
ocx oc -p work              # Launch OpenCode with your work profile

# Or set default
export OCX_PROFILE=work
ocx oc                      # Uses work profile automatically
```

Profile settings control what OpenCode sees through `exclude`/`include` patterns. Registries are isolated per profile for security. OpenCode config merges safely between profile and local settings.

> **Security Note:** By default, profiles include project `AGENTS.md` files. For untrusted repos, uncomment `**/AGENTS.md` in your profile's exclude list. See [Lock Down Recipe](./docs/PROFILES.md#lock-down-recipe).

**[Full Profile Guide →](./docs/PROFILES.md)**

## Quick Start: Components

Add components to local projects with automatic dependency resolution.

![OCX Components Demo](./assets/components-demo.gif)

```bash
# Initialize local config
ocx init

# Add a registry
ocx registry add https://registry.kdco.dev --name kdco

# Install components
ocx add kdco/workspace

# Or install npm plugins directly
ocx add npm:@franlol/opencode-md-table-formatter
```

After installation, components live in `.opencode/` where you can customize freely. OCX handles npm dependencies, MCP servers, and config merging automatically.

## Philosophy

OCX follows the **ShadCN model**: components are copied into your project (`.opencode/`), not hidden in `node_modules`. You own the code—customize freely.

Like **Cargo**, OCX resolves dependencies, pins versions, and verifies integrity. Every component is SHA-256 verified and version-pinned. See changes before updating:

```bash
ocx diff kdco/workspace
```

*Your AI agent never runs code you haven't reviewed.*

## Commands

| Command | Description |
|---------|-------------|
| `ocx add <component>` | Add components or npm plugins (`npm:package`) |
| `ocx update [component]` | Update to latest version |
| `ocx diff [component]` | Show upstream changes before updating |
| `ocx component info <component>` | Display token cost estimates for a component |
| `ocx profile <cmd>` | Manage global profiles (`add`, `list`, `remove`, `show`) |
| `ocx opencode` / `ocx oc` | Launch OpenCode with profile |
| `ocx registry add <url>` | Add a component registry (`--global` for global, `-p` for profile) |
| `ocx config show` | View config from current scope |
| `ocx config edit` | Edit local or global config (`--global`) |
| `ocx self update` | Update OCX to latest version |
| `ocx self uninstall` | Remove OCX config and binary |

**[Full CLI Reference →](./docs/CLI.md)**

## Creating Registries

Scaffold a complete registry with one-click deploy support:

```bash
npx ocx init --registry my-registry
```

This creates a complete registry template with deploy buttons for Cloudflare, Vercel, and Netlify.

## Disclaimer

This project is not built by the OpenCode team and is not affiliated with [OpenCode](https://github.com/sst/opencode) in any way.

## License

MIT

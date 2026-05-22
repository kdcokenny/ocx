# OCX

[![CI](https://github.com/kdcokenny/ocx/actions/workflows/ci.yml/badge.svg)](https://github.com/kdcokenny/ocx/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ocx.svg)](https://www.npmjs.com/package/ocx)
[![License](https://img.shields.io/github/license/kdcokenny/ocx.svg)](https://github.com/kdcokenny/ocx/blob/main/LICENSE)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/kdcokenny/ocx)

Your OpenCode config, anywhere.

## Why OCX?

- 📁 **Profiles** — Work in any repo with YOUR config. Control exactly what OpenCode sees.
- 📦 **Registries** — Install profiles and components from curated registries.
- 🔒 **Auditable** — SHA-verified, code you own.

![OCX Profiles Demo](./assets/profiles-demo.gif)

*Demo uses [oh-my-openagent](https://ocx.kdco.dev/docs/guides/oh-my-opencode). See [more guides](https://ocx.kdco.dev/docs/guides/index).*

## Installation

OCX supports macOS (x64, Apple Silicon), Linux (x64, arm64), and Windows (x64).

```bash
# Recommended (macOS/Linux)
curl -fsSL https://ocx.kdco.dev/install.sh | sh

# Or via npm (any platform)
npm install -g ocx
```

The install script handles PATH configuration automatically or prints instructions if manual setup is needed.

The npm package runs with Bun at runtime. Make sure `bun` is available on your `PATH` before using `npm install -g ocx`; Node.js alone is not sufficient. If you do not have Bun, use the standalone binaries from the install script or GitHub Releases when available.

## Quick Start

Work in any repo without modifying it. Your config, their code.

```bash
# One-time setup
ocx init --global

# Install the KDCO workspace profile (OpenCode Free Models Only)
ocx profile add ws --source tweak/p-1vp4xoqv --from https://tweakoc.com/r --global

# Launch OpenCode with the profile
ocx oc -p ws
```

Need a custom profile? Open the KDCO Workspace harness in TweakOC: https://tweakoc.com/h/kdco-workspace

Profiles control what OpenCode sees through `exclude`/`include` patterns. Each profile has isolated registries for security. OpenCode config merges safely between profile and local settings.

> **Security Note:** An empty exclude list includes all project instruction files; the default profile template ships a secure exclude list. For trusted repos, edit your profile to loosen the template's exclude list. See [Lock Down Recipe](https://ocx.kdco.dev/docs/profiles/security#lock-down-recipe).

**[Profile Deep Dive →](https://ocx.kdco.dev/docs/profiles/overview)**

## Common Commands

| Command | Description |
|---------|-------------|
| `ocx profile add <name> --source <registry/profile> --from <url> --global` | Install a profile from a registry |
| `ocx profile add <name> --clone <existing> --global` | Clone an existing profile |
| `ocx oc -p <name>` | Launch OpenCode with a profile |
| `ocx profile list --global` | List your profiles |
| `ocx config edit --global` | Edit your global config |

**[Full CLI Reference →](https://ocx.kdco.dev/docs/cli/commands)**

## Advanced Usage

### Components

Add individual components to projects (copied to `.opencode/`, not `node_modules`):

```bash
# One-time local setup
ocx init

# Add a registry with a name
ocx registry add https://registry.kdco.dev --name kdco

# Install components using name/component syntax
ocx add kdco/workspace
```

See [Components & Registries](https://ocx.kdco.dev/docs/registries/create) for more.

### Creating Registries

Scaffold and deploy your own registry:

```bash
npx ocx init --registry my-registry
```

See [Creating Registries](https://ocx.kdco.dev/docs/registries/create) for details.

## Philosophy

OCX follows the **ShadCN model**: components are copied into your project (`.opencode/`), not hidden in `node_modules`. You own the code—customize freely.

Like **Cargo**, OCX resolves dependencies and verifies integrity. Every component is SHA-256 verified.

*Your AI agent never runs code you haven't reviewed.*

## Documentation

- **[Profiles](https://ocx.kdco.dev/docs/profiles/overview)** — Deep dive into profile configuration and isolation
- **[CLI Reference](https://ocx.kdco.dev/docs/cli/commands)** — Complete command documentation
- **[Creating Registries](https://ocx.kdco.dev/docs/registries/create)** — Build and distribute your own components
- **[Guides](https://ocx.kdco.dev/docs/guides/index)** — Step-by-step tutorials

## Disclaimer

This project is not built by the OpenCode team and is not affiliated with [OpenCode](https://github.com/sst/opencode) in any way.

## License

MIT

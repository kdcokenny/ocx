# OCX CLI Reference

Command-line interface for managing OpenCode extensions and component registries.

## Installation

```bash
# Using bun (recommended)
bunx @ocx/cli <command>

# Or install globally
bun add -g @ocx/cli
ocx <command>
```

## Short-Flag Policy

OCX follows a minimal short-flag policy inspired by Cargo and [CLI Guidelines](https://clig.dev):

- **Short flags** (`-x`) are reserved for high-frequency, cross-command options
- **Specialized options** use long flags only (`--option-name`)

### Standard Short Flags

| Flag | Long Form | Description |
|------|-----------|-------------|
| `-q` | `--quiet` | Suppress non-essential output |
| `-v` | `--verbose` | Enable verbose output |
| `-f` | `--force` | Skip confirmation prompts |
| `-p` | `--profile <name>` | Target a specific profile |
| `-g` | `--global` | Operate on global config |

All other options use long-form only. This keeps the CLI predictable and reduces the cognitive load of memorizing command-specific short flags.

## Commands

- [`ocx init`](#ocx-init) - Initialize OCX configuration
- [`ocx add`](#ocx-add) - Add components from a registry
- [`ocx update`](#ocx-update) - Update installed components
- [`ocx search`](#ocx-search) - Search for components
- [`ocx registry`](#ocx-registry) - Manage registries (local-first)
- [`ocx build`](#ocx-build) - Build a registry from source
- [`ocx self update`](#ocx-self-update) - Update OCX to latest version
- [`ocx self uninstall`](#ocx-self-uninstall) - Remove OCX configuration and binary
- [`ocx profile`](#ocx-profile) - Manage global profiles
- [`ocx config`](#ocx-config) - View and edit configuration (local-first)
- [`ocx opencode`](#ocx-opencode) - Launch OpenCode with resolved configuration

---

## ocx init

Initialize OCX configuration locally or globally with profile support.

### Usage

```bash
ocx init [options]
ocx init --registry <path> [options]
```

### Options

| Option | Description |
|--------|-------------|
| `--cwd <path>` | Working directory (default: current directory) |
| `-q, --quiet` | Suppress output |
| `-v, --verbose` | Verbose output |
| `--json` | Output as JSON |
| `--installed` | List installed components only |
| `--limit <n>` | Limit results (default: 20) |

### Examples

```bash
# List all available components
ocx search

# Search for components
ocx search agents

# Search with a higher result limit
ocx search agents --limit 50

# List installed components only
ocx search --installed

# Get machine-readable output
ocx search --json

# Verbose output showing registry details
ocx search agents --verbose
```

### Output

```bash
$ ocx search agent
Found 3 components:
  kdco/researcher (agent) - AI agent definitions
  kdco/background-agents (plugin) - Background agent sync plugin
  acme/agent-utils (lib) - Agent utility functions

$ ocx search --installed
Installed components (2):
  kdco/researcher v1.2.0 from kdco
  kdco/notify v0.5.0 from kdco
```

### Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `No ocx.jsonc found` | Not initialized | Run `ocx init` first |
| `No components installed` | Lock file empty | Run `ocx add` first |

---

## ocx registry

Manage configured registries.

### Subcommands

- [`ocx registry add`](#ocx-registry-add) - Add a registry
- [`ocx registry remove`](#ocx-registry-remove) - Remove a registry
- [`ocx registry list`](#ocx-registry-list) - List configured registries

---

### ocx registry add

Add a new registry to your configuration.

#### Usage

```bash
ocx registry add <url> [options]
```

#### Arguments

| Argument | Description |
|----------|-------------|
| `url` | Registry URL (required) |

#### Options

| Option | Description |
|--------|-------------|
| `--name <name>` | Registry alias (defaults to hostname) |
| `-f, --force` | Overwrite existing registry |
| `-g, --global` | Add to global config (~/.config/opencode) |
| `-p, --profile <name>` | Use specific global profile for registry resolution |
| `--cwd <path>` | Working directory (default: current directory) |
| `--json` | Output as JSON |
| `-q, --quiet` | Suppress output |

#### Examples

```bash
# Add a registry (name derived from hostname)
ocx registry add https://registry.example.com

# Add with custom name
ocx registry add https://registry.example.com --name myregistry

# Get machine-readable output
ocx registry add https://registry.example.com --json

# Update existing registry (requires --force)
ocx registry add https://new-url.example.com --name myregistry --force
```

#### Registry Scope (Local-First)

By default, `ocx registry add` modifies your **local** project config (`.opencode/ocx.jsonc`). Use `--global` to add to the global config instead:

```bash
# Add to local config
ocx registry add https://registry.example.com --name myregistry

# Add to global config
ocx registry add https://registry.example.com --name myregistry --global
```

**Note:** `--global` and `--cwd` are mutually exclusive.

#### Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `No ocx.jsonc found` | Not initialized | Run `ocx init` first |
| `Registries are locked` | `lockRegistries: true` in config | Remove lock or edit config manually |
| `Registry 'name' already exists` | Duplicate name | Use `--force` to overwrite, or choose a different `--name` |

---

### ocx registry remove

Remove a registry from your configuration.

#### Usage

```bash
ocx registry remove <name> [options]
```

#### Arguments

| Argument | Description |
|----------|-------------|
| `name` | Registry name (required) |

#### Options

| Option | Description |
|--------|-------------|
| `-g, --global` | Remove from global config |
| `-p, --profile <name>` | Use specific global profile for registry resolution |
| `--cwd <path>` | Working directory (default: current directory) |
| `--json` | Output as JSON |
| `-q, --quiet` | Suppress output |

#### Examples

```bash
# Remove a registry
ocx registry remove myregistry

# Remove from global config
ocx registry remove myregistry --global

# Get machine-readable output
ocx registry remove myregistry --json
```

#### Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `No ocx.jsonc found` | Not initialized | Run `ocx init` first |
| `Registries are locked` | `lockRegistries: true` in config | Remove lock or edit config manually |
| `Registry 'name' not found` | Registry doesn't exist | Check name with `ocx registry list` |

---

### ocx registry list

List all configured registries.

#### Usage

```bash
ocx registry list [options]
```

#### Options

| Option | Description |
|--------|-------------|
| `-g, --global` | List registries from global config |
| `-p, --profile <name>` | Use specific global profile for registry resolution |
| `--cwd <path>` | Working directory (default: current directory) |
| `--json` | Output as JSON |
| `-q, --quiet` | Suppress output |

#### Examples

```bash
# List registries
ocx registry list

# List global registries
ocx registry list --global

# Get machine-readable output
ocx registry list --json
```

#### Output

```bash
$ ocx registry list
Configured registries:
  kdco: https://ocx.kdco.dev (latest)
  acme: https://registry.acme.com (1.0.0)

$ ocx registry list --json
{
  "success": true,
  "data": {
    "registries": [
      { "name": "kdco", "url": "https://ocx.kdco.dev", "version": "latest" },
      { "name": "acme", "url": "https://registry.acme.com", "version": "1.0.0" }
    ],
    "locked": false
  }
}
```

---

## ocx build

Build a registry from source files. This command is for registry authors who want to publish their own components.

### Usage

```bash
ocx build [path] [options]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `path` | Registry source directory (default: current directory) |

### Options

| Option | Description |
|--------|-------------|
| `--out <dir>` | Output directory (default: `./dist`) |
| `--cwd <path>` | Working directory (default: current directory) |
| `--json` | Output as JSON |
| `-q, --quiet` | Suppress output |

### Examples

```bash
# Build registry in current directory
ocx build

# Build from specific directory
ocx build ./my-registry

# Specify output directory
ocx build --out ./public

# Get machine-readable output
ocx build --json
```

### Output

```bash
$ ocx build
Building registry...
Built 5 components to dist

$ ocx build --json
{
  "success": true,
  "data": {
    "name": "my-registry",
    "version": "1.0.0",
    "components": 5,
    "output": "/path/to/dist"
  }
}
```

### Source Structure

The build command expects a `registry.jsonc` file in the source directory:

```
my-registry/
  registry.jsonc        # Registry manifest
  files/
    agent/
      my-agent.md       # Agent definition
    plugin/
      my-plugin.ts      # Plugin file
    skills/
      my-skill/
        SKILL.md        # Skill definition
```

### Errors

| Error | Cause | Solution |
|-------|-------|----------|
| Build errors | Invalid registry.jsonc or missing files | Check error messages for details |

---

## ocx self update

Update OCX to the latest version.

```bash
ocx self update [options]
```

### Options

| Option | Description |
|--------|-------------|
| `--method <method>` | Override install method detection (curl\|npm\|pnpm\|bun) |
| `--force` | Force update even if already on latest version |

### Examples

```bash
# Update to latest version
ocx self update

# Force reinstall via npm
ocx self update --method npm --force
```

### Notes

- OCX automatically detects how it was installed and uses the appropriate update method
- For curl-installed binaries, downloads from GitHub releases with SHA256 verification
- For npm/pnpm/bun installs, uses the respective package manager's global install

---

## ocx self uninstall

Remove OCX global configuration files and binary.

```bash
ocx self uninstall [options]
```

### Options

| Option      | Description                   |
| ----------- | ----------------------------- |
| `--dry-run` | Preview what would be removed |

### What Gets Removed

- `~/.config/opencode/profiles/` - All profiles
- `~/.config/opencode/ocx.jsonc` - Global OCX config
- `~/.config/opencode/` - Root directory (only if empty after cleanup)
- Binary executable (for curl installs only; package-managed prints command)

### Exit Codes

| Code | Meaning                                            |
| ---- | -------------------------------------------------- |
| 0    | Success (removed, already missing, or dry-run)     |
| 1    | Error (package-managed install, permission denied) |
| 2    | Safety error (symlink root, containment violation) |

### Examples

```bash
# Preview what would be removed
ocx self uninstall --dry-run

# Remove OCX installation
ocx self uninstall
```

### Notes

- **Package-managed installs**: If installed via npm/pnpm/bun/yarn, the command removes config files but prints the package manager removal command instead of deleting the binary directly.
- **Safety**: Only removes known OCX files (allowlist approach). Unexpected files in the config directory are left untouched.
- **Symlinks**: Symlinks are unlinked without following. Symlink targets are preserved.
- **Idempotent**: Safe to run multiple times. Returns success if already uninstalled.

---

## Global Options

These options are available on all commands:

| Option | Description |
|--------|-------------|
| `--cwd <path>` | Set working directory |
| `--json` | Output as JSON for scripting |
| `-q, --quiet` | Suppress non-essential output |
| `-v, --verbose` | Show detailed output |
| `-h, --help` | Show help for command |
| `-V, --version` | Show version number |

---

## Exit Codes

| Code | Name       | Description                    |
|------|------------|--------------------------------|
| 0    | Success    | Command completed successfully |
| 1    | General    | Unspecified error              |
| 6    | Conflict   | Resource already exists        |
| 66   | Not Found  | Resource not found             |
| 69   | Network    | Network/connectivity error     |
| 73   | Integrity  | Component hash mismatch        |
| 78   | Config     | Configuration error            |

---

## Configuration Files

### Local Configuration

#### .opencode/ocx.jsonc

Local project configuration created by `ocx init`:

```jsonc
{
  "$schema": "https://ocx.kdco.dev/schemas/ocx.json",
  "registries": {
    "kdco": {
      "url": "https://ocx.kdco.dev"
    }
  },
  "lockRegistries": false  // prevent registry modification
}
```

#### .opencode/opencode.jsonc

OpenCode-specific configuration (optional):

```jsonc
{
  "name": "My Project",
  "agents": ["coder", "researcher"]
}
```

### Global Configuration

#### ~/.config/opencode/ocx.jsonc

Global base configuration (used for downloading global settings like profiles, NOT applied to projects):

```jsonc
{
  "registries": {
    "kdco": {
      "url": "https://ocx.kdco.dev"
    }
  }
}
```

### Profile Configuration

#### ~/.config/opencode/profiles/\<name\>/ocx.jsonc

Profile-specific OCX settings:

```jsonc
{
  "registries": {
    "kdco": {
      "url": "https://ocx.kdco.dev"
    }
  },
  "exclude": ["**/AGENTS.md", "**/CLAUDE.md", "**/CONTEXT.md"],
  "include": [],
  "bin": "/path/to/custom/opencode"  // optional
}
```

#### ~/.config/opencode/profiles/\<name\>/opencode.jsonc

Profile-specific OpenCode configuration:

```jsonc
{
  "name": "Work Profile",
  "agents": ["coder", "researcher"],
  "maxTurns": 100
}
```

#### ~/.config/opencode/profiles/\<name\>/AGENTS.md

Profile-specific agent instructions (highest priority).

### .ocx/receipt.jsonc

Receipt tracking installed components (managed automatically):

```jsonc
{
  "version": 1,
  "installed": {
    "kdco/researcher": {
      "registry": "kdco",
      "version": "1.2.0",
      "hash": "abc123...",
      "files": [".opencode/agents.md"],
      "installedAt": "2024-01-15T10:30:00Z",
      "updatedAt": "2024-01-20T14:00:00Z"
    }
  }
}
```

Receipts are advisory records of what was installed. They help track provenance but do not enforce strict lockfile semantics. Use version pinning in your `ocx.jsonc` for reproducible builds.

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OCX_PROFILE` | Set the active global profile for commands |
| `OPENCODE_BIN` | Path to custom OpenCode binary |
| `OCX_NO_COLOR` | Disable colored output |
| `NO_COLOR` | Standard no-color flag |
| `OCX_SELF_UPDATE` | Set to `off` to disable self-update functionality |
| `OCX_NO_UPDATE_CHECK` | Set to `1` to disable update notifications on startup |
| `EDITOR` | Text editor for `ocx config edit` |
| `VISUAL` | Fallback editor if `EDITOR` not set |

---

## ocx profile

Manage global profiles for different OpenCode configurations.

### Subcommands

- [`ocx profile list`](#ocx-profile-list) - List all global profiles
- [`ocx profile add`](#ocx-profile-add) - Create new profile or install from registry
- [`ocx profile remove`](#ocx-profile-remove) - Delete a profile
- [`ocx profile move`](#ocx-profile-move) - Rename a profile
- [`ocx profile show`](#ocx-profile-show) - Display profile contents

### Aliases

```bash
ocx p <subcommand>  # Short alias for profile commands
```

---

### ocx profile list

List all available global profiles.

#### Usage

```bash
ocx profile list [options]
ocx p ls [options]  # alias
```

#### Options

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |

#### Examples

```bash
# List all profiles
ocx profile list

# List with JSON output
ocx p ls --json
```

#### Output

```bash
$ ocx profile list
Global profiles:
  default
  work
  client-x

$ ocx profile list --json
{
  "profiles": ["default", "work", "client-x"],
  "initialized": true
}
```

---

### ocx profile add

Create a new profile, clone from existing, or install from registry.

#### Usage

```bash
ocx profile add <name> [options]
ocx p add <name> [options]  # alias
```

#### Arguments

| Argument | Description |
|----------|-------------|
| `name` | Profile name (required) |

#### Options

| Option | Description |
|--------|-------------|
| `--from <source>` | Clone from existing profile, install from registry (e.g., kit/ws), or full URL |
| `-g, --global` | Create global profile (default is local) |

#### Examples

```bash
# Create new empty profile
ocx profile add work --global

# Clone from existing profile
ocx profile add client-x --from work --global

# Install from registry with one command (not saved)
ocx profile add ws --from https://ocx-kit.kdco.dev/ws --global

# Or first add global registry, then install
ocx registry add https://ocx-kit.kdco.dev --name kit --global
ocx profile add ws --from kit/ws --global

# Overwrite existing profile (remove and add again)
ocx profile remove ws --global
ocx profile add ws --from kit/ws --global

# Using alias
ocx p add personal --global
```

#### Notes

- Profile names must be valid filesystem names
- Spaces are automatically converted to hyphens
- `--from` accepts: existing profile name, `registry/component` shorthand, or full URL
- To overwrite an existing profile, remove it first with `ocx profile rm <name>`, then add again

---

### ocx profile remove

Delete a profile (local by default, global with `--global`).

#### Usage

```bash
ocx profile remove <name> [options]
ocx p rm <name> [options]  # alias
```

#### Arguments

| Argument | Description |
|----------|-------------|
| `name` | Profile name to delete (required) |

#### Options

| Option | Description |
|--------|-------------|
| `-g, --global` | Remove global profile (default: local) |

#### Examples

```bash
# Remove a local profile
ocx profile remove old-profile

# Remove a global profile
ocx profile remove old-profile --global
```

#### Notes

- Deletion is immediate (Cargo-style, no confirmation prompt)
- Cannot delete the last remaining profile
- Default is local profiles; use `--global` for global profiles

---

### ocx profile move

Rename a profile (local by default, global with `--global`).

#### Usage

```bash
ocx profile move <old-name> <new-name> [options]
ocx p mv <old-name> <new-name> [options]  # alias
```

#### Arguments

| Argument   | Description                     |
| ---------- | ------------------------------- |
| `old-name` | Current profile name (required) |
| `new-name` | New profile name (required)     |

#### Options

| Option | Description |
|--------|-------------|
| `-g, --global` | Move global profile (default: local) |

#### Examples

```bash
# Rename a local profile
ocx profile move work client-work

# Rename a global profile
ocx profile move work client-work --global

# Using alias
ocx p mv personal home
```

#### Notes

- Profile names must be 1-32 characters, alphanumeric with dots, underscores, hyphens
- Cannot rename to a name that already exists (remove target first)
- Warns if renaming the active profile (update `OCX_PROFILE` env var)
- Self-rename (same old and new name) is a silent no-op
- Default is local profiles; use `--global` for global profiles

#### Errors

| Error                           | Cause                    | Solution                                             |
| ------------------------------- | ------------------------ | ---------------------------------------------------- |
| `Profile "X" not found`         | Source profile not found | Check name with `ocx profile list`                   |
| `Cannot move: profile "Y" already exists` | Target name conflicts    | Remove existing profile first with `ocx profile rm Y` |

---

### ocx profile show

Display profile configuration and contents.

#### Usage

```bash
ocx profile show [name] [options]
ocx p show [name] [options]  # alias
```

#### Arguments

| Argument | Description |
|----------|-------------|
| `name` | Profile name (optional, defaults to resolved profile) |

#### Options

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |

#### Examples

```bash
# Show current profile (uses resolved profile)
ocx profile show

# Show work profile config
ocx profile show work

# Get JSON output
ocx p show work --json
```

#### Output

```bash
$ ocx profile show work
Profile: work
Path: /Users/username/.config/opencode/profiles/work/

Files:
  ocx.jsonc
  opencode.jsonc
  AGENTS.md

Configuration:
  Registries: kdco
  Exclude patterns: **/AGENTS.md, **/CLAUDE.md
  Include patterns: (none)
```

---

## ocx config

View and edit OCX configuration files.

### Subcommands

- [`ocx config show`](#ocx-config-show) - Show configuration from current scope
- [`ocx config edit`](#ocx-config-edit) - Edit configuration in $EDITOR

---

### ocx config show

Show configuration from current directory.

#### Usage

```bash
ocx config show [options]
```

#### Options

| Option | Description |
|--------|-------------|
| `--origin` | Show source of each configuration setting |
| `-p, --profile <name>` | Use specific profile for resolution |
| `--json` | Output as JSON |

#### Examples

```bash
# Show config from current scope
ocx config show

# Show config with sources
ocx config show --origin

# Show config using specific profile
ocx config show -p work

# Get JSON output
ocx config show --json
```

#### Output

```bash
$ ocx config show
Merged configuration:
  Registries: kdco
  Component path: .opencode

$ ocx config show --origin
Configuration sources:
  registries:
    kdco: global profile (work)
  componentPath:
    .opencode: local config
```

---

### ocx config edit

Edit configuration file in `$EDITOR`.

#### Usage

```bash
ocx config edit [options]
```

#### Options

| Option | Description |
|--------|-------------|
| `--global` | Edit global config |
| `-p, --profile <name>` | Edit specific profile's config (implies --global) |

#### Environment

- **`$EDITOR`**: Text editor to use (e.g., `vim`, `nano`, `code`)
- **`$VISUAL`**: Fallback editor if `$EDITOR` not set

#### Examples

```bash
# Edit local .opencode/ocx.jsonc
ocx config edit

# Edit global ocx.jsonc
ocx config edit --global

# Edit specific profile's ocx.jsonc
ocx config edit -p work
```

#### Notes

- Local config: `.opencode/ocx.jsonc`
- Global config: `~/.config/opencode/ocx.jsonc`
- Profile config: `~/.config/opencode/profiles/<name>/ocx.jsonc`
- Falls back to `vi` if neither `$EDITOR` nor `$VISUAL` are set

---

## ocx opencode

Launch OpenCode with resolved configuration and profile support.

### Usage

```bash
ocx opencode [options]
ocx oc [options]  # alias
```

### Arguments

This command does not take arguments. It always runs from the current working directory.

### Options

| Option | Description |
|--------|-------------|
| `-p, --profile <name>` | Use specific global profile |
| `--no-rename` | Skip automatic window/terminal renaming |

**Note:** Only `-p`/`--profile` and `--no-rename` are OCX flags. All other arguments and flags pass through to OpenCode. Use `--` to pass flags that conflict with OCX (e.g., `ocx oc -- --help` forwards help to opencode).

### Profile Resolution Priority

Profiles are resolved in this order (first match wins):

1. **`--profile` / `-p` flag** - Explicit CLI specification
2. **`OCX_PROFILE` environment variable** - Session-level profile
3. **`profile` field in `.opencode/ocx.jsonc`** - Project-specific profile
4. **`default` profile** - If it exists
5. **No profile** - Base configs only

### Examples

```bash
# Launch with default profile
ocx opencode

# Launch with specific profile
ocx opencode -p work

# Skip automatic window renaming
ocx opencode --no-rename

# Using environment variable
OCX_PROFILE=work ocx opencode

# Using alias
ocx oc -p personal

# Pass flags directly to OpenCode (use -- before OpenCode flags)
# Example: Get help for OpenCode itself
ocx oc -- --help
```

### How It Works

1. **Profile Resolution**: Resolves profile using priority order
2. **Profile Layering**: If both global and local profiles exist with same name, merges them
3. **Config Merging**: Deep merges profile configs (global + local)
4. **Instruction Discovery**: Discovers instruction files in priority order
5. **Pattern Filtering**: Applies exclude/include patterns from merged profile
6. **Launch OpenCode**: Spawns with merged config and discovered instructions

### Custom OpenCode Binary

To use a custom OpenCode binary (e.g., development build), set the `bin` option in your profile's `ocx.jsonc`:

```jsonc
{
  "bin": "/path/to/custom/opencode"
}
```

**Resolution order:**
1. `bin` in profile's `ocx.jsonc`
2. `OPENCODE_BIN` environment variable
3. `opencode` (system PATH)

### Configuration Merging

**OCX configs (`ocx.jsonc`) merge when using profiles:**
- Global profile `ocx.jsonc` (base layer)
- Local profile `ocx.jsonc` (overlay layer, if exists)
- Deep merge with local winning on conflicts

**OpenCode configs (`opencode.jsonc`) cascade:**
1. Global profile's `opencode.jsonc`
2. Local profile's `opencode.jsonc` (if exists, deep merged)
3. Local `.opencode/opencode.jsonc` (if not excluded, deep merged)

**Registry Isolation:**
Global base config registries (`~/.config/opencode/ocx.jsonc`) are ONLY used for downloading profiles, never for components.
When using a profile, registries come from merged profile config.

**Security:** This isolation prevents global registries from injecting components into all projects.

### Instruction File Discovery

OCX doesn't exclude anything by default. A clean ocx.jsonc includes all project instruction files. The default profile template ships an exclude list for security.

**Instruction file types** (OpenCode's "first type wins" rule):
- **AGENTS.md** (recommended): If ANY `AGENTS.md` is found in the project tree, all `AGENTS.md` files are used and `CLAUDE.md`/`CONTEXT.md` are **completely ignored**
- **CLAUDE.md** (fallback): Only used if no `AGENTS.md` exists anywhere in the project
- **CONTEXT.md** (deprecated, legacy): Only used if neither `AGENTS.md` nor `CLAUDE.md` exist

**Global instructions**: `~/.config/opencode/AGENTS.md` is **always included** regardless of profile or file type.

**The default profile template uses this exclude list:**
```jsonc
{
  "exclude": [
    "**/AGENTS.md",
    "**/CLAUDE.md",
    "**/CONTEXT.md",
    "**/.opencode/**",
    "**/opencode.jsonc",
    "**/opencode.json"
  ]
}
```

**To include project files**, modify your profile's `ocx.jsonc`:

```jsonc
{
  // Include all project AGENTS.md files
  "exclude": ["**/CLAUDE.md", "**/CONTEXT.md"],
  
  // Or exclude all but include specific ones
  "exclude": ["**/AGENTS.md"],
  "include": ["./docs/AGENTS.md"]
}
```

**See also**: [PROFILES.md](./PROFILES.md) for complete instruction discovery details and priority order.

---

## See Also

- [Registry Protocol](./REGISTRY_PROTOCOL.md) - How registries work
- [Contributing Guide](../CONTRIBUTING.md) - Development setup

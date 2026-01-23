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

## Commands

- [`ocx init`](#ocx-init) - Initialize OCX configuration
- [`ocx add`](#ocx-add) - Add components from a registry
- [`ocx update`](#ocx-update) - Update installed components
- [`ocx diff`](#ocx-diff) - Compare installed vs upstream
- [`ocx search`](#ocx-search) - Search for components
- [`ocx registry`](#ocx-registry) - Manage registries
- [`ocx build`](#ocx-build) - Build a registry from source
- [`ocx self update`](#ocx-self-update) - Update OCX to latest version
- [`ocx profile`](#ocx-profile) - Manage global profiles
- [`ocx config`](#ocx-config) - View and edit configuration
- [`ocx opencode`](#ocx-opencode) - Launch OpenCode with resolved configuration

---

## ocx init

Initialize OCX configuration locally or globally with profile support.

### Usage

```bash
ocx init [directory] [options]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `directory` | Target directory (default: current directory) |

### Options

| Option | Description |
|--------|-------------|
| `-f, --force` | Skip prompts and use defaults |
| `--cwd <path>` | Working directory (default: current directory) |
| `-q, --quiet` | Suppress output |
| `-v, --verbose` | Verbose output |
| `--json` | Output as JSON |
| `--global` | Initialize global configuration with default profile |
| `--registry` | Scaffold a new OCX registry project |
| `--namespace <name>` | Registry namespace (e.g., `my-org`) |
| `--author <name>` | Author name for the registry |
| `--canary` | Use canary (main branch) instead of latest release |
| `--local <path>` | Use local template directory instead of fetching |

### Examples

```bash
# Initialize local .opencode/ directory
ocx init

# Initialize global profiles
ocx init --global

# Initialize with defaults (no prompts)
ocx init -f

# Overwrite existing configuration
ocx init --force

# Initialize in a specific directory
ocx init ./my-project
```

### Scaffolding a Registry

```bash
# Create a new registry project
ocx init my-registry --registry --namespace my-org

# Use custom author
ocx init my-registry --registry --namespace acme --author "Acme Corp"

# Use latest development version
ocx init my-registry --registry --canary
```

### Output Files

**Local initialization** creates:

| File | Description |
|------|-------------|
| `.opencode/ocx.jsonc` | Local project configuration |
| `.opencode/opencode.jsonc` | OpenCode-specific configuration (optional) |
| `.opencode/ocx.lock` | Lock file tracking installed components |

**Global initialization** (`--global`) creates:

```
~/.config/opencode/
├── ocx.jsonc                 # Global base config
└── profiles/
    └── default/
        ├── ocx.jsonc         # Profile OCX settings
        ├── opencode.jsonc    # Profile OpenCode config
        └── AGENTS.md         # Profile instructions
```

### Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `ocx.jsonc already exists` | Config file exists | Use `--force` to overwrite |
| `Invalid namespace format` | Namespace contains invalid characters | Use lowercase letters, numbers, and hyphens only |
| `Directory is not empty` | Target directory has files | Use `--force` to proceed anyway |

---

## ocx add

Add components from configured registries to your project.

### Usage

```bash
ocx add <components...> [options]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `components` | One or more components to install (required) |

### Options

| Option | Description |
|--------|-------------|
| `-f, --force` | Overwrite existing components/plugins without prompting |
| `--trust` | Skip plugin validation for npm packages (allows non-ESM packages) |
| `--dry-run` | Show what would be installed without making changes |
| `-p, --profile <name>` | Use specific global profile for registry resolution |
| `--cwd <path>` | Working directory (default: current directory) |
| `-q, --quiet` | Suppress output |
| `-v, --verbose` | Verbose output |
| `--json` | Output as JSON |

### Component Syntax

Components can be specified in multiple formats:

```bash
# Registry component (fully qualified)
ocx add kdco/agents

# npm plugin (direct from npm registry)
ocx add npm:opencode-plugin-foo
ocx add npm:@scope/plugin-name
ocx add npm:some-plugin@1.0.0

# Multiple components
ocx add kdco/agents kdco/skills kdco/plugins
```

### Examples

```bash
# Add a registry component
ocx add kdco/background-agents

# Add using a specific profile
ocx add kdco/agents --profile work

# Add an npm plugin directly
ocx add npm:@franlol/opencode-md-table-formatter

# Add npm plugin with specific version
ocx add npm:some-plugin@1.0.0

# Add multiple at once (mix of registry and npm)
ocx add kdco/researcher npm:opencode-plugin-foo

# Preview installation
ocx add kdco/agents --dry-run

# Overwrite existing files without prompts
ocx add kdco/agents --force

# Get machine-readable output
ocx add kdco/agents --json

# Verbose output showing all file operations
ocx add kdco/agents --verbose
```

### Bypassing Plugin Validation

By default, OCX validates that npm packages are valid OpenCode plugins (ESM modules with entry points). To skip validation:

```bash
ocx add npm:some-package --trust
```

### Behavior

1. **Resolves dependencies** - Fetches component manifest and resolves any dependencies
2. **Pre-flight checks** - Validates all files before writing any (atomic operation)
3. **Conflict detection** - Checks for modified local files
4. **Writes files** - Installs component files to target paths
5. **Updates opencode.jsonc** - Merges component configuration
6. **Updates lock file** - Records installed version and hash

### Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `No ocx.jsonc found` | Not initialized | Run `ocx init` first |
| `File conflicts detected` | Local files modified | Use `--force` to overwrite or review changes |
| `Integrity check failed` | Hash mismatch | Component was modified; resolve manually |
| `File conflict: already exists` | Another component installed this file | Remove conflicting file first |

---

## ocx update

Update installed components to their latest versions or pin to specific versions.

### Usage

```bash
ocx update [components...] [options]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `components` | Components to update (optional with `--all` or `--registry`) |

### Options

| Option | Description |
|--------|-------------|
| `--all` | Update all installed components |
| `--registry <name>` | Update all components from a specific registry |
| `--dry-run` | Preview changes without applying |
| `-p, --profile <name>` | Use specific global profile for registry resolution |
| `--cwd <path>` | Working directory (default: current directory) |
| `-q, --quiet` | Suppress output |
| `-v, --verbose` | Verbose output |
| `--json` | Output as JSON |

### Version Pinning

Use the `@version` syntax (like npm/bun) to pin to a specific version:

```bash
# Pin to specific version
ocx update kdco/agents@1.2.0

# Multiple components with different versions
ocx update kdco/agents@1.2.0 kdco/skills@2.0.0
```

### Examples

```bash
# Update a specific component to latest
ocx update kdco/background-agents

# Update multiple components
ocx update kdco/agents kdco/plugins

# Update all installed components
ocx update --all

# Preview what would be updated
ocx update --all --dry-run

# Update all components from one registry
ocx update --registry kdco

# Pin to a specific version
ocx update kdco/agents@1.2.0

# Get machine-readable output
ocx update --all --json

# Verbose output showing file changes
ocx update kdco/agents --verbose
```

### Behavior

1. **Validates arguments** - Ensures valid component selection
2. **Fetches latest versions** - Gets current registry state
3. **Compares hashes** - Determines which components have changes
4. **Applies updates** - Writes new files (skipped in dry-run mode)
5. **Updates lock file** - Records new version and hash

### Dry Run Output

```bash
$ ocx update --all --dry-run

Would update:
  kdco/agents (1.0.0 → 1.2.0)
  kdco/plugins (0.5.0 → 0.6.0)

Already up to date:
  kdco/skills

Run without --dry-run to apply changes.
```

### Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `No ocx.jsonc found` | Not initialized | Run `ocx init` first |
| `Nothing installed yet` | Lock file empty | Run `ocx add <component>` first |
| `Specify components, use --all, or use --registry` | No arguments provided | Provide components or use a flag |
| `Cannot specify components with --all` | Mutually exclusive options | Use one or the other |
| `Cannot specify components with --registry` | Mutually exclusive options | Use one or the other |
| `Cannot use --all with --registry` | Mutually exclusive options | Use one or the other |
| `Component 'name' must include a registry prefix` | Missing namespace | Use fully qualified name (e.g., `kdco/agents`) |
| `Component 'name' is not installed` | Not in lock file | Install first with `ocx add` |
| `Invalid version specifier` | Empty version after `@` | Provide version or omit `@` |

---

## ocx diff

Show differences between installed components and upstream registry versions.

### Usage

```bash
ocx diff [component] [options]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `component` | Component to diff (optional; diffs all if omitted) |

### Options

| Option | Description |
|--------|-------------|
| `--cwd <path>` | Working directory (default: current directory) |
| `-p, --profile <name>` | Use specific global profile for registry resolution |
| `--json` | Output as JSON |
| `-q, --quiet` | Suppress output |

### Examples

```bash
# Diff all installed components
ocx diff

# Diff a specific component
ocx diff kdco/agents

# Get machine-readable output
ocx diff --json

# Diff with quiet mode (only show differences)
ocx diff --quiet
```

### Output

Components without changes show a success message:

```bash
$ ocx diff kdco/agents
kdco/agents: No changes
```

Modified components show a unified diff:

```bash
$ ocx diff kdco/plugins

Diff for kdco/plugins:
--- upstream
+++ local
@@ -10,6 +10,7 @@
 export function notify() {
+  console.log("Debug: entering notify")
   // ...
 }
```

### Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `No ocx.lock found` | No lock file | Run `ocx add` first |
| `No ocx.jsonc found` | Not initialized | Run `ocx init` first |
| `Component 'name' not found in lockfile` | Not installed | Check spelling or install first |
| `Registry 'name' not configured` | Registry removed from config | Add registry back with `ocx registry add` |

---

## ocx search

Search for components across registries or list installed components.

### Usage

```bash
ocx search [query] [options]
```

### Aliases

```bash
ocx list [query] [options]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `query` | Search query (optional; lists all if omitted) |

### Options

| Option | Description |
|--------|-------------|
| `--cwd <path>` | Working directory (default: current directory) |
| `-p, --profile <name>` | Use specific global profile for registry resolution |
| `--json` | Output as JSON |
| `-q, --quiet` | Suppress output |
| `-v, --verbose` | Verbose output |
| `-i, --installed` | List installed components only |
| `-l, --limit <n>` | Limit results (default: 20) |

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
  kdco/agents (agent) - AI agent definitions
  kdco/background-agents (plugin) - Background agent sync plugin
  acme/agent-utils (lib) - Agent utility functions

$ ocx search --installed
Installed components (2):
  kdco/agents v1.2.0 from kdco
  kdco/plugins v0.5.0 from kdco
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
| `--version <version>` | Pin to specific version |
| `-g, --global` | Add to global config (~/.config/opencode) instead of local project |
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

# Pin to specific version
ocx registry add https://registry.example.com --name myregistry --version 1.0.0

# Get machine-readable output
ocx registry add https://registry.example.com --json
```

#### Global Registry

Add a registry to your global config (available to all projects):

```bash
ocx registry add https://registry.example.com --name myregistry --global
```

**Note:** `--global` and `--cwd` are mutually exclusive.

#### Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `No ocx.jsonc found` | Not initialized | Run `ocx init` first |
| `Registries are locked` | `lockRegistries: true` in config | Remove lock or edit config manually |
| `Registry 'name' already exists` | Duplicate name | Use a different `--name` |

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
| `-g, --global` | Remove from global config instead of local project |
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
| `-g, --global` | List registries from global config only |
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
    skill/
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
| `-m, --method <method>` | Override install method detection (curl\|npm\|pnpm\|bun) |
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

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | General error |
| `2` | Validation error |
| `3` | Not found |
| `4` | Network error |
| `5` | Configuration error |
| `6` | Conflict error |
| `7` | Integrity error |

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
      "url": "https://ocx.kdco.dev",
      "version": "1.0.0"  // optional: pin version
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

### .opencode/ocx.lock

Lock file tracking installed components (managed automatically):

```json
{
  "lockVersion": 1,
  "installed": {
    "kdco/agents": {
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
| `EDITOR` | Text editor for `ocx config edit` and `ocx profile config` |
| `VISUAL` | Fallback editor if `EDITOR` not set |

---

## ocx profile

Manage global profiles for different OpenCode configurations.

### Subcommands

- [`ocx profile list`](#ocx-profile-list) - List all global profiles
- [`ocx profile add`](#ocx-profile-add) - Create new profile or install from registry
- [`ocx profile remove`](#ocx-profile-remove) - Delete a profile
- [`ocx profile show`](#ocx-profile-show) - Display profile contents
- [`ocx profile config`](#ocx-profile-config) - Edit profile's ocx.jsonc

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
Available profiles:
  * default
    work
    client-x

$ ocx profile list --json
{
  "profiles": ["default", "work", "client-x"],
  "current": "default"
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
| `--from <source>` | Clone from existing profile or install from registry (e.g., kdco/minimal) |
| `-f, --force` | Overwrite existing profile |

#### Examples

```bash
# Create new empty profile
ocx profile add work

# Clone from existing profile
ocx profile add client-x --from work

# Install from registry (requires global registry config)
ocx registry add https://registry.kdco.dev --name kdco --global
ocx profile add minimal --from kdco/minimal

# Force overwrite existing profile
ocx profile add minimal --from kdco/minimal --force

# Using alias
ocx p add personal
```

#### Notes

- Profile names must be valid filesystem names
- Spaces are automatically converted to hyphens
- Installing from registry requires global registry configuration
- Use `--force` to overwrite existing profiles

---

### ocx profile remove

Delete a global profile.

#### Usage

```bash
ocx profile remove <name>
ocx p rm <name>  # alias
```

#### Arguments

| Argument | Description |
|----------|-------------|
| `name` | Profile name to delete (required) |

#### Examples

```bash
# Remove a profile
ocx profile remove old-profile
```

#### Notes

- Deletion is immediate (Cargo-style, no confirmation prompt)
- Cannot delete the last remaining profile

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

### ocx profile config

Edit a profile's ocx.jsonc configuration file in `$EDITOR`.

#### Usage

```bash
ocx profile config [name]
ocx p config [name]  # alias
```

#### Arguments

| Argument | Description |
|----------|-------------|
| `name` | Profile name (optional, defaults to resolved profile) |

#### Environment

- **`$EDITOR`**: Text editor to use (e.g., `vim`, `nano`, `code`)
- **`$VISUAL`**: Fallback editor if `$EDITOR` not set

#### Examples

```bash
# Edit current profile config (uses resolved profile)
ocx profile config

# Edit work profile config
ocx profile config work

# Using alias
ocx p config personal
```

#### Notes

- Opens `ocx.jsonc` at `~/.config/opencode/profiles/<name>/ocx.jsonc`
- Falls back to `vi` if neither `$EDITOR` nor `$VISUAL` are set

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
| `--global` | Edit global config instead of local |
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
ocx opencode [path] [options]
ocx oc [path] [options]  # alias
```

### Arguments

| Argument | Description |
|----------|-------------|
| `path` | Project path (optional, defaults to current directory) |

### Options

| Option | Description |
|--------|-------------|
| `-p, --profile <name>` | Use specific global profile |

### Profile Resolution Priority

Profiles are resolved in this order (first match wins):

1. **`--profile` / `-p` flag** - Explicit CLI specification
2. **`OCX_PROFILE` environment variable** - Session-level profile
3. **`default` profile** - If it exists
4. **No profile** - Base configs only

### Examples

```bash
# Launch with default profile
ocx opencode

# Launch with specific profile
ocx opencode -p work

# Launch in different directory
ocx opencode /path/to/project

# Using environment variable
OCX_PROFILE=work ocx opencode

# Using alias
ocx oc -p personal
```

### How It Works

1. **Profile Resolution**: Resolves profile using priority order
2. **Config Resolution**: Uses registries from active scope only (profile OR local, not merged)
3. **Instruction Discovery**: Walks up from project directory to git root
4. **Pattern Filtering**: Applies exclude/include patterns from profile's `ocx.jsonc`
5. **Window Naming** (optional): Sets terminal/tmux window name
6. **Launch OpenCode**: Spawns OpenCode with isolated registries and merged OpenCode settings

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

### Configuration Isolation

**OCX configs (`ocx.jsonc`) are ISOLATED per scope:**
- When using a profile: ONLY profile's registries are available
- In normal mode: ONLY local project's registries are available
- Global registries: ONLY for downloading global settings (like profiles)

**OpenCode configs (`opencode.jsonc`) DO merge:**
1. Profile's `opencode.jsonc` (if using a profile)
2. Apply exclude/include patterns from profile
3. Local `.opencode/opencode.jsonc` (if not excluded)

**Security:** This isolation prevents global registries from injecting components into all projects.

### Instruction File Discovery

By default, all project instruction files are excluded so only profile files are used.

**Default exclude patterns:**
- `**/AGENTS.md`
- `**/CLAUDE.md`
- `**/CONTEXT.md`
- `**/.opencode/**`
- `**/opencode.jsonc`
- `**/opencode.json`

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

---

## See Also

- [Registry Protocol](./REGISTRY_PROTOCOL.md) - How registries work
- [Contributing Guide](../CONTRIBUTING.md) - Development setup

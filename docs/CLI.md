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

- [`ocx init`](#ocx-init) - Initialize OCX in your project
- [`ocx add`](#ocx-add) - Add components from a registry
- [`ocx update`](#ocx-update) - Update installed components
- [`ocx diff`](#ocx-diff) - Compare installed vs upstream
- [`ocx search`](#ocx-search) - Search for components
- [`ocx registry`](#ocx-registry) - Manage registries
- [`ocx build`](#ocx-build) - Build a registry from source
- [`ocx self update`](#ocx-self-update) - Update OCX to latest version

---

## ocx init

Initialize OCX configuration in your project or scaffold a new registry.

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
| `--registry` | Scaffold a new OCX registry project |
| `--namespace <name>` | Registry namespace (e.g., `my-org`) |
| `--author <name>` | Author name for the registry |
| `--canary` | Use canary (main branch) instead of latest release |
| `--local <path>` | Use local template directory instead of fetching |

### Examples

```bash
# Initialize in current directory
ocx init

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

After initialization, OCX creates:

| File | Description |
|------|-------------|
| `ocx.jsonc` | Configuration file with registry settings |
| `ocx.lock` | Lock file tracking installed components |

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
| `--cwd <path>` | Working directory (default: current directory) |
| `--json` | Output as JSON |
| `-q, --quiet` | Suppress output |

#### Examples

```bash
# Remove a registry
ocx registry remove myregistry

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
| `--cwd <path>` | Working directory (default: current directory) |
| `--json` | Output as JSON |
| `-q, --quiet` | Suppress output |

#### Examples

```bash
# List registries
ocx registry list

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

### ocx.jsonc

Main configuration file created by `ocx init`:

```jsonc
{
  "$schema": "https://ocx.dev/schemas/ocx.schema.json",
  "registries": {
    "kdco": {
      "url": "https://ocx.kdco.dev",
      "version": "1.0.0"  // optional: pin version
    }
  },
  "lockRegistries": false  // prevent registry modification
}
```

### ocx.lock

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
| `OCX_NO_COLOR` | Disable colored output |
| `NO_COLOR` | Standard no-color flag |
| `OCX_SELF_UPDATE` | Set to `off` to disable self-update functionality |
| `OCX_NO_UPDATE_CHECK` | Set to `1` to disable update notifications on startup |

---

## See Also

- [Registry Protocol](./REGISTRY_PROTOCOL.md) - How registries work
- [Contributing Guide](../CONTRIBUTING.md) - Development setup

---

## Ghost Mode Commands

Ghost mode lets you work in repositories without modifying them.

| Command | Description |
|---------|-------------|
| `ocx ghost init` | Initialize ghost mode (`~/.config/opencode/profiles/<profile-name>/ghost.jsonc`) |
| `ocx ghost profile add <name>` | Create a new profile |
| `ocx ghost profile remove <name>` | Delete a profile |
| `ocx ghost profile list` | List available profiles |
| `ocx ghost profile use <name>` | Switch to profile |
| `ocx ghost profile show [name]` | Display profile configuration |
| `ocx ghost profile config [name]` | Open profile config in $EDITOR |
| `ocx ghost config` | Open current profile config in `$EDITOR` |
| `ocx ghost registry list` | List configured registries |
| `ocx ghost registry add <url> [--name <n>]` | Add a registry |
| `ocx ghost registry remove <name>` | Remove a registry |
| `ocx ghost add <component...>` | Add components using ghost config |
| `ocx ghost search [query]` | Search ghost registries |
| `ocx ghost opencode [args...]` | Run OpenCode with ghost config (isolated from project) |

### Ghost Config Reference

Ghost mode uses multi-profile configuration with configuration files stored at `~/.config/opencode/profiles/`. Each profile has a `ghost.jsonc` file with the same schema.

#### Profile Configuration Path

```
~/.config/opencode/profiles/
├── default/          # Default profile directory
│   └── ghost.jsonc   # Configuration file
├── work/             # Additional profile example
│   └── ghost.jsonc
└── current@          # Symlink to active profile
```

#### Schema

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `registries` | `object` | `{}` | Registry name → URL mapping |
| `componentPath` | `string` | `.opencode` | Where to install components |
| `include` | `string[]` | `[]` | Glob patterns for project files to include in ghost sessions |
| `exclude` | `string[]` | `[]` | Glob patterns to filter out from include results |
| `renameWindow` | `boolean` | `true` | Set terminal/tmux window name when launching OpenCode |

#### Include/Exclude Patterns

By default, ghost mode hides all OpenCode project files from the symlink farm. Use `include` and `exclude` to customize:

```jsonc
{
  "registries": { "kdco": { "url": "https://registry.kdco.dev" } },
  
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

This follows the TypeScript-style include/exclude model—`include` selects files, `exclude` filters the results.

---

### Ghost Profile Commands

Ghost profiles allow you to maintain multiple independent configurations for different contexts (work, personal, client projects, etc.).

#### Profile Resolution Priority

Profiles are resolved in this order (first match wins):

1. **`--profile` flag** (highest priority): Direct CLI specification
2. **`OCX_PROFILE` environment variable**: Set persistent profile for session
3. **`current` symlink**: Points to active profile in `~/.config/opencode/profiles/`
4. **`default` profile** (fallback): Used when no other selection exists

---

#### ocx ghost profile list

List all available profiles and show which one is currently active.

##### Usage

```bash
ocx ghost profile list [options]
```

##### Options

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |

##### Examples

```bash
# List profiles
ocx ghost profile list

# List with JSON output
ocx ghost profile list --json
```

##### Output

```bash
$ ocx ghost profile list
Available profiles:
  * default
    work
    client-acme

$ ocx ghost profile list --json
{
  "profiles": ["default", "work", "client-acme"],
  "current": "default"
}
```

---

#### ocx ghost profile add

Create a new profile with optional copying from an existing profile.

##### Usage

```bash
ocx ghost profile add <name> [options]
```

##### Arguments

| Argument | Description |
|----------|-------------|
| `name` | Profile name (required) |

##### Options

| Option | Description |
|--------|-------------|
| `--from <profile>` | Clone configuration from existing profile |

##### Examples

```bash
# Create new empty profile
ocx ghost profile add work

# Create profile cloned from default
ocx ghost profile add work --from default

# Create profile with spaces in name (auto-converted)
ocx ghost profile add "Client ACME"
```

##### Notes

- Profile names must be valid filesystem names
- Spaces are automatically converted to hyphens
- Invalid characters trigger an error
- Cannot create a profile that already exists

---

#### ocx ghost profile use

Switch to a different profile by updating the `current` symlink.

##### Usage

```bash
ocx ghost profile use <name>
```

##### Arguments

| Argument | Description |
|----------|-------------|
| `name` | Profile name to activate (required) |

##### Examples

```bash
# Switch to work profile
ocx ghost profile use work

# Use with --profile flag (immediately use profile)
ocx ghost profile add new-project && ocx ghost profile use new-project
```

---

#### ocx ghost profile remove

Delete a profile permanently. Cannot delete the last remaining profile.

##### Usage

```bash
ocx ghost profile remove <name> [options]
```

##### Arguments

| Argument | Description |
|----------|-------------|
| `name` | Profile name to delete (required) |

##### Options

| Option | Description |
|--------|-------------|
| `-f, --force` | Skip confirmation and allow deleting current profile |

##### Examples

```bash
# Remove profile (prompts for confirmation)
ocx ghost profile remove old-project

# Force remove without confirmation
ocx ghost profile remove old-project --force

# Remove current profile and switch to another
ocx ghost profile remove current --force && ocx ghost profile use default
```

##### Notes

- Adding `--force` skips the confirmation prompt
- Using `--force` on the current profile automatically switches to `default` after deletion
- Cannot delete the last remaining profile (use `--force` to override)

---

#### ocx ghost profile show

Display configuration for a profile (defaults to current).

##### Usage

```bash
ocx ghost profile show [name] [options]
```

##### Arguments

| Argument | Description |
|----------|-------------|
| `name` | Profile name (optional, defaults to current) |

##### Options

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--cwd <path>` | Working directory (default: current directory) |
| `-q, --quiet` | Suppress output |

##### Examples

```bash
# Show current profile config
ocx ghost profile show

# Show work profile config
ocx ghost profile show work

# Get JSON output
ocx ghost profile show --json
```

##### Output

```bash
$ ocx ghost profile show
Profile: default
Config file: /Users/username/.config/opencode/profiles/default/ghost.jsonc

Registries:
  kdco: https://registry.kdco.dev

Component path: .opencode
Include patterns:
  (none)
Exclude patterns:
  (none)
```

---

#### ocx ghost profile config

Open profile configuration in your `$EDITOR`.

##### Usage

```bash
ocx ghost profile config [name]
```

##### Arguments

| Argument | Description |
|----------|-------------|
| `name` | Profile name (optional, defaults to current) |

##### Environment

- **`$EDITOR`**: Text editor to use (e.g., `vim`, `nano`, `code`)
- **`$VISUAL`**: Fallback editor if `$EDITOR` not set

##### Examples

```bash
# Edit current profile config
ocx ghost profile config

# Edit work profile config
ocx ghost profile config work
```

##### Notes

- Opens `ghost.jsonc` at `~/.config/opencode/profiles/<name>/ghost.jsonc`
- Falls back to `vi` if neither `$EDITOR` nor `$VISUAL` are set

---

### Ghost Config (Current Profile)

Open current profile configuration in your `$EDITOR`.

#### Usage

```bash
ocx ghost config [options]
```

#### Options

| Option | Description |
|--------|-------------|
| `--profile, -p <name>` | Specify profile (overrides resolution priority) |

#### Examples

```bash
# Edit current profile
ocx ghost config

# Edit specific profile
ocx ghost config --profile work
```

---

### Ghost Init

Initialize ghost mode with a default profile at `~/.config/opencode/profiles/default/`.

#### Usage

```bash
ocx ghost init [options]
```

#### Options

| Option | Description |
|--------|-------------|
| `--profile, -p <name>` | Initialize with specific profile name (default: "default") |
| `--cwd <path>` | Working directory (default: current directory) |

#### Examples

```bash
# Initialize ghost mode
ocx ghost init

# Initialize with work profile
ocx ghost init --profile work
```

#### Output Files

```
~/.config/opencode/profiles/
└── default/
    └── ghost.jsonc
```

---

### Ghost Opencode

Run OpenCode with ghost configuration isolated from project files.

#### Usage

```bash
ocx ghost opencode [args...] [options]
```

#### Arguments

| Argument | Description |
|----------|-------------|
| `args` | Arguments to pass to OpenCode |

#### Options

| Option | Description |
|--------|-------------|
| `--profile, -p <name>` | Specify ghost profile to use |
| `--no-rename` | Disable terminal/tmux window renaming |

#### Examples

```bash
# Run OpenCode with current ghost config
ocx ghost opencode

# Run OpenCode with specific profile
ocx ghost opencode --profile work

# Pass arguments to OpenCode
ocx ghost opencode -- /path/to/file.md
```

#### How It Works

1. **Profile Resolution**: Uses profile resolution priority to select configuration
2. **OpenCode Discovery**: Finds all OpenCode files from the project
3. **Apply Filters**: Uses `include`/`exclude` patterns from ghost config
4. **Symlink Farm**: Creates temporary directory with symlinks to filtered files
5. **Git Integration**: Sets `GIT_WORK_TREE` and `GIT_DIR` to see real project
6. **Terminal Naming**: Sets terminal/tmux window name to `ghost[profile]:repo/branch` for session identification (unless disabled via `--no-rename` flag or `renameWindow: false` in config)
7. **Spawn OpenCode**: Runs OpenCode from temp directory with ghost config via env vars
8. **Cleanup**: Removes temp directory on exit

---

### Ghost Commands Error Codes

| Error | Exit Code | Description |
|-------|-----------|-------------|
| `ProfileNotFoundError` | 66 | Profile does not exist |
| `ProfileExistsError` | 1 | Profile already exists (use `ghost profile use` to switch) |
| `InvalidProfileNameError` | 1 | Invalid characters in profile name |
| `NoProfilesRemainingError` | 1 | Cannot delete last remaining profile |

---

### Ghost Commands JSON Output Schemas

#### Profile List Schema

```json
{
  "profiles": ["default", "work", "client-acme"],
  "current": "default"
}
```

- `profiles`: Array of all available profile names
- `current`: Name of the currently active profile

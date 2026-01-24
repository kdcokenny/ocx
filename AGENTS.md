# AGENTS.md

Guidelines for AI agents working in the OCX codebase.

## Project Overview

OCX is a monorepo for the OpenCode extension CLI tool. It manages component registries,
configuration files, and provides commands for adding/building/searching components.

- **Runtime:** Bun (v1.3.5+)
- **Build System:** Turbo
- **Language:** TypeScript (strict mode, ESNext)

## Build/Lint/Test Commands

### Root Commands (via Turbo)

```bash
bun run build          # Build all packages
bun run test           # Run all tests
bun run check          # Lint (Biome) + type check (tsc)
bun run format         # Auto-fix formatting with Biome
```

### Running a Single Test

```bash
# Run a specific test file
bun test packages/cli/tests/add.test.ts

# Run tests matching a pattern
bun test --grep "should resolve"

# Run tests in watch mode
bun test --watch
```

### Package-Specific Commands

From `packages/cli/`:
```bash
bun test               # Run CLI tests only
bun run check:biome    # Biome lint only
bun run check:types    # TypeScript type check only
bun run build          # Build CLI package
```

## Code Style Guidelines

### Formatting (Biome)

- **Indentation:** Tabs (width 2)
- **Line width:** 100 characters max
- **Quotes:** Double quotes for strings
- **Semicolons:** As needed (omit when possible)
- **Trailing commas:** All (including multi-line)

### Imports

```typescript
// Use `import type` for type-only imports
import type { Config } from "./types"
import { parseConfig } from "./parser"

// Imports are auto-organized - don't manually sort
// Order: external packages, then internal modules
```

### TypeScript

- **Strict mode:** Always enabled
- **No unused variables:** Error (prefix with `_` if intentional)
- **No unused imports:** Error (auto-removed by Biome)
- **Explicit return types:** Recommended for public APIs
- **Use `z.infer<typeof Schema>`** for Zod schema types

### Naming Conventions

| Element | Convention | Example |
|---------|------------|---------|
| Functions/variables | camelCase | `fetchRegistry`, `configPath` |
| Types/interfaces | PascalCase | `RegistryConfig`, `ComponentMeta` |
| Classes | PascalCase | `OCXError`, `NetworkError` |
| Constants | SCREAMING_SNAKE | `EXIT_CODES`, `DEFAULT_TIMEOUT` |
| Files | kebab-case | `handle-error.ts`, `json-output.ts` |

### Functions

```typescript
/**
 * Brief description of what the function does.
 * @param name - Description of parameter
 * @returns Description of return value
 */
export async function fetchComponent(baseUrl: string, name: string): Promise<ComponentManifest> {
  // Implementation
}
```

- Use JSDoc comments for public APIs
- Prefer `async/await` over `.then()` chains
- Use early returns to reduce nesting
- Keep functions focused and single-purpose

## Error Handling

### Custom Error Classes

All errors extend `OCXError` base class in `packages/cli/src/utils/errors.ts`:

```typescript
import { NotFoundError, NetworkError, ConfigError } from "./utils/errors"

// Throw specific error types
throw new NotFoundError("Component not found", "my-component")
throw new NetworkError("Failed to fetch", url, originalError)
throw new ConfigError("Invalid configuration", "missing 'name' field")
```

### Available Error Types

| Error Class | Use Case |
|-------------|----------|
| `NotFoundError` | Resource doesn't exist |
| `NetworkError` | HTTP/fetch failures |
| `ConfigError` | Invalid configuration |
| `ValidationError` | Schema/input validation failures |
| `ConflictError` | Resource already exists |
| `IntegrityError` | Checksum/hash mismatches |

### Exit Codes

Use `EXIT_CODES` constant for consistent exit behavior:
```typescript
import { EXIT_CODES } from "./utils/errors"
process.exit(EXIT_CODES.VALIDATION_ERROR)
```

### CLI Error Wrapper

Wrap command handlers with `handleError()`:
```typescript
import { handleError } from "./utils/handle-error"

program
  .command("add")
  .action(handleError(async (options) => {
    // Command implementation
  }))
```

## Patterns & Conventions

### Schemas (Zod)

```typescript
import { z } from "zod"

// Define schema with JSDoc
/** Configuration for a component */
export const componentManifestSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
})

// Export inferred type
export type ComponentManifest = z.infer<typeof componentManifestSchema>
```

### CLI Commands (Commander)

```typescript
import { Command } from "commander"

export function registerAddCommand(program: Command) {
  program
    .command("add <component>")
    .description("Add a component to your project")
    .option("-r, --registry <url>", "Registry URL")
    .action(handleError(addCommand))
}
```

### File I/O

```typescript
// Use Bun.file() API
const file = Bun.file(path)
const content = await file.text()

// JSONC for config files (supports comments)
import { parse } from "jsonc-parser"
const config = parse(content)
```

### Testing (bun:test)

```typescript
import { describe, it, expect, beforeAll, afterAll } from "bun:test"

describe("add command", () => {
  beforeAll(async () => {
    // Setup
  })

  it("should add component to project", async () => {
    const result = await addComponent("button")
    expect(result.success).toBe(true)
  })
})
```

## Project Structure

```
packages/cli/          # Main CLI tool (@ocx/cli)
  src/
    commands/          # CLI command implementations
      profile/         # Profile management commands
      config/          # Config commands (show, edit)
      add.ts           # Add components
      search.ts        # Search registries
      opencode.ts      # Launch OpenCode
      init.ts          # Initialize configs
      registry.ts      # Registry management
      update.ts        # Update components
      build.ts         # Build components
      diff.ts          # Component diff
      ghost/           # [TEMPORARY] Ghost mode migration
    config/            # Config providers and resolution
    profile/           # Profile management (manager, paths)
    registry/          # Registry fetching/resolution
    schemas/           # Zod schemas and config parsing
    utils/             # Shared utilities, errors, logging
  tests/               # Test files (*.test.ts)

registry/              # Component registry source files
  src/kdco/            # KDCO registry components

workers/               # Cloudflare Workers
  ocx/                 # Main OCX worker
  kdco-registry/       # KDCO registry API worker
```

## Profile System Architecture

OCX provides a global profile system for managing multiple OpenCode configurations. Profiles enable you to maintain separate configurations for different contexts (work, personal, clients) without modifying project directories.

### Key Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `ProfileManager` | `src/profile/manager.ts` | Static factory for profile CRUD operations |
| `profile/paths.ts` | `src/profile/paths.ts` | Path constants and helpers for profile directories |
| `ConfigProvider` | `src/config/provider.ts` | Provides config from a single isolated scope |
| Profile commands | `src/commands/profile/` | list, add, remove, show, config |
| Config commands | `src/commands/config/` | show, edit |
| OpenCode commands | `src/commands/opencode/` | Launch OpenCode with profile config |
| Init commands | `src/commands/init/` | Initialize global/local configs |
| Ghost commands | `src/commands/ghost/` | [TEMPORARY] Migration utilities |

### Directory Structure

```
~/.config/opencode/
├── ocx.jsonc                 # Global base config
└── profiles/
    ├── default/
    │   ├── ocx.jsonc         # Profile OCX settings
    │   ├── opencode.jsonc    # Profile OpenCode config
    │   └── AGENTS.md         # Profile instructions
    └── work/
        ├── ocx.jsonc
        ├── opencode.jsonc
        └── AGENTS.md

.opencode/                    # Local config (no profiles)
├── ocx.jsonc
└── opencode.jsonc
```

### Profile Resolution Priority

Profiles are resolved in this order:

1. `--profile <name>` / `-p <name>` flag (explicit override)
2. `OCX_PROFILE` environment variable
3. `default` profile (if it exists)
4. No profile (base configs only)

### Configuration Isolation

OCX configs (`ocx.jsonc`) are **ISOLATED per scope** - they do NOT merge.

**Registry Isolation (Security Model):**
- **Global registries** (in `~/.config/opencode/ocx.jsonc`) - ONLY used for downloading global settings like profiles
- **Profile registries** (in profile's `ocx.jsonc`) - ONLY available when using that profile
- **Local registries** (in `.opencode/ocx.jsonc`) - ONLY for that project

This prevents global registries from injecting components into all projects.

**What DOES merge:**
- OpenCode config files (`opencode.jsonc`) merge: profile → local (if not excluded by patterns)
- Profile's exclude/include patterns control which project files OpenCode can see

### How `ocx opencode` Works

1. **Profile resolution**: Uses priority order (flag > env var > default > none)
2. **Config isolation**: Uses registries from ACTIVE SCOPE ONLY (profile or local, not both)
3. **Instruction file discovery**:
   - Walks UP from project directory to git root
   - Finds AGENTS.md, CLAUDE.md, CONTEXT.md at each level
   - Filters by `exclude`/`include` patterns from profile's `ocx.jsonc`
   - Include patterns override exclude patterns (TypeScript/Vite style)
4. **Window naming** (optional): Sets terminal/tmux window name to `[profile]:repo/branch` for session identification
5. **Spawn OpenCode**: Launches OpenCode with isolated OCX registries and merged OpenCode settings, plus discovered instructions
6. **Working directory**: OpenCode runs directly in the project directory

### Instruction File Discovery

By default, all project instruction files are excluded so only your profile's files are used.

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
  "exclude": ["**/CLAUDE.md", "**/CONTEXT.md", "**/.opencode/**", "**/opencode.jsonc", "**/opencode.json"],
  
  // Or exclude all but include specific ones (TypeScript/Vite style)
  "exclude": ["**/AGENTS.md"],
  "include": ["./docs/AGENTS.md"]
}
```

Files are discovered deepest-first and profile instructions come last (highest priority).

### Custom OpenCode Binary

To use a custom OpenCode binary (e.g., a development build), set the `bin` option in your profile's `ocx.jsonc`:

```jsonc
{
  "bin": "/path/to/custom/opencode"
}
```

**Resolution order:**
1. `bin` in profile's `ocx.jsonc`
2. `OPENCODE_BIN` environment variable
3. `opencode` (system PATH)

### Profile Management

Use profile commands to manage multiple configurations:

#### Profile Commands

| Command | Alias | Description |
|---------|-------|-------------|
| `ocx profile list` | `ocx p ls` | List all global profiles |
| `ocx profile add <name>` | `ocx p add` | Create new profile or install from registry |
| `ocx profile remove <name>` | `ocx p rm` | Delete profile |
| `ocx profile show <name>` | `ocx p show` | Display profile contents |

#### Config Commands

| Command | Alias | Description |
|---------|-------|-------------|
| `ocx config show` | - | Show config from current scope |
| `ocx config show --origin` | - | Show config with sources |
| `ocx config edit` | - | Edit local config |
| `ocx config edit --global` | - | Edit global config |

#### OpenCode Commands

| Command | Alias | Description |
|---------|-------|-------------|
| `ocx opencode [path]` | `ocx oc` | Launch OpenCode with config |
| `ocx opencode -p <name>` | `ocx oc -p` | Launch with specific profile |

#### Init Commands

| Command | Alias | Description |
|---------|-------|-------------|
| `ocx init` | - | Initialize local .opencode/ |
| `ocx init --global` | - | Initialize global profiles |

#### Ghost Commands (TEMPORARY)

| Command | Alias | Description |
|---------|-------|-------------|
| `ocx ghost migrate` | - | Migrate ghost.jsonc to ocx.jsonc in profiles |
| `ocx ghost migrate --dry-run` | - | Preview migration without making changes |

**Note:** The ghost command group is temporary and will be removed in the next minor version. It helps users migrate from the legacy "ghost mode" configuration format (`ghost.jsonc`) to the unified profile system (`ocx.jsonc`).

#### Self Commands

| Command | Description |
|---------|-------------|
| `ocx self uninstall` | Remove OCX config and binary |
| `ocx self uninstall --dry-run` | Preview what would be removed |

**What gets removed by `self uninstall`:**
- `~/.config/opencode/profiles/` - All profiles
- `~/.config/opencode/ocx.jsonc` - Global OCX config
- `~/.config/opencode/` - Root directory (only if empty after cleanup)
- Binary executable (for curl installs only; package-managed prints command)

**Exit Codes:**
- `0` - Success (all items removed, already missing, or dry-run)
- `1` - Error (package-managed install detected, permission denied)
- `2` - Safety error (containment violation, root is symlink)

**Safety:**
- Only removes OCX-managed files (allowlist approach)
- Unexpected files in root directory are left untouched
- Symlinks are unlinked, not followed
- Root directory only deleted if empty after cleanup
- Package-managed installs print removal command instead of deleting

#### Command Examples

```bash
# Initialize global profiles
ocx init --global

# Create and use a work profile
ocx profile add work
ocx config edit -p work  # Edit profile settings

# Install profile from registry (requires global registry config)
ocx registry add https://registry.kdco.dev --name kdco --global
ocx profile add minimal --from kdco/minimal

# Force overwrite existing profile
ocx profile add minimal --from kdco/minimal --force

# Launch OpenCode with a specific profile
ocx opencode -p work

# Or use environment variable
OCX_PROFILE=work ocx opencode

# Clone settings from existing profile
ocx profile add client-x --from work

# View configuration from current scope
ocx config show
ocx config show --origin  # See where each setting comes from

# Initialize local config in project
ocx init
ocx config edit  # Edit local config
```

## Quick Reference

```bash
# Development workflow
bun install            # Install dependencies
bun run build          # Build all
bun run check          # Verify code quality
bun run test           # Run tests
bun run format         # Fix formatting

# Single test
bun test packages/cli/tests/add.test.ts
```

## Schema Synchronization

OCX schemas mirror OpenCode's configuration format. To update schemas when OpenCode releases new config options:

### Reference Sources

- **Official JSON Schema:** https://opencode.ai/config.json
- **Source Code:** https://github.com/sst/opencode/blob/dev/packages/opencode/src/config/config.ts

### Sync Process

1. Check the OpenCode changelog or config.ts for new fields
2. Update `packages/cli/src/schemas/registry.ts` with new Zod schemas
3. Follow existing patterns (JSDoc comments, `.passthrough()` for objects)
4. Run `bun run check` and `bun run test` to verify
5. Update this document with sync date

### Last Synced

- **Date:** 2026-01-05
- **OpenCode Version:** Latest (dev branch)

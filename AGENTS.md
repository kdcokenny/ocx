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
      ghost/           # Ghost mode commands (init, config, add, opencode, etc.)
    config/            # Config providers (Local, Ghost)
    ghost/             # Ghost mode configuration utilities
    registry/          # Registry fetching/resolution
    schemas/           # Zod schemas and config parsing
    utils/             # Shared utilities, errors, logging
  tests/               # Test files (*.test.ts)

registry/              # Component registry source files
  src/kdco/            # KDCO registry components

workers/               # Cloudflare Workers
  ocx/                 # Main OCX worker
  registry/            # Registry API worker
```

## Ghost Mode Architecture

Ghost mode enables working in repositories without modifying them:

### Key Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `ProfileManager` | `src/profile/manager.ts` | Static factory for profile CRUD operations |
| `profile/paths.ts` | `src/profile/paths.ts` | Path constants and helpers for profile directories |
| `profile/migrate.ts` | `src/profile/migrate.ts` | Migration from legacy `~/.config/ocx/` to profiles |
| `GhostConfigProvider` | `src/config/provider.ts` | Provides config from current profile |
| `opencode-discovery.ts` | `src/utils/` | Finds OpenCode config files to exclude |
| `symlink-farm.ts` | `src/utils/` | Creates temp dir with symlinks |
| Ghost commands | `src/commands/ghost/` | init, config, registry, add, search, opencode |
| Profile commands | `src/commands/ghost/profile/` | list, add, remove, use, show, config |

### Directory Structure

```
~/.config/opencode/profiles/
├── current -> default       # Symlink to active profile
├── default/
│   ├── ghost.jsonc          # Ghost mode settings
│   ├── opencode.jsonc       # OpenCode config (optional)
│   └── AGENTS.md            # Agent instructions (optional)
└── work/
    ├── ghost.jsonc
    ├── opencode.jsonc
    └── AGENTS.md
```

### Profile Resolution Priority

`ProfileManager.getCurrent()` resolves the active profile in this order:

1. `--profile <name>` flag (explicit override)
2. `OCX_PROFILE` environment variable
3. `current` symlink in `~/.config/opencode/profiles/`
4. `default` profile (fallback)

### How `ghost opencode` Works

1. Resolves current profile using priority above
2. Discovers all OpenCode project files (config, AGENTS.md, .opencode/)
3. Applies `include`/`exclude` patterns from profile's ghost.jsonc to customize visibility
4. Creates temp directory with symlinks to project (excluding filtered files)
5. Sets `GIT_WORK_TREE` and `GIT_DIR` so Git sees real project
6. Sets terminal/tmux window name to `ghost[profile]:repo/branch` for session identification
7. Spawns OpenCode from temp dir with `OCX_PROFILE` env var set
8. Cleans up temp dir on exit

**Customization:** The `include`/`exclude` fields in `ghost.jsonc` control which OpenCode files
are visible. Follows TypeScript-style semantics—`include` selects, `exclude` filters.

### GhostConfigProvider vs ProfileManager

- **`GhostConfigProvider`**: Reads config from the current profile, used at runtime by ghost commands
- **`ProfileManager`**: Manages profile lifecycle (create, delete, switch, list)

### OpenCode Discovery Reference

The discovery logic in `opencode-discovery.ts` mirrors OpenCode's scanning:

- **Config files:** `opencode.jsonc`, `opencode.json`
- **Rule files:** `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`
- **Config dirs:** `.opencode/`

Reference: https://github.com/sst/opencode (see source comments for exact file locations)

### Ghost Mode Profiles

Profile commands for managing multiple ghost configurations:

#### Profile Commands

| Command | Alias | Description |
|---------|-------|-------------|
| `ocx ghost profile list` | `ocx g p ls` | List all profiles (* = current) |
| `ocx ghost profile add <name>` | `ocx g p add` | Create new profile |
| `ocx ghost profile remove <name>` | `ocx g p rm` | Delete profile |
| `ocx ghost profile use <name>` | `ocx g p use` | Set current profile |
| `ocx ghost profile show [name]` | `ocx g p show` | Display profile contents |
| `ocx ghost profile config [name]` | `ocx g p config` | Edit ghost.jsonc in $EDITOR |

#### Profile Command Examples

```bash
# Create and switch to a work profile
ocx ghost profile add work
ocx ghost profile use work

# Run OpenCode with a specific profile
ocx ghost opencode --profile work

# Or use environment variable
OCX_PROFILE=work ocx ghost opencode

# Clone settings from existing profile
ocx ghost profile add client-x --from work

# List all profiles
ocx ghost profile list
```

#### Migration from Legacy Config

If you have an existing `~/.config/ocx/` configuration:

```bash
ocx ghost migrate --dry-run  # Preview changes
ocx ghost migrate            # Perform migration
```

This moves your config to `profiles/default/` and renames the old directory to `~/.config/ocx.bak/`.

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

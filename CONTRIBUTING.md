# Contributing to OCX

Thank you for your interest in contributing to OCX (OpenCode Extensions)!

## Creating a Registry

OCX uses a "copy-and-own" philosophy. Components are built from source into a versioned registry format.

### 1. Registry Structure

Create a directory for your registry source:

```
my-registry/
├── registry.jsonc      # Required: metadata and component definitions
└── files/              # Component source files
    ├── agent/          # .md files
    ├── skill/          # Directories with SKILL.md
    └── plugin/         # .ts files (can have sub-directories)
```

### 2. Registry Manifest (registry.jsonc)

Your `registry.jsonc` defines a namespace for all components:

```json
{
  "name": "My Registry",
  "namespace": "my",
  "version": "1.0.0",
  "author": "your-name",
  "components": [
    {
      "name": "component",
      "type": "ocx:plugin",
      "description": "What it does",
      "files": [
        {
          "path": "plugin/my-plugin.ts",
          "target": ".opencode/plugin/component.ts"
        }
      ],
      "dependencies": []
    }
  ]
}
```

**Note:** Component names are clean (no prefix). The namespace is used for CLI references: `ocx add my/component`

### 3. Building the Registry

Use the OCX CLI to validate and build your registry:

```bash
ocx build ./my-registry --out ./dist
```

The build command enforces:
- Valid namespace identifier
- Valid semver
- Valid OpenCode target paths

## Development

### Setup

```bash
git clone https://github.com/kdcokenny/ocx
cd ocx
bun install
```

### Building the CLI

```bash
cd packages/cli
bun run scripts/build.ts         # Build JS
bun run scripts/build-binary.ts  # Build standalone binaries
```

### Running Tests

```bash
cd packages/cli
bun test
```

### Registry Tests

```bash
# Run registry plugin tests
bun test workers/kdco-registry/tests/
```

### Testing the Update Command

```bash
# Run update command tests
bun test packages/cli/tests/update.test.ts

# Run with pattern matching
bun test --grep "update"

# Run all CLI tests
bun test packages/cli/tests/
```

Key test scenarios:
- Basic update with hash change
- `--all` flag updates all components
- `--registry` flag scopes to registry
- `--dry-run` previews without changes
- `@version` syntax pins to specific version
- Error cases (conflicts, missing components)

### Local Testing (End-to-End)

Before pushing changes, test the full CLI flow using local registry sources.

**Important notes:**
- The registry must be **built** before testing (source `registry.jsonc` → built `index.json`)
- Use **absolute paths** with `file://` URLs (use `$(pwd)` to expand)

```bash
# 1. Clean slate - wipe generated files (preserves .opencode/worktrees/)
rm -f opencode.jsonc ocx.lock ocx.jsonc
find .opencode -mindepth 1 -maxdepth 1 ! -name 'worktrees' -exec rm -rf {} + 2>/dev/null || true

# 2. Rebuild the CLI
cd packages/cli && bun run build && cd ../..

# 3. Build the local registry
./packages/cli/dist/index.js build workers/kdco-registry --out workers/kdco-registry/dist

# 4. Initialize fresh project
./packages/cli/dist/index.js init

# 5. Add local registry (MUST use absolute path with file://)
./packages/cli/dist/index.js registry add "file://$(pwd)/workers/kdco-registry/dist" --name kdco

# 6. Install components (using namespace/component syntax)
./packages/cli/dist/index.js add kdco/workspace --force

# 7. Verify the result
cat opencode.jsonc
```

#### Expected Output

After installation, `opencode.jsonc` should contain the component's `opencode` block merged in:
- `mcp` section with MCP server definitions
- `plugin` array with npm packages
- `tools` section with tool configurations
- `agent` section with per-agent settings

Example structure:
```json
{
  "mcp": { "context7": { ... }, "gh_grep": { ... }, "exa": { ... } },
  "plugin": ["@tarquinen/opencode-dcp@1.1.2"],
  "tools": { "webfetch": false },
  "agent": { "scribe": { "tools": { "bash": true, ... } } }
}
```

**Note:** OCX follows the ShadCN model - component config is deep-merged directly into your `opencode.jsonc`. You own the file, use git to review changes.

#### Quick Reset Script

For repeated testing (assumes registry is already built):

> **Note:** `.opencode/worktrees/` contains git worktrees and must be preserved.
> The cleanup command below removes OCX-managed contents while keeping worktrees intact.

```bash
rm -f opencode.jsonc ocx.lock ocx.jsonc && \
find .opencode -mindepth 1 -maxdepth 1 ! -name 'worktrees' -exec rm -rf {} + 2>/dev/null; \
./packages/cli/dist/index.js init && \
./packages/cli/dist/index.js registry add "file://$(pwd)/workers/kdco-registry/dist" --name kdco && \
./packages/cli/dist/index.js add kdco/workspace --force && \
cat opencode.jsonc
```

## Code Philosophy

OCX follows the **5 Laws of Elegant Defense**:
1. **Early Exit**: Guard clauses at the top.
2. **Parse, Don't Validate**: Use Zod at boundaries.
3. **Atomic Predictability**: Pure functions, immutable returns.
4. **Fail Fast, Fail Loud**: Throw clear errors immediately.
5. **Intentional Naming**: Logic should read like a sentence.

## Questions?

Open an issue or start a discussion!

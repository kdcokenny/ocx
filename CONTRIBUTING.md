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

### Profile Mode Testing (Preferred for Manual/AI Testing)

Profile mode provides isolated testing without affecting your local files or configuration.
Use the `ocx-dev` profile to keep testing completely separate.

#### Setup ocx-dev Profile (One-time)

```bash
# Create the ocx-dev profile
./packages/cli/dist/index.js profile add ocx-dev

# Profile is automatically available for use
```

#### Quick Feature Testing

```bash
# Build CLI first
cd packages/cli && bun run build && cd ../..

# Test with opencode run using the profile
./packages/cli/dist/index.js opencode -p ocx-dev
```

#### Verification Tests

Use these quick checks to verify profile mode is working correctly:

| Test | Command | Expected |
|------|---------|----------|
| **AGENTS.md excluded** | `opencode -p ocx-dev` then ask "What does the AGENTS.md say?" | Should see profile's AGENTS.md, not project's |
| **AGENTS.md included** | `opencode -p ocx-dev` (with `include: ["AGENTS.md"]` in ocx.jsonc) | Should see project's AGENTS.md |
| **Plugins visible** | `opencode -p ocx-dev` then ask "What plugins are available?" | Should list profile's configured plugins |
| **Skills visible** | `opencode -p ocx-dev` then ask "What skills do you have?" | Should list profile's skills |
| **MCP servers** | `opencode -p ocx-dev` then ask "What MCP servers are configured?" | Should list profile's MCP servers |
| **Gitignore respected** | `opencode -p ocx-dev` then ask "Create debug.log" (if *.log gitignored) | File should NOT appear in project |

#### Troubleshooting

| Symptom | Likely Cause |
|---------|--------------|
| AI sees project's AGENTS.md instead of profile's | `include` pattern is overriding exclusion |
| AI doesn't see expected plugins | Profile's `opencode.jsonc` not configured |
| New files not appearing in project | File matches `.gitignore` pattern |
| AI sees files that should be hidden | Check `exclude` patterns in `ocx.jsonc` |

#### Why Profile Mode for Testing?

- **Isolated**: Uses `ocx-dev` profile, separate from your default config
- **Safe**: Won't affect your working files or git state

#### For AI Agents

When testing OCX features, **always use profile mode** with the `ocx-dev` profile.
This prevents accidental modifications to the repository and provides clean isolation.

#### Using a Custom OpenCode Binary

The recommended way is to set `bin` in your profile's `ocx.jsonc`:

```jsonc
{
  "bin": "./path/to/local/opencode"
}
```

Alternatively, use the environment variable:

```bash
OPENCODE_BIN=./path/to/opencode ocx opencode -p ocx-dev
```

This is useful for:
- Testing with unreleased OpenCode features
- Using a custom OpenCode fork
- Development and debugging

#### Global Config Awareness

When testing Profile Mode, be aware of the global OpenCode config at `~/.config/opencode/opencode.jsonc`.
This config applies to ALL profiles and may include:
- Model/provider settings
- Agent model assignments  
- MCP servers that apply globally

**For AI Agents**: Always check this file if you see unexpected behavior. Note that OpenCode's global config is separate from OCX's profile system — OpenCode merges its own global config automatically, while OCX's profile registries are isolated per scope.

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

> **Note:** For quick manual testing or AI-driven testing, prefer Profile Mode Testing above.
> The section below is for comprehensive integration testing of the full CLI flow.

### Local Testing (End-to-End)

Before pushing changes, test the full CLI flow using local registry sources.

**Important notes:**
- The registry must be **built** before testing (source `registry.jsonc` → built `index.json`)
- Use **absolute paths** with `file://` URLs (use `$(pwd)` to expand)

```bash
# 1. Clean slate - wipe generated files
rm -rf .opencode

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

After installation, `.opencode/opencode.jsonc` should contain the component's `opencode` block merged in:
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

**Note:** OCX follows the ShadCN model - component config is deep-merged directly into your `.opencode/opencode.jsonc`. You own the file, use git to review changes.

#### Quick Reset Script

For repeated testing (assumes registry is already built):

```bash
rm -rf .opencode && \
./packages/cli/dist/index.js init && \
./packages/cli/dist/index.js registry add "file://$(pwd)/workers/kdco-registry/dist" --name kdco && \
./packages/cli/dist/index.js add kdco/workspace --force && \
cat .opencode/opencode.jsonc
```

## Code Philosophy

OCX follows the **5 Laws of Elegant Defense**:
1. **Early Exit**: Guard clauses at the top.
2. **Parse, Don't Validate**: Use Zod at boundaries.
3. **Atomic Predictability**: Pure functions, immutable returns.
4. **Fail Fast, Fail Loud**: Throw clear errors immediately.
5. **Intentional Naming**: Logic should read like a sentence.

## Changelog Preview (Optional)

To preview changelog locally, install git-cliff:

```bash
# macOS
brew install git-cliff

# Cargo
cargo install git-cliff

# Other: https://git-cliff.org/docs/installation
```

Then run:
```bash
# Preview unreleased changes
git cliff --unreleased --strip all

# Preview what the next release notes would look like (replace vX.Y.Z with your version)
git cliff --tag vX.Y.Z --strip all
```

Note: git-cliff is not required for development. It runs automatically in CI when creating releases.

## Questions?

Open an issue or start a discussion!

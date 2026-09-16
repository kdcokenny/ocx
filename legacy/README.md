# OpenCode V1 support

**OCX 2.0.15 is the frozen client for OpenCode V1.** OCX 3 supports OpenCode V2 and stores its profiles separately. Existing V1 registry URLs, schema URLs, tags, and published packages remain available.

## Keep using V1

Install the pinned legacy client with either package manager. The npm CLI also needs Bun:

```sh
bun add --global ocx@2.0.15
# Or:
npm install --global ocx@2.0.15
```

Keep an OpenCode V1 executable available. The two OpenCode major versions normally share the `opencode` command name, so saving profile files alone is not enough for rollback.

For an existing setup, continue using its legacy profiles and registry sources. For a new legacy workspace profile:

```sh
bunx ocx@2.0.15 init --global
bunx ocx@2.0.15 profile add ws --source kit/ws \
  --from https://ocx-kit.kdco.dev --global
bunx ocx@2.0.15 oc -p ws
```

The archived plugins are V1 implementations. They are not maintained as V2-compatible plugins, and external model or package availability can change independently of the frozen registry files.

## Documentation

The complete V1 website manual remains in `docs/` and in the **Legacy: OpenCode V1** navigation group:

- [Installation](../docs/getting-started/installation.mdx) and [quick start](../docs/getting-started/quick-start.mdx).
- [Profiles and configuration](../docs/profiles/overview.mdx).
- [Workspace](../docs/profiles/ws.mdx) and [OMO](../docs/profiles/omo.mdx) profiles.
- [CLI reference](../docs/cli/commands.mdx).
- [Registry authoring](../docs/registries/create.mdx) and [legacy protocol](../docs/registries/protocol.mdx).
- [Plugin integration guides](../docs/integrations/workspace.mdx).

The [readable documentation archive](docs/README.md) preserves all 13 Markdown agent, command, skill, and profile documents removed from the active catalog. Their original bodies remain available for inspecting an existing setup or manually migrating useful guidance.

Historical contributor guides remain available at the freeze commit:

- [Registry starter README](https://github.com/kdcokenny/ocx/blob/e79df6f/examples/registry-starter/README.md) and [full authoring instructions](https://github.com/kdcokenny/ocx/blob/e79df6f/examples/registry-starter/AGENTS.md).
- [KDCO registry README and researcher setup](https://github.com/kdcokenny/ocx/blob/e79df6f/workers/kdco-registry/README.md).
- [OCX Kit authoring instructions](https://github.com/kdcokenny/ocx/blob/e79df6f/workers/ocx-kit/AGENTS.md).

## Frozen artifacts

These archives were built from source commit `e79df6f`, whose CLI version was `2.0.15`:

| Archive | Files | Served at |
| --- | --- | --- |
| `kdco-registry.tar.gz` | 52 | `https://registry.kdco.dev` |
| `ocx-kit.tar.gz` | 9 | `https://ocx-kit.kdco.dev` |

[`manifest.json`](manifest.json) records source provenance, each archive's SHA-256 hash, and every extracted file hash. Worker builds verify the archive, its exact path list, and individual bytes before publishing output. V1 plugin code is not rebuilt with OCX 3.

To inspect the contents without changing your setup, run from the repository root:

```sh
tar -tzf legacy/kdco-registry.tar.gz
tar -tzf legacy/ocx-kit.tar.gz
```

To restore the verified outputs using the supported build path:

```sh
bun install --frozen-lockfile
bun run --cwd packages/cli build
bun run --cwd workers/kdco-registry build
bun run --cwd workers/ocx-kit build
```

The KDCO build also places the new V2 catalog under `dist/opencode-v2/`. The root remains the frozen V1 registry. See the [KDCO worker guide](../workers/kdco-registry/README.md) and [OCX Kit worker guide](../workers/ocx-kit/README.md) for local serving, deployment, and compatibility checks.

If a checksum fails, restore the committed archive rather than changing expected hashes. Do not generate a replacement archive with OCX 3 or republish protocol 3 at a legacy root URL.

## Move to V2 when ready

Use OCX 3's [migration preview](../docs/v2/migration.mdx) to create a separate profile under `~/.config/ocx/profiles/`. It leaves the legacy files under `~/.config/opencode/profiles/` intact and reports plugin, instruction, and filtering decisions before applying changes.

Retain your V1 executable and originals until the behavior you need has been checked in V2. Avoid pointing V1 at native V2-only configuration. The [retirement guide](../docs/v2/retirement.mdx) explains which native workflows replace the maintained plugins and which custom behavior was dropped.

New OCX major releases remain on the preview channel until the legacy updater and installer paths have been reviewed; old binaries cannot retroactively understand a new channel. No package, tag, or release is unpublished as part of this migration.

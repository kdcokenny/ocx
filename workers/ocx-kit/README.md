# OCX Kit

The frozen OpenCode V1 profile registry at `https://ocx-kit.kdco.dev`.

This worker keeps existing profile installation URLs available for **OCX 2.0.15 and OpenCode V1**. It restores verified built assets from [`legacy/ocx-kit.tar.gz`](../../legacy/README.md). New OpenCode V2 profile recipes belong in the [KDCO V2 catalog](../kdco-registry/README.md).

## Available profiles

| Profile | Purpose | Documentation |
| --- | --- | --- |
| `kit/ws` | KDCO workspace agents, planning, and background-agent harness. | [Workspace guide](../../docs/profiles/ws.mdx), [original profile notes](../../legacy/docs/profiles/ws/README.md) |
| `kit/omo` | Starter configuration for oh-my-openagent. | [OMO guide](../../docs/profiles/omo.mdx), [original profile notes](../../legacy/docs/profiles/omo/README.md) |

Profile instructions and model choices are frozen historical defaults. Provider availability and external npm packages can change independently of these static files.

## Install with the legacy client

Keep an OpenCode V1 executable available. From a V1 environment:

```sh
bunx ocx@2.0.15 init --global
bunx ocx@2.0.15 profile add ws --source kit/ws \
  --from https://ocx-kit.kdco.dev --global
bunx ocx@2.0.15 oc -p ws
```

Replace `ws` and `kit/ws` with `omo` and `kit/omo` for the OMO profile. To customize an existing profile, clone it with the legacy CLI and edit its files under `~/.config/opencode/profiles/`:

```sh
bunx ocx@2.0.15 profile add my-ws --clone ws --global
```

Do not point the V1 runtime at a profile converted to native V2-only configuration. For migration, use the [preview-first OCX 3 importer](../../docs/v2/migration.mdx) to create a separate profile.

## Build and develop

Run from the monorepo root with Bun and `tar` available:

```sh
bun install --frozen-lockfile
bun run --cwd workers/ocx-kit build
bun run --cwd workers/ocx-kit dev
```

Wrangler prints a local URL, normally `http://localhost:8787`. Test it with the pinned legacy CLI in an isolated environment:

```sh
bunx ocx@2.0.15 profile add kit-test --source kit/ws \
  --from http://localhost:8787 --global
```

The build verifies the archive hash, its exact file list, and every extracted file hash before replacing `dist/`. It does not rebuild legacy source with OCX 3.

## Project structure

```text
workers/ocx-kit/
├── scripts/build.ts       # Restore the verified legacy archive
├── wrangler.jsonc         # Static asset worker configuration
├── AGENTS.md              # Maintenance and compatibility instructions
└── dist/                  # Generated V1 index, manifests, and profile files

legacy/
├── ocx-kit.tar.gz         # Frozen built registry
├── manifest.json          # Source commit and per-file/archive SHA-256 hashes
└── restore.ts             # Shared checked restoration
```

Historical `registry.jsonc` and profile source remain at [commit `e79df6f`](https://github.com/kdcokenny/ocx/tree/e79df6f/workers/ocx-kit). They are not the worker's active build inputs.

## Deploy and maintain

```sh
bun run --cwd workers/ocx-kit check
bun run --cwd workers/ocx-kit deploy
```

A normal deployment republishes the same frozen bytes. Preserve the hostname and all asset paths, including `/.well-known/ocx.json`. Compare deployed files with `legacy/manifest.json` and exercise both profile recipes with OCX 2.0.15 before promoting infrastructure changes.

If archive verification fails, stop and check the committed artifact. Do not regenerate the manifest to accept a damaged archive. If publication was interrupted, retain the recovery journal and previous output, then rerun the build.

See [maintainer guidance](AGENTS.md) for the full verification workflow and [legacy preservation](../../legacy/README.md) for provenance and recovery.

# OCX Kit maintenance

This worker serves the **frozen OpenCode V1 preset registry**. Preserve its URLs and bytes for OCX 2.0.15 users. The [README](README.md) covers profile installation; the [legacy manifest](../../legacy/manifest.json) defines the expected artifacts.

## Scope

The worker is maintained for hosting and compatibility, not for new runtime features. New V2 profiles belong in `workers/kdco-registry/catalog/`. Do not reintroduce V1 plugin hooks, config merging, npm dependency orchestration, or profile generation here.

A source-only infrastructure change can still break a legacy client by moving paths, returning an HTML fallback for JSON, dropping dot-directories, or changing caching behavior. Verify the served artifacts after such changes.

## Build inputs

| Path | Role |
| --- | --- |
| `scripts/build.ts` | Invokes the checked restoration helper. |
| `../../legacy/ocx-kit.tar.gz` | Immutable built V1 registry. |
| `../../legacy/manifest.json` | Provenance, exact file set, archive hash, and file hashes. |
| `../../legacy/restore.ts` | Verifies and stages the archive before publishing output. |
| `wrangler.jsonc` | Serves `dist/` as static assets. |
| `dist/` | Generated output; never edit directly. |

The original registry and profile sources remain at commit `e79df6f`. Readable profile notes are preserved in `legacy/docs/profiles/`. Treat old model/provider recommendations as historical.

## Local workflow

Run from the monorepo root:

```sh
bun install --frozen-lockfile
bun run --cwd workers/ocx-kit build
bun run --cwd workers/ocx-kit check
bun run --cwd workers/ocx-kit dev
```

Bun and `tar` are required. Wrangler prints its local base URL. The restore step verifies all nine archived files before publishing the destination directory. A checksum or unexpected-path error must fail the build.

Do not use `ocx build` on the extracted registry. Protocol 3 is intentionally incompatible with the old manifest's config patches and runtime package dependencies. Rebuilding would change the contract being preserved.

## Compatibility checks

1. Build from a clean checkout or inspect a freshly generated `dist/`.
2. Compare every output file with the hash in `legacy/manifest.json`.
3. Request `/index.json`, `/.well-known/ocx.json`, `/components/ws.json`, and `/components/omo.json` from the local worker.
4. Request each profile asset referenced by those manifests and check that it is served as the original bytes.
5. With a disposable legacy configuration directory, install both recipes using OCX 2.0.15. Check dependency fetches from the frozen KDCO registry as well.
6. Repeat the checks against the candidate deployment before promoting it.

Use the existing [V1 conformance probe](../../packages/cli/scripts/conformance/legacy.ts) and [release validation record](../../docs/maintainers/opencode-v2-validation.md) for the tested setup. Do not run legacy installation tests against a maintainer's real profiles.

## Deployment

With Cloudflare credentials available, run from the repository root:

```sh
bun run --cwd workers/ocx-kit deploy
```

Keep `ocx-kit.kdco.dev` and its component paths intact. Publish the complete generated output as one static deployment. A successful upload alone does not establish compatibility; verify the served files and a real legacy install.

## Recovery

- **Archive checksum mismatch:** compare the local archive with the committed artifact. Restore the known-good artifact; do not change expected hashes to silence the check.
- **Unexpected paths or extracted file mismatch:** retain the failed build evidence and inspect the archive/tooling. Do not deploy partial output.
- **Interrupted publication:** keep the journal and previous output directory. Rerun the build so the publisher can recover. If a lock owner cannot be determined, first confirm the process has stopped before removing only the reported stale lock.
- **Public deployment regression:** roll back the static deployment to its last verified version, then compare its full file set with the manifest.

See [the recovery guide](../../docs/v2/troubleshooting.mdx) for the shared publication mechanism. Changes to recovery code also affect V2 registry builds and need appropriate checks in both workers.

## Adding a new preset

Create a protocol-3 profile recipe in the KDCO V2 catalog instead of extending this frozen archive. A recipe owns complete native `opencode.json(c)`, `AGENTS.md`, optional `cli.json`, and OCX metadata files. Ordinary dependencies own skills, agents, or commands.

Follow the [registry authoring guide](../../examples/registry-starter/AGENTS.md). Use native OpenCode V2 configuration and document provider prerequisites. Never ship credentials or machine-specific state in a recipe.

## Historical references

- [Original OCX Kit authoring guide](https://github.com/kdcokenny/ocx/blob/e79df6f/workers/ocx-kit/AGENTS.md)
- [Workspace profile](../../legacy/docs/profiles/ws/README.md)
- [OMO profile](../../legacy/docs/profiles/omo/README.md)
- [Plugin retirement and native alternatives](../../docs/v2/retirement.mdx)

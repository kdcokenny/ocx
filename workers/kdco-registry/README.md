# KDCO Registry

Editable OpenCode components, served as static files by a Cloudflare Worker.

| Catalog | Client | Registry base URL |
| --- | --- | --- |
| OpenCode V2 | OCX 3 | `https://registry.kdco.dev/opencode-v2` after this branch is deployed |
| Frozen OpenCode V1 | OCX 2.0.15 | `https://registry.kdco.dev` |

The V2 catalog is maintained in [`catalog/`](catalog/registry.jsonc). The V1 catalog is restored byte-for-byte from a [verified archive](../../legacy/README.md). The two protocols have separate URLs.

## OpenCode V2 quick start

With the OCX 3 preview and OpenCode 2.0.3 or newer within V2 installed:

```sh
ocx registry add https://registry.kdco.dev/opencode-v2 --name kdco --global
ocx profile add work --source kdco/minimal
ocx verify --profile work
ocx oc --profile work
```

Before public deployment, use the local worker URL below or the PR's worker preview with `/opencode-v2` appended.

### Available V2 components

| Component | Type | Contents |
| --- | --- | --- |
| `kdco/minimal` | Profile | OCX metadata, native OpenCode config, working instructions, and the code-review skill. |
| `kdco/code-review` | Skill | Review methodology, severity guidance, evidence requirements, and reporting checklist. |

Install the skill into an existing profile:

```sh
ocx add kdco/code-review --from https://registry.kdco.dev/opencode-v2 --profile work
ocx update --all --profile work --dry-run
```

Or install into a project:

```sh
ocx init --project
ocx add kdco/code-review --from https://registry.kdco.dev/opencode-v2 --project
ocx verify --project
```

Do not add the skill separately when the minimal profile already installed it as a dependency. Global registry sources are used for profile creation and browsing; a profile's sources are configured separately.

## Build and develop

Run from the repository root. Bun and `tar` are required; Wrangler is a workspace dependency.

```sh
bun install --frozen-lockfile
bun run --cwd packages/cli build
bun run --cwd workers/kdco-registry build
bun run --cwd workers/kdco-registry dev
```

The worker normally runs at `http://localhost:8787`. Its V2 registry base is `http://localhost:8787/opencode-v2`:

```sh
bun packages/cli/dist/index.js profile add registry-test \
  --source kdco/minimal --from http://localhost:8787/opencode-v2
bun packages/cli/dist/index.js verify --profile registry-test
```

`dev` builds once before starting Wrangler. Rebuild after editing catalog files. The build restores and verifies the frozen root first, builds the V2 catalog in a staging directory, sets subpath-aware discovery metadata, and publishes the completed output.

## Project structure

```text
workers/kdco-registry/
├── catalog/
│   ├── registry.jsonc             # Active protocol-3 manifest
│   └── files/
│       ├── minimal/              # Complete profile config and instructions
│       └── skills/code-review/   # Native skill
├── scripts/build.ts              # Restore V1 + build V2 atomically
├── wrangler.jsonc                # Serve dist as static assets
└── dist/                         # Generated; do not edit
    ├── index.json                # Frozen V1 index
    ├── components/               # Frozen V1 manifests and files
    └── opencode-v2/               # New catalog, assets, and discovery metadata
```

## Add or update a V2 component

1. Create files under `catalog/files/` and list every published asset in `catalog/registry.jsonc`.
2. Use root-relative targets such as `skills/review/SKILL.md`, without `.opencode/`.
3. Reserve complete root configuration files for `type: "profile"` recipes. Ordinary components never patch native configuration or install npm dependencies.
4. Declare shared components as dependencies so only one component owns each file.
5. Validate, rebuild, and install from the local worker into a disposable destination.

```sh
bun packages/cli/dist/index.js validate workers/kdco-registry/catalog
bun run --cwd workers/kdco-registry build
bun run --cwd workers/kdco-registry check
```

Test an update from the previous component revision as well as a fresh install. Keep changes to the frozen archives out of normal catalog updates. See the [authoring guide](../../examples/registry-starter/AGENTS.md) and [protocol reference](../../docs/v2/registry-protocol.mdx).

## Deploy and verify

From the repository root, with Cloudflare credentials configured:

```sh
bun run --cwd workers/kdco-registry deploy
```

Deployments include both catalogs. Before promoting a deployment, check the root V1 index and files against `legacy/manifest.json`, then test a fresh OCX 3 installation from the deployed `/opencode-v2` path. The build itself checks the archive and every restored file hash.

An interrupted directory publication leaves a recovery journal beside the output. Rerun the build to recover; retain its previous-output directory until recovery succeeds. See [recovery guidance](../../docs/v2/troubleshooting.mdx).

## Frozen V1 components

The original root endpoint continues to serve these historical components:

| Group | Components |
| --- | --- |
| Workspace | `workspace`, `workspace-plugin`, `kdco-primitives` |
| Agents | `coder`, `researcher`, `reviewer`, `scribe` |
| Plugins | `background-agents`, `notify`, `worktree` |
| Skills | `code-philosophy`, `frontend-philosophy`, `code-review`, `plan-protocol`, `plan-review` |
| Other definitions | `review`, `philosophy` |

Use the frozen OCX client and an OpenCode V1 executable for them. For example, from a disposable legacy project:

```sh
bunx ocx@2.0.15 init
bunx ocx@2.0.15 add kdco/workspace --from https://registry.kdco.dev
```

The complete [old registry README](https://github.com/kdcokenny/ocx/blob/e79df6f/workers/kdco-registry/README.md) includes its original researcher/MCP setup instructions. The [readable V1 documentation archive](../../legacy/docs/README.md) preserves agent bodies, skills, commands, and profile notes. These documents describe the frozen V1 product; the new minimal profile does not install the former workspace harness.

## Further reading

- [Using file registries](../../docs/v2/registries.mdx)
- [Create your own registry](../../examples/registry-starter/README.md)
- [V1 import and plugin retirement](../../docs/v2/migration.mdx)
- [Native conformance and release validation](../../docs/maintainers/opencode-v2-validation.md)

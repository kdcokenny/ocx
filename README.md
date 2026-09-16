# OCX for OpenCode V2

Portable named profiles and editable file registries for OpenCode **2.0.3 or newer within V2**.

This branch develops **OCX 3**. OpenCode interprets the configuration and runs the agent; OCX selects a profile and manages files you own.

**Using OpenCode V1?** Keep `ocx@2.0.15`. Its registries and documentation are preserved. See [the legacy setup](legacy/README.md). OCX 3 uses separate profile directories and does not upgrade or replace OpenCode.

## Try the development preview

```sh
bun install --frozen-lockfile
bun run --cwd packages/cli build
bun packages/cli/dist/index.js profile add work
bun packages/cli/dist/index.js oc --profile work
```

Install OpenCode V2 separately. If you retain both native binaries, set `OPENCODE_BIN` to the V2 executable or set `bin` in the profile's `ocx.jsonc`. The launcher checks the executable version.

After an OCX 3 preview is published, `npm install -g ocx@next` installs that channel. The default npm/curl release remains OCX 2 for V1 users during the preview. This PR does not publish a release.

## Profiles first

Profiles live at `$XDG_CONFIG_HOME/ocx/profiles/<name>` (normally `~/.config/ocx/profiles/<name>`). Edit their ordinary `opencode.jsonc`, `AGENTS.md`, `cli.json`, `agents/`, `commands/`, and `skills/` files directly.

```sh
ocx profile add work
ocx profile add personal --clone work
ocx profile list
ocx profile use work
ocx oc
```

Launch selection is `--profile`, then `OCX_PROFILE`, then the explicit default set by `profile use`. A repository cannot choose your profile.

A profile's OCX metadata is small:

```json
{
  "$schema": "https://ocx.kdco.dev/schemas/v3/profile.json",
  "projectConfig": "ignore",
  "registries": {}
}
```

`ignore` disables native startup project configuration and definitions. `inherit` lets OpenCode load them normally. Native read-time discovery of nested `AGENTS.md` still applies in both modes, as it did in V1. Profiles share native credentials and session storage; they are not sandboxes.

## Files you own

Registry components copy files into an explicit profile or a project's `.opencode/`. OCX records hashes, protects local edits, resolves dependencies, and supports previews, verification, update, and removal.

```sh
ocx registry add https://registry.kdco.dev/opencode-v2 --name kdco --global
ocx profile add review --source kdco/minimal
ocx verify --profile review

ocx init --project
ocx add kdco/code-review --from https://registry.kdco.dev/opencode-v2 --project
ocx update --all --project --dry-run
```

The new catalog address becomes available when its worker is deployed. Its source is [the static catalog](workers/kdco-registry/catalog/registry.jsonc).

Components cannot patch native configuration or install npm dependencies. Profile recipes can own complete config files. Configure third-party V2 plugins through OpenCode itself.

## Migration and retirement

```sh
ocx migrate --from ~/.config/opencode/profiles/work --profile work
```

This previews a separate import. Review omissions and decisions before adding `--apply`; originals remain unchanged. V1 plugins and old per-file project filters need explicit migration decisions.

The maintained background-agents, notify, worktree, and workspace plugins are retired from the V2 product. Native V2 covers their broad use cases, but custom hooks, research archives, and planning conventions are not all equivalent. [Retirement details](docs/v2/retirement.mdx) explain what is lost and how legacy users continue.

[Profiles and discovery](docs/v2/profiles.mdx) · [CLI](docs/v2/cli.mdx) · [Registry protocol](docs/v2/registries.mdx) · [Migration](docs/v2/migration.mdx) · [Validation record](docs/maintainers/opencode-v2-validation.md)

## Development

```sh
bun run build
bun run check
bun run --cwd packages/cli test
OPENCODE_V2_BIN=/absolute/path/to/opencode-v2 bun run --cwd packages/cli test:native
```

Native conformance uses a local mock model, temporary XDG directories, and the built OCX launcher. It needs no paid model requests. See [the implementation plan](docs/plans/opencode-v2-slimdown.md).

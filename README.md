<div align="center">

# OCX

**Your OpenCode config, anywhere.**

Portable profiles and editable components for OpenCode.

[![CI](https://github.com/kdcokenny/ocx/actions/workflows/ci.yml/badge.svg)](https://github.com/kdcokenny/ocx/actions/workflows/ci.yml) [![OpenCode V2](https://img.shields.io/badge/OpenCode-V2-0D9373)](docs/v2/overview.mdx) [![License](https://img.shields.io/github/license/kdcokenny/ocx.svg)](LICENSE)

[Get started](#quick-start) · [Profiles](docs/v2/profiles.mdx) · [Registries](docs/v2/registries.mdx) · [CLI reference](docs/v2/cli.mdx)

</div>

---

- 📁 **Switch profiles.** Keep separate setups for work, personal projects, and code review.
- 📦 **Own your files.** Install agents, skills, and commands from registries, then edit them directly.
- 🔎 **Review your changes.** Preview updates, verify file hashes, and protect local edits.

> [!NOTE]
> **OpenCode V2 preview.** This branch is OCX 3, for OpenCode 2.0.3 or newer within V2. Using OpenCode V1? Keep `ocx@2.0.15` and follow the [legacy guide](legacy/README.md).

## Quick start

<details>
<summary>Set up the development preview</summary>

From a checkout of this branch, with Bun and OpenCode V2 installed:

```sh
bun install --frozen-lockfile
bun run --cwd packages/cli build
alias ocx="bun \"$PWD/packages/cli/dist/index.js\""
```

The alias uses this checkout's CLI for the current shell. See [preview setup](docs/v2/overview.mdx) for OpenCode installation and binary selection.

</details>

Create a profile, make it your default, and launch OpenCode:

```sh
ocx profile add work
ocx profile use work
ocx oc
```

Need a different setup for the next session?

```sh
ocx profile add personal --clone work
ocx oc -p personal
```

Each profile is an ordinary folder under `~/.config/ocx/profiles/` (or `$XDG_CONFIG_HOME/ocx/profiles/`). Edit its OpenCode config, instructions, agents, and skills directly. OpenCode loads them when you launch.

**[Profile setup and project discovery →](docs/v2/profiles.mdx)**

## Files you can make your own

Registry components are copied into a profile or your project's `.opencode/` directory. They stay editable, with an ownership record for updates and removal.

For a registry configured as `team`, installing its `review` component looks like this:

```sh
ocx init --project
ocx add team/review --project
ocx update --all --project --dry-run
ocx verify --project
```

Use `--profile work` to manage files in a profile instead.

**[Add a registry](docs/v2/registries.mdx#sources-and-ownership) · [Publish your own](docs/v2/registries.mdx#author-a-registry)**

## Moving from V1?

Preview an import into a new profile:

```sh
ocx migrate \
  --from ~/.config/opencode/profiles/work \
  --profile work
```

The importer shows what will change before you apply it. Your originals stay untouched. The [migration guide](docs/v2/migration.mdx) covers project filters, plugins, and other differences; [plugin retirement notes](docs/v2/retirement.mdx) cover native alternatives and the frozen V1 releases.

<details>
<summary><strong>Development</strong></summary>

Requires Bun. Build and check the workspace:

```sh
bun install --frozen-lockfile
bun run build
bun run check
bun run --cwd packages/cli test
```

Run the built CLI with `bun packages/cli/dist/index.js`. For native OpenCode conformance and manual testing details, see the [validation record](docs/maintainers/opencode-v2-validation.md).

</details>

---

[MIT](LICENSE) · An independent project, not affiliated with the OpenCode team.

# My Registry

A static registry of editable profiles, agents, skills, and commands for OpenCode V2. Built with [OCX](https://github.com/kdcokenny/ocx).

## Quick start

You need Bun, OCX 3, and OpenCode 2.0.3 or newer within V2 to test installations. The template's package scripts use `ocx@next` after preview publication. During development, use the CLI built from the OCX V2 branch as described below.

```sh
bun install
bun run build
bun run dev
```

Wrangler prints a local URL, normally `http://localhost:8787`. In another terminal, install the example into a disposable project:

```sh
mkdir registry-test
cd registry-test
ocx init --project
ocx add team/hello-world --from http://localhost:8787 --project --dry-run
ocx add team/hello-world --from http://localhost:8787 --project
ocx verify --project
```

The skill is now an ordinary file at `.opencode/skills/hello-world/SKILL.md`. OpenCode discovers it from the project when project configuration is enabled.

To install into a named profile instead:

```sh
ocx profile add registry-test
ocx add team/hello-world --from http://localhost:8787 --profile registry-test
ocx oc --profile registry-test
```

### Using a source checkout of OCX

Before `ocx@next` is published, build the OCX V2 branch and define an alias in your shell:

```sh
# Run from the OCX checkout.
bun install --frozen-lockfile
bun run --cwd packages/cli build
alias ocx="bun \"$PWD/packages/cli/dist/index.js\""
```

Then, from this registry's directory:

```sh
ocx validate .
ocx build . --out dist
bunx wrangler dev
```

The alias is available only in that shell. It is not inherited by `bun run build`, so use the explicit `ocx build` command while testing an unpublished CLI. Rebuild after changing registry files; Wrangler serves `dist/`.

## Project structure

```text
my-registry/
├── registry.jsonc                  # Catalog and component file mappings
├── files/
│   └── skills/hello-world/SKILL.md  # Example skill and its instructions
├── AGENTS.md                       # Authoring guide for contributors and agents
├── package.json                    # Build, development, and deploy scripts
├── wrangler.jsonc                  # Cloudflare static assets deployment
├── vercel.json                     # Alternative: Vercel
├── netlify.toml                    # Alternative: Netlify
└── dist/                           # Generated HTTP registry; do not edit
```

## Add a component

1. Create the files under `files/`. Put a skill's supporting scripts and references beside its `SKILL.md`.
2. Add an entry to `registry.jsonc`:

   ```json
   {
     "name": "review",
     "type": "skill",
     "description": "Review changes for correctness and regressions",
     "files": ["skills/review/SKILL.md"]
   }
   ```

3. Give the skill `name` and `description` frontmatter, followed by its Markdown instructions.
4. Run `ocx validate .` and `ocx build . --out dist`.
5. Install into a disposable project or profile and confirm OpenCode can use the definition.

File targets are relative to the chosen configuration directory. Use `skills/review/SKILL.md`, **without** an `.opencode/` prefix. Use an object such as `{ "path": "reviewer.md", "target": "agents/reviewer.md" }` when the source and installed paths differ.

The [authoring guide](AGENTS.md) includes complete skill, agent, command, bundle, and profile examples, dependency rules, and a release checklist.

## Configure a source once

An alias is local to the chosen scope. This example calls the registry `team`:

```sh
ocx registry add http://localhost:8787 --name team --profile registry-test
ocx search --profile registry-test
ocx add team/hello-world --profile registry-test
ocx update --all --profile registry-test --dry-run
```

`--from` is convenient for a single install; the receipt retains its origin for updates. Register cross-registry dependency aliases in the same scope before installing.

## Deploy

Publish the **complete contents of `dist/`**, including `.well-known/`, using a static host. Keep JSON and component assets at their generated paths; a single-page-app fallback must not turn missing files into HTML responses.

| Host | Setup | Publish |
| --- | --- | --- |
| Cloudflare Workers | Set `name` in `wrangler.jsonc`; authenticate with `bunx wrangler login`. | `bun run deploy` |
| Vercel | Import this repository; `vercel.json` selects the build command and `dist`. | Deploy through Vercel or `bunx vercel --prod`. |
| Netlify | Import this repository; `netlify.toml` selects the build command and `dist`. | Deploy through Netlify or `bunx netlify deploy --prod --dir dist` after building. |
| Other static host | Make Bun and OCX 3 available to the builder. | Run `ocx build . --out dist`, then upload `dist/`. |

During the unpublished preview, configure the host to use your tested OCX 3 build instead of the template's `bunx ocx@next` script. Do not publish protocol 3 over an existing legacy registry URL. Use a separate path or hostname for V2 clients.

After deployment, repeat the install and verification against the public URL in a fresh destination. Test dependent components as well as the catalog index.

## Troubleshooting

- **Protocol/schema error:** OCX 3 requires `https://ocx.kdco.dev/schemas/v3/registry.json`. V1 config patches and npm dependency fields need a real migration, not just a schema rename.
- **Missing file:** `files` paths in the manifest are relative to `files/`, not the repository root. Check spelling and case.
- **Unknown dependency alias:** configure its registry in the destination profile or project; global sources do not cascade into either.
- **Existing or edited files:** inspect the destination before retrying. `add` does not overwrite unrelated files. Use `update --dry-run` for an installed component.
- **Browser works but CLI fails:** check the exact `/index.json`, `/components/<name>.json`, and asset URLs. HTML fallbacks and omitted dot-directories can break static hosting.

## Documentation

- [Create a registry](https://ocx.kdco.dev/v2/registry-authoring)
- [Protocol 3 reference](https://ocx.kdco.dev/v2/registry-protocol)
- [Profiles](https://ocx.kdco.dev/v2/profiles)
- [CLI reference](https://ocx.kdco.dev/v2/cli)
- [OpenCode V2 documentation](https://opencode.ai/v2/docs)

OCX is MIT licensed. Choose and document a license for the components you distribute.

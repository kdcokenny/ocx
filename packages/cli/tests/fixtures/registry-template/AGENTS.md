# Registry author guidance

This project publishes **My Registry**, an OCX 3 file registry for OpenCode V2. Its source of truth is `registry.jsonc` plus `files/`; `dist/` is generated output. Read the [README](README.md) for setup and hosting commands.

## Working agreement

- Keep components small and independently useful. State what each definition does and when an agent should use it.
- Inspect neighboring files before adding conventions or dependencies.
- Parse manifests at the boundary, fail with an actionable message, and keep build output deterministic.
- Prefer early exits, explicit names, and small operations with predictable outcomes.
- Validate the complete registry, then test installation in a disposable destination before publishing.
- Preserve existing users' URLs. An OpenCode V1 registry belongs at a separate, frozen endpoint.

## Quick reference

Run these commands from this registry directory with OCX 3 available:

```sh
ocx validate .
ocx build . --out dist --dry-run
ocx build . --out dist
bunx wrangler dev
```

The package scripts use `bunx ocx@next` after preview publication. With an unpublished source build, use the explicit CLI commands above; shell aliases are not available inside package scripts.

## Registry structure

```text
registry.jsonc
files/
  agents/reviewer.md
  commands/review.md
  skills/review/
    SKILL.md
    references/checklist.md
  profiles/team/
    ocx.jsonc
    opencode.jsonc
    AGENTS.md
```

Every source file must appear explicitly in a component's `files` list. Merely placing a file under `files/` does not publish it. Copy a skill's supporting assets along with its `SKILL.md` so relative references keep working.

### Registry fields

| Field | Required | Meaning |
| --- | --- | --- |
| `$schema` | Yes | `https://ocx.kdco.dev/schemas/v3/registry.json` |
| `name` | Yes | Human-readable catalog name. |
| `version` | Yes | Semantic version; default revision for components without their own version. |
| `author` | Yes | Publisher or team name. |
| `components` | Yes | Component manifest array. |
| `opencode`, `ocx` | No | Intended minimum versions as semantic versions; descriptive metadata. |

Component manifests accept `name`, `type`, `description`, optional `version`, `files`, and `dependencies`. Names are lowercase letters/digits separated by single hyphens, with a maximum of 64 characters. Unknown fields are rejected. Use descriptions that explain an outcome rather than repeating the name.

OCX validates the protocol and checks the native executable at launch. The optional registry minimum-version fields do not implement an additional compatibility gate.

## File mappings and destinations

A string uses the same path below `files/` and the destination configuration root:

```json
"files": ["skills/review/SKILL.md"]
```

An object maps a source path to a different target:

```json
"files": [
  { "path": "profiles/team/AGENTS.md", "target": "AGENTS.md" }
]
```

| Destination | Target `skills/review/SKILL.md` becomes |
| --- | --- |
| `--profile work` | `$XDG_CONFIG_HOME/ocx/profiles/work/skills/review/SKILL.md` |
| `--project` | `<project>/.opencode/skills/review/SKILL.md` |

Do not prefix targets with `.opencode/`. Paths must be portable, relative file paths with no traversal, absolute prefix, empty segment, or Windows device name. Symlink sources and managed symlink paths are rejected. Root `.ocx/`, `.git/`, `.opencode/`, `node_modules/`, environment files, package manifests, and package-manager lockfiles are reserved.

Only a `profile` component may own root `ocx.jsonc`, `opencode.json(c)`, `cli.json`, or `AGENTS.md`. These are complete files, never config patches. A component cannot claim another installed component's file or overwrite an unmanaged file.

## Skills

Skills package instructions and supporting resources. Use `skills/<name>/SKILL.md` and keep `name` aligned with the directory:

```markdown
---
name: review
description: Review a code change for concrete regressions and missing verification.
---

# Review a change

Use this skill when asked to review a diff or pull request.

1. Read the diff, its callers, and the project's contribution guidance.
2. Trace changed behavior through success and failure paths.
3. Reproduce concrete issues where practical.
4. Report each issue with a source location, trigger, and consequence.
5. State what was checked and what remains unverified.

Consult [the checklist](references/checklist.md) for project-specific checks.
```

Manifest entry:

```json
{
  "name": "review",
  "type": "skill",
  "description": "Review changes for correctness and regressions",
  "files": ["skills/review/SKILL.md", "skills/review/references/checklist.md"]
}
```

Make instructions executable by a reader: provide conditions, steps, expected output, and examples. Avoid references to retired plugin tools. If a supporting script needs a runtime or external service, document that prerequisite explicitly.

## Agents

Agents are native OpenCode definitions. OCX copies the Markdown file; OpenCode interprets its frontmatter and body.

```markdown
---
description: Review a change and explain actionable findings.
mode: subagent
permissions:
  - action: edit
    resource: '*'
    effect: deny
---

Review the requested changes and their callers. Report a defect only when you
can explain its trigger and consequence. Include file references and the
checks you performed. Do not modify the reviewed code.
```

Publish as `agents/reviewer.md`:

```json
{
  "name": "reviewer",
  "type": "agent",
  "description": "A reviewer that cannot edit files",
  "files": ["agents/reviewer.md"],
  "dependencies": ["review"]
}
```

Specify models only when the component actually requires one. Document provider credentials and permissions in the component's own guide; OCX does not provision credentials.

## Commands

The Markdown body is the native command template. Example `commands/review.md`:

```markdown
---
description: Review the requested diff.
agent: reviewer
subagent: true
---

Review $ARGUMENTS. Explain concrete findings with source locations and
summarize the validation performed.
```

```json
{
  "name": "review-command",
  "type": "command",
  "description": "Run the reviewer with /review",
  "files": ["commands/review.md"],
  "dependencies": ["reviewer"]
}
```

The file path determines the OpenCode command name, while the component name determines its OCX installation reference. `team/review-command` installs the `/review` command in this example.

## Bundles and dependencies

A bundle groups components without duplicating their files:

```json
{
  "name": "review-kit",
  "type": "bundle",
  "description": "Reviewer, review skill, and slash command",
  "files": [],
  "dependencies": ["review-command"]
}
```

Use bare names for this registry's components and `alias/component` for another registry. External aliases must be configured in the installation scope; aliases are not package names or URLs. OCX detects cycles and file ownership collisions. Do not add a second copy of a dependency's files to the parent component.

Updates consider the dependency graph. Removing a dependency still required by another installed component is refused; remove the dependent component explicitly as well. Dependencies left unreferenced are retained until explicitly removed.

## Profile recipes

A profile recipe provides complete native configuration files and can depend on ordinary components:

```json
{
  "name": "team",
  "type": "profile",
  "description": "Team review profile",
  "files": [
    { "path": "profiles/team/ocx.jsonc", "target": "ocx.jsonc" },
    { "path": "profiles/team/opencode.jsonc", "target": "opencode.jsonc" },
    { "path": "profiles/team/AGENTS.md", "target": "AGENTS.md" }
  ],
  "dependencies": ["review-kit"]
}
```

Example `files/profiles/team/ocx.jsonc`:

```json
{
  "$schema": "https://ocx.kdco.dev/schemas/v3/profile.json",
  "projectConfig": "ignore",
  "registries": {}
}
```

Start `opencode.jsonc` with `{}` and add native settings only when needed. Put team instructions in `AGENTS.md`. Create a new profile from the recipe:

```sh
ocx profile add team-test --source team/team --from http://localhost:8787
ocx profile show team-test
ocx verify --profile team-test
ocx oc --profile team-test
```

`projectConfig: "ignore"` controls startup discovery. It does not prevent OpenCode from reading nearby `AGENTS.md` guidance when it later reads project files. Profiles share native credentials and session storage.

## Plugins, tools, and native configuration

`plugin` and `tool` remain valid component type labels for copied files. They do not enable an OCX runtime, package installation, or plugin API adapter. Only distribute code written for the native V2 API, with any required setup documented. Prefer OpenCode's native plugin package support for npm plugins.

Protocol 3 has no `opencode`, `npmDependencies`, or similar config-patch fields on a component. A profile recipe can distribute a whole native config file; an ordinary component should document any native configuration the user needs to add. OCX never resolves OpenCode `{env:...}` or `{file:...}` references.

Use the native documentation for changing contracts:

- [Agents](https://opencode.ai/v2/docs/agents)
- [Commands](https://opencode.ai/v2/docs/commands)
- [Skills](https://opencode.ai/v2/docs/skills)
- [Plugins](https://opencode.ai/v2/docs/plugins)
- [Permissions](https://opencode.ai/v2/docs/permissions)
- [MCP servers](https://opencode.ai/v2/docs/mcp-servers)

## Build output and hosting

```text
dist/
  .well-known/ocx.json
  index.json
  components/
    review.json
    review/skills/review/SKILL.md
    review/skills/review/references/checklist.md
```

`index.json` describes the catalog. Each component JSON file contains its latest revision and manifest. Assets are served below that component's directory. The builder validates the source before publishing a staged output directory; do not edit or incrementally upload only parts of an existing live deployment.

The README covers Cloudflare, Vercel, and Netlify. All use the same `dist/` output. A subpath deployment must preserve the subpath in discovery metadata; test using the actual public registry base URL.

## Release checklist

1. Update the changed component's `version`, or the registry's version when using the shared revision.
2. Run `ocx validate .`, then a dry-run and real build.
3. Serve `dist/` locally and install into a fresh project and profile where applicable.
4. Open installed Markdown and supporting assets; verify paths and content.
5. Run `ocx verify` with the same destination and exercise the definition in OpenCode V2.
6. Upgrade an older installation with `ocx update ... --dry-run`, including a locally edited file, to check the user-facing change.
7. Publish a complete static deployment and repeat the fresh install against its URL.

Use `--json` for CI reports. A zero-exit validation checks registry structure and files; it does not prove agent quality, native plugin compatibility, or third-party service availability.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Schema rejected | Use protocol 3 and remove unsupported V1 component patch/package fields. |
| Source missing | Paths are relative to `files/`; check case and list supporting files explicitly. |
| Duplicate target | Give one component ownership, then depend on it from other components. |
| Dependency not found | Check local names and configure external aliases at the destination. |
| Skill/command absent in OpenCode | Check the installed path, native frontmatter, selected profile, and project discovery mode. |
| Update conflict | Compare local edits with upstream; preview `--force` only after deciding which edits to discard. |
| Interrupted build | Rerun it to recover the publication journal; do not discard the previous output or recovery files. |

See [OCX troubleshooting](https://ocx.kdco.dev/v2/troubleshooting) for locks, installation recovery, and native version checks.

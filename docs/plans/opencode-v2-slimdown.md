# OCX for OpenCode V2: scope and migration plan

Status: approved implementation in progress. The user authorized the V2-only slimdown, freezing the existing V1 line, manual validation, an open PR, and Cubic review cycles. Completion evidence is tracked in `docs/maintainers/opencode-v2-validation.md`.

Evidence baseline: OCX commit `e79df6f`, CLI version `2.0.15`; OpenCode source tag `v2.0.3` and official V2 documentation inspected on 2026-09-16. Source inspection establishes integration candidates; real-binary validation is still required.

## 1. Product decision

OCX manages **portable named profiles and editable configuration packages**.

Keep two user journeys:

1. Create or install a profile, customize its ordinary OpenCode files, and launch it in any repository.
2. Install, inspect, update, and remove editable agents, skills, commands, and supporting files from a registry, either in a profile or a project's `.opencode/` directory.

OpenCode owns configuration interpretation, discovery, plugin installation, credentials, sessions, background agents, worktrees, notifications, planning, and compaction. OCX should not need a runtime plugin or a server API integration for its core offering.

The maintained starter setup should work without any third-party runtime plugins. Users can still configure V2-compatible plugins through native OpenCode configuration. Retiring our plugins does not mean prohibiting community plugins.

**Version naming:** OCX is already `2.0.15`. Recommend shipping these breaking changes as **OCX 3**, described as “OCX for OpenCode V2.” Keep OCX release versions, OpenCode versions, and registry protocol versions distinct. Do not reuse an existing major number to imply compatibility.

## 2. Keep, remove, and simplify

| Area | Decision | Result |
| --- | --- | --- |
| Named profile CRUD, cloning, inspection, launch | Keep | Primary OCX value; profiles remain ordinary editable directories. |
| Profile-scoped registry sources | Keep | Installing into one profile does not change another profile's sources. |
| Project component installs | Keep | An explicit file-installation operation, separate from profile launch. |
| Registry resolution, dependency graph, receipts, verification | Keep | Supports ownership and updates of copied files. |
| Registry search, build, validation | Keep | Keep the existing static distribution model. |
| Four maintained runtime plugins | Retire | Background agents, notify, worktree, and workspace leave the active product. |
| Plugin facade repositories and synchronization | Retire after notices | Preserve readable history and links; stop maintaining mirrored source. |
| `ocx add npm:...` | Remove | Native OpenCode owns package plugins. |
| Manifest `npmDependencies` / `npmDevDependencies` | Remove | No package.json mutation, installation orchestration, or node_modules invalidation. |
| Component-level `opencode` config patches | Remove | Profiles own complete config files; components own individual files. |
| OCX's OpenCode config schema mirror | Remove | Validate OCX metadata and JSONC syntax; OpenCode validates its own fields. |
| Launch-time OpenCode config merging | Remove | Native loading establishes precedence, permissions, plugin ordering, and path semantics. |
| Per-file project `include` / `exclude` | Replace | Two explicit modes: ignore project configuration, or inherit it natively. |
| Merged-directory overlay, fingerprint cache, leases | Remove if native launch passes tests | Launch directly against the stable profile directory. |
| Automatic project-driven profile selection | Remove | Select through CLI, environment, or an explicit user default. |
| Configurable component installation root | Remove | Use the selected profile root or the project's `.opencode/` directory. |
| OCX terminal/tmux title management | Remove | Small convenience does not justify a separate terminal integration. |
| `OCX_CONTEXT` / `OCX_BIN` worktree handoff | Remove | No maintained plugin consumes this bridge after retirement. |
| Legacy registry/receipt migration in normal execution | Remove | Legacy conversion becomes an explicit, bounded import operation. |
| Distribution, supported platforms, explicit self-update | Keep | These serve OCX itself; OpenCode's updater does not replace them. |

These are intentional product cuts. V2 does not reproduce every custom worktree hook, research archive, citation format, or planning reminder. The decision is to stop owning those behaviors.

Some native alternatives predate V2. The justification for removal is reduced ownership, not a claim that every replacement was introduced in V2.

## 3. Target profile contract

### Storage

Use a new OCX-owned config root, following the user's XDG config root:

```text
~/.config/ocx/
  ocx.jsonc                    # default profile and OCX settings
  profiles/
    work/
      ocx.jsonc                # registry sources, discovery mode, optional binary
      opencode.jsonc           # native OpenCode configuration
      AGENTS.md
      agents/
      commands/
      skills/
      cli.json                 # optional; owned/interpreted by OpenCode
      .ocx/receipt.jsonc
```

Existing `~/.config/opencode/profiles/` directories remain untouched for the legacy CLI. A new root avoids letting the old CLI accidentally operate on converted profiles. Import rather than rename in place.

Keep profile metadata small. Proposed profile settings:

```jsonc
{
  "projectConfig": "ignore",
  "registries": {},
  "bin": "/optional/path/to/opencode"
}
```

`projectConfig` accepts `ignore` or `inherit`. `ignore` is the default for a newly created profile. Imported profiles require an explicit decision when the former filtering policy cannot be represented faithfully.

### Selection and scope

Use one selection order: `--profile` → `OCX_PROFILE` → configured `defaultProfile`. An explicit missing profile is an error. With no selection, explain how to select or create one; do not silently fall back to the ambient global OpenCode configuration.

Profiles are global by definition, so remove the required `--global` flag from profile commands. Do not read a repository's `profile` field to override user selection. Repository-local OCX files can still describe sources for explicit project component installation.

Component mutations use an explicit destination: `--profile <name>` or `--project`, mutually exclusive. They do not silently inherit `OCX_PROFILE` or a launch default. This makes the destination obvious before files are changed and avoids today's inconsistent command scopes.

### Native launch

The preferred launch is conceptually:

```text
OPENCODE_CONFIG_DIR=<stable profile directory>
OPENCODE_DISABLE_PROJECT_CONFIG=<value selected by mode>
opencode --standalone <user arguments>
```

This is an integration candidate, not a verified command contract. Confirm supported flag placement for the TUI, `run`, and each forwarded subcommand before implementation.

Use a private server for each profiled launch initially. A shared service may already have configuration from another launch. Let OpenCode own the private server's lifecycle through `--standalone`; do not create an OCX daemon, service registry, or server pool. The released [server connection implementation](https://github.com/anomalyco/opencode/blob/v2.0.3/packages/cli/src/services/server-connection.ts) selects this path, and its [standalone implementation](https://github.com/anomalyco/opencode/blob/v2.0.3/packages/cli/src/services/standalone.ts) manages the child process.

Remove inherited launch overrides that would redirect config away from the selected profile, including `OPENCODE_CONFIG` and `OPENCODE_CONFIG_CONTENT`; set or clear the project-discovery override deliberately. Preserve ordinary provider credentials and environment references. Preserve the working directory, arguments, terminal I/O, exit status, and signal forwarding. Keep a configurable OpenCode binary and reject a detected V1 binary with a direct explanation.

Reject an explicit remote/shared server combined with a managed profile in the first release. Local profile files do not configure an arbitrary remote server. Do not silently accept flags that invalidate the profile contract.

### Configuration behavior

| Concern | Contract |
| --- | --- |
| Profile config | OpenCode reads it directly from the selected directory. |
| Ambient OpenCode global config | Not manually merged into every profile; seed or copy desired settings explicitly. |
| Project mode `ignore` | Disable native project configuration, definitions, and initial instruction discovery. Read-time nested instruction discovery follows OpenCode's native behavior. |
| Project mode `inherit` | Use native discovery and precedence, including applicable ancestor sources. |
| File and environment references | Keep original files and their native path bases; no recursive token rewriting. |
| Permissions and plugin ordering | Preserve OpenCode's ordered behavior; OCX does not deduplicate or merge arrays. |
| Instructions | Use native `AGENTS.md`; no injected `instructions` array or generated combined prompt. |
| Terminal preferences | Follow the selected native config root. Allow an ordinary `cli.json`; do not merge/synchronize it on every launch. |
| Credentials and session data | Native user storage by default; not separate accounts or histories per profile. |
| Machine-global compatibility sources | Document native behavior for `~/.agents`, `~/.claude`, and organization defaults. Do not claim the project-discovery switch disables these. |

The [released CLI](https://github.com/anomalyco/opencode/blob/v2.0.3/packages/cli/src/index.ts#L115) overrides the global config directory. Its [terminal config loader](https://github.com/anomalyco/opencode/blob/v2.0.3/packages/cli/src/config/config.ts) reads `cli.json` from that root. Global skill compatibility directories are separately included by [native discovery](https://github.com/anomalyco/opencode/blob/v2.0.3/packages/core/src/config/discovery.ts).

Call the modes “ignore project configuration” and “inherit project configuration,” not “sandbox” or “fully isolated.” They do not prevent the agent from reading project files or executing tools. Switching profiles does not retroactively remove instructions already present in a resumed conversation.

Implementation finding: OpenCode `2.0.3` still discovers nested `AGENTS.md` during file reads with project configuration disabled. Source comparison confirms OpenCode `1.18.23` already does the same. Preserve and document this native behavior; complete exclusion of all repository instructions is not part of the thin-launcher contract.

The current [instructions documentation](https://opencode.ai/v2/docs/instructions#configuration) explicitly says the `instructions` array is accepted but not resolved. Eliminating OCX's injection path is therefore a functional migration requirement, not just cleanup.

## 4. A smaller registry contract

Retain static HTTP registries, local fixture registries, component references, dependency resolution, hashes, ownership receipts, dry runs, and atomic writes. Do not introduce a hosted control plane, account system, or a replacement package manager.

### Components copy files

An agent component provides `agents/reviewer.md`. A skill provides its entire `skills/review/` directory, including scripts and references. A command provides `commands/review.md`. A bundle composes these through dependencies. A profile provides the root configuration plus definitions and dependencies.

All component destinations are relative to the selected configuration root. Only a profile install owns root configuration such as `opencode.jsonc`, `ocx.jsonc`, `cli.json`, and `AGENTS.md`. Ordinary components cannot patch or replace those files or escape into arbitrary repository files.

A bundle that needs MCP configuration, permissions, model settings, or plugin declarations becomes a profile template, or documents an explicit native-config edit. Do not replace the old `opencode` patch field with another patch language.

Generic supporting files can include scripts and user-authored native plugin code. Copying those files does not make OCX responsible for their runtime or package dependencies. Remove plugin/tool-specific orchestration; retain type labels only where they help discovery and do not imply managed execution.

Native [plugin management](https://opencode.ai/v2/docs/plugins#manage) owns npm/Git packages. Native [skill catalogs](https://opencode.ai/v2/docs/skills#catalogs) suit users who want subscribed skills. OCX remains useful when users want copied, editable files with an ownership record. Do not add automatic publishing to both catalog formats in the initial release.

### Validation and compatibility

Validate the OCX manifest, profile metadata, dependency graph, target containment, receipt integrity, and JSONC syntax. Do not ship a frozen list of all OpenCode config fields or import OpenCode's internal config normalizer.

Validate maintained templates against the supported real OpenCode binary. Arbitrary user OpenCode configuration is interpreted by OpenCode. New native settings must not require an OCX release merely to pass through.

Use a new registry schema major for changed destination rules and removal of config/npm patch fields. Preserve the existing transport and receipt machinery where compatible; do not renumber unchanged receipt formats for cosmetic consistency. Version the receipt only if ownership semantics require it.

Normal V2-only operation rejects old registry protocols before writing. Do not make the old parser permissively discard fields: an ignored permission patch or dependency would change installed behavior. The separate import workflow handles legacy artifacts.

Publish an author migration example covering new target roots, profile-owned configuration, and removed manifest fields. Inventory external schema/build consumers, including TweakOC referenced by today's quick start and the exported `buildRegistry` API. Preserve public exports where practical, version breaking changes, and keep old schema documents available. Do not advertise an external generator as V2-compatible before checking its output.

### Preserve the value of owned files

Keep preflight collision detection, dependency ownership, path containment, atomic publication, rollback after partial failure, and hash verification. Update and removal must refuse to overwrite/delete local edits by default; an intentional overwrite must be explicit and previewable. Do not add an automatic three-way merge engine.

Define updates as a complete file-set change: include renamed and removed upstream files, shared dependencies, receipt changes, and modified local files. Handle profile configuration through the same owned-file rules, without semantic JSON merging.

Receipts describe installed component bytes and sources. They are not a lockfile for OpenCode's npm plugins, a proof that code is safe, or a guarantee that the user reviewed it.

## 5. CLI surface

Proposed commands; examples describe the target interface, not the current release:

| Workflow | Interface |
| --- | --- |
| Create or clone | `ocx profile add work`, `ocx profile add client --clone work` |
| Install a profile | `ocx profile add work --source team/base --from <registry-url>` |
| Inspect/manage | `ocx profile list`, `show`, `move`, `remove` |
| Launch | `ocx oc -p work`; keep the `opencode` alias |
| Inspect/edit OCX settings | `ocx config show`, `ocx config edit`, with an explicit profile or global scope |
| Install owned files | `ocx add team/reviewer --profile work` or `--project` |
| Maintain owned files | `ocx update`, `remove`, `verify`, with the same destination flags |
| Registry sources/search | Existing registry and search commands with consistent scopes |
| Author a registry | Existing scaffold, build, and validate commands |
| Import a legacy setup | `ocx migrate` as a preview-first importer into new storage |
| Maintain the CLI | Existing explicit self-update and uninstall paths |

`config show` explains OCX's selected profile, root, discovery mode, binary, and registry sources. Do not pretend OCX's old reconstructed object is OpenCode's effective runtime configuration; use native debug facilities for that.

For runtime commands, inject standalone mode only where supported. Config/package commands that operate directly on the selected config root should use their native behavior. Maintain a small tested dispatch contract; do not blindly prepend a TUI flag to every command. Reject unsupported forwarding with a useful message.

Remove the `npm:` installer branch and its `--trust` option. Remove filtering and terminal-title options. Do not add a general session manager, credential switcher, worktree wrapper, or plugin update wrapper. Retain help, JSON output, quiet/verbose behavior, dry runs, and established aliases where they are cheap and unambiguous.

Make ordinary profile management and launch independent of OCX network checks. Keep explicit `self update`; remove the per-command update-check hook from the normal path if it would otherwise remain a hidden dependency.

## 6. Bundled ecosystem retirement

| Existing asset | Action |
| --- | --- |
| `background-agents.ts` | Retire; document native subagents and the loss of the custom research archive. |
| `notify.ts` and backends | Retire; link native attention settings and identify custom integrations that are no longer maintained. |
| `worktree.ts` and helpers | Retire; link native worktrees and list omitted terminal/sync/cleanup automation. |
| `workspace-plugin.ts` | Retire; do not rebuild plan storage, citation validators, or reminders as an OCX feature. |
| `kdco-primitives` | Remove once remaining imports are gone. |
| `plan-protocol` / `plan-review` | Rewrite as ordinary guidance using native planning and ordinary source links, or omit if the result only duplicates built-in guidance. |
| Review/philosophy skills and reviewer/researcher definitions | Keep only useful editorial guidance; remove obsolete tool names and runtime assumptions. |
| Coder/scribe agents | Keep only if their instructions provide a clear workflow beyond the built-in agents. Do not port by habit. |
| Workspace and OMO starter profiles | Retire the old presets from the new catalog. Preserve legacy artifacts at their existing URLs. |
| DCP, table formatter, Oh My OpenAgent dependencies | Remove from first-party defaults. This is a maintenance decision, not a claim that all their behavior is native. |
| New starter | One minimal profile using native agents and optional useful static review guidance; no runtime plugin dependency. |

Audit retained text for `delegate`, `delegation_read`, `delegation_list`, `plan_save`, `plan_read`, old citation IDs, custom worktree tools, V1 hook names, and old permission/tool names. Adapt actual tool usage to V2; do not mechanically replace every prose use of “delegate.” Move surviving agent/command/skill files to preferred plural directories.

Maintain one new catalog. Consolidate the active roles of `workers/kdco-registry` and `workers/ocx-kit`; preserve both old public addresses through static legacy snapshots rather than maintaining two active preset ecosystems.

Retire these facades only after their final notice content has been published:

- `kdcokenny/opencode-background-agents`
- `kdcokenny/opencode-notify`
- `kdcokenny/opencode-worktree`
- `kdcokenny/opencode-workspace`

Each notice should state OpenCode V1-only, identify the final supported artifact, link native alternatives, identify lost custom behavior, and direct OCX questions to the active repository. Archive preserves history; do not delete releases or rewrite their tags. Unpublish no packages. Inventory which packages actually belong to us before making any deprecation changes.

Publish final notices before removing `.github/sync.yml` and `.github/workflows/sync-facades.yml`. Disable synchronization before archiving to avoid failed writes. Retire the sync credential only after confirming it has no other consumers.

## 7. Existing users and frozen V1 support

### Freeze artifacts, not just source

Record a final legacy CLI release and source tag. Preserve legacy documentation, schema URLs, index files, packuments, component versions, file URLs, and installer/download paths. Save the built registries; a source tag alone does not keep an existing install URL working.

Leave existing registry roots on their final legacy contents. Publish the new catalog at a distinct path such as `/opencode-v2/`; do not redirect old unversioned endpoints to the new catalog. Give the frozen preset/plugin artifacts no further feature updates.

Use a preview npm dist-tag for the new major. Before promoting it to `latest`, audit the installer, `self update`, and legacy update checks. Provide an exact-version or legacy-channel installation path and explain that moving to the new major requires OpenCode V2. Existing old binaries may follow unqualified latest-release endpoints; do not claim that a newly introduced channel changes their behavior retroactively. If necessary, ship one transition release on the legacy line before freezing it.

OpenCode installation guidance must identify the actual V2 distribution and tested release. At the research baseline, V2 uses `@opencode/cli`, while the old `opencode-ai` package and default GitHub release track still point at V1. OCX must detect the executable it launches rather than infer compatibility from the presence of an `opencode` command.

### Import, do not transform in place

The importer operates on explicit legacy profile or project inputs. Its default is a report/preview. Application writes a separate destination, with the original intact and a manifest of copied, omitted, and unresolved items.

1. Inventory native files, receipts, registry sources, config patch ownership, runtime plugins, npm dependencies, and filter rules.
2. Copy supported static definitions and config into staging. Preserve relative supporting files and custom edits.
3. Keep supported V1 configuration syntax when V2 already handles it. Do not build a universal V1-to-V2 normalizer. New first-party templates use native V2 syntax.
4. Remove known retired dependencies from the runnable candidate only when identified reliably. Preserve their originals; unknown local plugin code or unverified packages require a migration decision before activation. Native directory autodiscovery must not reload an omitted plugin.
5. Report ignored V1 fields and `instructions` entries. Move intentional guidance to `AGENTS.md` through a reviewed import edit; do not fetch and concatenate arbitrary URL/glob instructions automatically.
6. Require an explicit mode decision for nontrivial include/exclude policies. “Everything except these files” cannot be silently converted into “inherit everything.”
7. Do not claim old receipts are receipts for changed files. Preserve legacy provenance in the import report, mark unmatched files as user-owned, and issue new receipts only for installations whose bytes and source can be established.
8. Run native-config and retirement checks against staging, then publish the new profile atomically. Unresolved runtime/configuration issues leave a reviewable staged import, not an automatically selected profile.

Existing profiles that depend heavily on the retired workspace are better served by a clean native starter plus selectively copied custom instructions. Do not promise a behavior-preserving automatic migration for those profiles.

Rollback means selecting the unchanged legacy CLI/setup and the user's retained OpenCode V1 binary. OCX does not install, replace, or downgrade OpenCode automatically. The OpenCode migration guide notes that V1/V2 share the command and normally replace one another, so preserving OCX files alone does not preserve both executables.

## 8. Implementation sequence and completion gates

### Phase 0 — Prove the native profile boundary

Build an isolated conformance fixture against released OpenCode V2 before deleting the current launch machinery. Start with `2.0.3` as the investigated baseline; choose the actual minimum supported version from passing tests. Keep all test credentials/data/config in temporary roots and use the `ocx-dev` profile for repository-prescribed manual OCX testing.

Prove:

- Root override reaches both CLI and private server.
- Two simultaneous profiles show distinct models, agents, commands, plugins, and permission rules; an already-running default service does not capture them.
- Ignore mode suppresses root/ancestor project config, `.opencode`, project compatibility directories, and initial ambient `AGENTS.md`; separately verify and document that native read-time nested instructions still load, as they did in V1.
- Inherit mode uses native precedence without duplicate OCX merging.
- Profile-root definitions load directly and relative references have native semantics. Skill `skills` array paths may be working-directory-relative, so first-party profiles should prefer their automatically discovered `skills/` directory.
- Auth remains usable, shared storage tolerates concurrent private servers, and session resume behavior is understood.
- `cli.json`, home-level compatibility skills, organization defaults, and configuration overrides behave as documented.
- TUI, headless `run`, and chosen forwarded native configuration commands work with correct argument placement.
- Exit, signals, startup failures, and repeated launches do not leave OCX-owned background processes.
- OCX launch writes no project config. Test runtime writes separately rather than promising OpenCode never changes a repository.

Use native debug/API observations and a local mock model where needed to observe actual instruction context; a dummy executable that only captures environment variables is insufficient. No paid model request is required for routine CI.

An official client used only by integration tests is acceptable. It should not become an OCX runtime dependency merely to configure a profile or launch the terminal client.

**Exit gate:** record the supported version/flags and effective behavior. If a required control fails, seek an upstream fix or explicitly revise the product contract. Do not silently reintroduce a permanent OCX runtime plugin, global-config rewriting, or a service manager.

### Phase 1 — Preserve the legacy release

Capture final source and registry snapshots, prepare legacy instructions and deprecation notices, separate release channels and catalog addresses, and test old-client installs against frozen artifacts. This can start alongside Phase 0; deletion depends on it.

**Exit gate:** a pinned legacy client can still install the former workspace/profile from the preserved addresses. No existing public version has been replaced with different contents.

### Phase 2 — Implement the thin profile manager and launcher

Add the new storage root and minimal profile schema. Simplify profile selection, remove required `--global`, implement the two discovery modes, and use the native launch contract proven in Phase 0. Retain process supervision and argument forwarding. Remove overlay/cache code only when replacement tests pass.

**Exit gate:** local profiles work without registry/network access, no-profile errors are clear, the modes match the documented behavior, and legacy directories are untouched.

### Phase 3 — Reduce registry installation to owned files

Introduce the smaller schema, standardize destinations, remove npm/config patch paths, and make update/remove/verify consistent across profile and project destinations. Keep the transaction and ownership core. Update the example registry and published OCX schemas.

**Exit gate:** a profile with static dependencies installs, updates, verifies, and removes correctly; edited files are protected; unsupported legacy fields fail before any writes. Unknown native OpenCode config fields survive copying unchanged.

### Phase 4 — Add the bounded importer

Implement preview/report/staging for legacy profiles and project installations. Keep the legacy parser within the importer, out of normal resolution. Exercise retired plugins, unsupported config, modified files, nontrivial filtering, and rollback.

**Exit gate:** successful imports are runnable without retired APIs; unresolved imports cannot accidentally activate V1 plugins; a failure never damages the original setup.

### Phase 5 — Retire runtime code and publish the static starter

Remove the four plugins and unused primitives, tests, SDK dependencies, fixtures, npm-management helpers, and synchronization machinery in the correct notice/archive order. Rewrite or remove dependent prose. Publish one small native starter and one maintained catalog.

**Exit gate:** no active starter, source import, CI task, documentation path, or example depends on retired hooks/tools. Legacy references remain only where intentionally documenting or importing old setups.

### Phase 6 — Documentation, beta, and stable release

Rewrite README/quick start around profiles first and owned components second. Explain discovery modes and their limits, native plugin management, explicit component destinations, legacy import, and the version split. Replace stale demos and facade contribution directions. Keep redirects/archive pages for retired docs instead of breaking established links.

Run the repository's applicable formatting/type checks, focused behavior tests, registry build/validation, and supported-platform binary smoke tests. Beta-test real profiles in multiple repositories, including concurrent launches and edited component updates. Recheck upstream's released package/tag before setting the final compatibility floor.

**Exit gate:** all retained journeys and migration fixtures pass, frozen artifacts are reachable, the native starter has no runtime dependencies, and release notes explicitly list the removed behavior.

## 9. Code map

| Current area | Planned work |
| --- | --- |
| `packages/cli/src/profile/{manager,paths,schema,atomic}.ts` | Keep directory lifecycle and atomicity; change root/schema and remove obsolete layering concepts. |
| `packages/cli/src/commands/profile/*` | Keep user workflows; drop redundant scope requirements and add import integration. |
| `packages/cli/src/config/resolver.ts` | Replace most of the 811-line resolver with selection and metadata resolution. |
| `packages/cli/src/commands/opencode.ts` | Keep process supervision; remove config merging, instruction injection, token rewriting, and terminal title/context plumbing. |
| `packages/cli/src/commands/opencode-overlay.ts` | Delete after native discovery conformance passes. |
| `packages/cli/src/commands/opencode-cache.ts` | Delete generated-directory caching; move minimal binary-version detection if still needed. |
| `packages/cli/src/registry/merge.ts` | Remove from normal operation; any necessary legacy interpretation stays inside import. |
| `packages/cli/src/schemas/registry.ts` | Keep OCX envelope validation; remove native config schema and npm patch fields. |
| `schemas/opencode-config-fields.generated.ts`, `scripts/sync-opencode-schema.ts` | Delete OpenCode schema mirroring. |
| `commands/add.ts`, `updaters/update-opencode-config.ts`, `utils/{npm-registry,dep-invalidation}.ts` | Remove npm installation and semantic config mutation branches; check remaining callers before deleting helpers. |
| `commands/{update,remove,verify}.ts`, receipt/path/write utilities | Retain core behavior and standardize destinations. |
| `commands/migrate/*` | Replace the existing OCX-format migration UX with an explicitly versioned legacy-import path. |
| `workers/kdco-registry/files/plugins/*` and plugin tests | Retire active source and unused runtime dependencies. |
| `workers/{kdco-registry,ocx-kit}` | Freeze legacy outputs; consolidate new catalog ownership. |
| `.github/sync.yml`, facade sync workflow, `facades/*` | Final notices, disable sync, archive, then remove active maintenance files. |
| Docs, examples, fixtures, release workflow, install script | Update scope/contracts, legacy paths, schemas, and release channels. |

The four plugin entrypoints total 4,996 lines at the baseline, excluding helpers and tests. The launch command, overlay, cache, and resolver total 3,187 lines. These identify where complexity is concentrated; they are not a promise to delete all 8,183 lines or a reason to remove useful transaction checks.

## 10. Required regression coverage

| Boundary | Essential cases |
| --- | --- |
| Selection | CLI/environment/default precedence, missing profile, no repo override, names/path validation. |
| Launch | Real V2/private server, V1 rejection, simultaneous profiles, pre-existing service, relative cwd, arguments, errors, signals. |
| Discovery | Both modes; root/nested/ancestor definitions; later nested instruction discovery; native home-global sources. |
| Native semantics | Ordered permissions/plugins, plural fields, native MCP shape, unknown future fields, file/env references, terminal config. |
| Registry | Same/cross-registry dependencies, scope isolation, cycles, missing files, collisions, unsupported protocol, hashes, traversal/symlinks. |
| Ownership | Edited files, obsolete upstream files, shared dependencies, interrupted writes, receipts, dry runs, rollback. |
| Import | Untouched originals, custom edits, supported V1 syntax, retired/unknown plugins, filter decisions, instruction gaps, repeated import. |
| Distribution | Supported OS/architectures, paths with spaces, npm/Bun and binary installs, preview/stable/legacy selection. |
| Retirement | No active references to retired APIs; frozen registry/install/documentation links still resolve. |

Delete tests for deliberately removed features. Retain reusable file-transaction and containment cases. Introduce real V2 integration tests before rewriting launcher assertions around the new implementation. Run routine CI against a pinned compatibility floor; use a separate latest-V2 compatibility job so upstream drift is visible without making all tests non-reproducible.

## 11. Scope limits and remaining technical decisions

Confirmed: V2-only runtime target; existing OCX line frozen for V1 users.

Recommended product decisions: new major release; two project discovery modes; no implicit project profile selection; no config patching or npm orchestration; a new profile root; one static starter/catalog; explicit install destinations.

Technical decisions to close in Phase 0: minimum working V2 release, native forwarded-command flags, concurrency/storage behavior, complete project-discovery suppression, and the exact behavior of terminal/global compatibility settings. These need executable evidence, not a new product questionnaire.

Defer daemon pooling, profile inheritance chains, per-profile credentials/history, remote profile deployment, a universal configuration converter, native skill-catalog publishing, automated three-way file merges, and new user interfaces. None is required to ship the two retained journeys.

If future user demand justifies a removed feature, add it from a concrete use case. Do not preserve a subsystem solely because it existed in the V1 integration.

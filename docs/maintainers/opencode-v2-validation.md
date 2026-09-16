# OpenCode V2 implementation and validation record

This record accompanies the [implementation plan](../plans/opencode-v2-slimdown.md). It records executed checks separately from remaining work.

## Baseline

- Source: `e79df6f`, aligned with `origin/main` when work began.
- Existing CLI: OCX `2.0.15`; installed OpenCode `1.18.23` was left unchanged.
- Isolated test binary: official `@opencode/cli@2.0.3` in `/tmp/ocx-v2-conformance`, with the official client used only by probes.
- `bun run build`: passed before changes; both legacy registries built successfully.
- `bun run check`: passed before changes.
- Frozen built registries: `legacy/kdco-registry.tar.gz` (52 files) and `legacy/ocx-kit.tar.gz` (9 files). `legacy/manifest.json` records archive and individual file hashes.

## Native profile probe

Executed against three simultaneous V2 servers with shared temporary data/state roots and distinct configuration roots:

- Profile agents, commands, skills, model settings, and permission rules loaded from the selected root.
- One profile's marker definitions were absent from the other profiles.
- Project definitions/config were excluded with `OPENCODE_CONFIG_PROJECT_DISABLE=1` and included with `0`.
- Built-in plugin activation must finish before observing effective catalogs; initial catalog reads alone can race activation.
- Private servers exited when their stdio lease closed.
- Native CLI `--standalone` is command-specific, not global. `run` and `api` accept it; `debug config` and `plugin add` do not declare it.

## Instruction probe

Used a local OpenAI-compatible mock endpoint, real V2 model requests, and a real `read` tool call. No paid model requests were made.

- Profile `AGENTS.md` appeared in the initial model context.
- Disabling project configuration excluded the initial project `AGENTS.md`.
- **Upstream limitation found:** a subsequent read of `nested/example.txt` injected `nested/AGENTS.md` even with project configuration disabled. The released read-tool implementation independently discovers nested instructions without consulting the project-discovery policy.
- Comparison with OpenCode `v1.18.23` shows the same behavior: its read-time `Instruction.resolve` walk also operates independently of the startup project-discovery switch. This is not a newly introduced V2 regression. Continue with native behavior and document the scope of the setting; do not claim complete project-instruction exclusion.

## Implementation and automated checks

- Thin named profiles, explicit destinations, protocol-3 file ownership, importer, static catalog, preview-channel release safeguards, and separate V2 documentation are implemented in the working branch.
- `bun test tests` in `packages/cli`: 553 passed, zero failures. Six compiled-binary checks ran separately and passed. The remaining skips are network/template-release cases that require an already-published V3 tag or a changed default branch; local template scaffolding and registry building were exercised manually.
- `bun run check` passed all four packages after updating the frozen worker's type environment. `bun run build` passed all three build tasks.
- Compiled Linux x64 binary: build and six version/help smoke checks passed. Worker routing tests: 29 passed, including all four separate V3 schemas and unchanged legacy schema defaults.
- The maintained `test:native` probes launched the **built OCX CLI** against official OpenCode 2.0.3. Three simultaneous profile servers and both instruction-discovery modes passed. The mock model made two local requests per instruction scenario. Final fixtures: `/tmp/ocx-native-probe-zBQWgC`, `/tmp/ocx-instruction-probe-ggzxEo`. Catalog assertions cover agents, commands, skills, model config, permission rules, and project discovery.
- Launcher subprocess tests cover stdin, cwd, opaque arguments, native exit codes, version rejection, SIGINT/SIGTERM forwarding, and forced cleanup of an unresponsive child.
- Transaction tests cover edited/obsolete files, newly introduced dependencies, tampered receipt paths, symlinks, races, rollback, and abrupt process-exit recovery manifests.
- Self-uninstall now uses the new OCX root; all 37 retained uninstall checks pass. It preserves the old OpenCode config root.
- Self-update selects npm `next`, compares prereleases, and rejects cross-major transitions. Exact npm release lookups accept preview versions.
- Removed-feature tests were replaced by executable V3 contract tests. Old config merge/overlay/cache/npm-plugin/filter/adaptive-root assertions were intentionally retired; active build, validation, registry conflict, profile manager, path-security, self-update, uninstall, and release-tag checks remain.

## External compatibility

- Rechecked npm `@opencode/cli/latest`: still 2.0.3; the official GitHub `v2.0.3` ref exists. V2 docs live under `https://opencode.ai/v2/`; the unversioned docs still describe V1.
- Inspected TweakOC's public registry index and the README-linked profile packument on 2026-09-16. Its index uses the unversioned legacy OCX schema. OCX 3 correctly rejects that endpoint; no V2 compatibility is claimed. TweakOC needs a protocol-3 endpoint and new profile metadata. No message was sent to its maintainers.

## Manual retained workflows

All commands below used temporary XDG roots. The user's installed OpenCode V1 binary and real configuration were left unchanged.

- Built CLI journey: install the minimal profile from a local protocol-3 catalog; show/verify/update/dry-run; clone/rename/remove/default selection; native version, paths, and API health. Project source registration, search, install, local edit, failed verification, unchanged upstream update, rejected removal, forced repair, verification and removal. Fixture: `/tmp/ocx-manual-journeys-y8x4bliy`.
- Import: preview decisions, reject unresolved apply, import with explicit decisions, inspect the new profile, and compare original file hashes. Source files remained unchanged and retired plugins were omitted.
- Registry authoring: scaffold from the local updated template with a custom namespace/author, validate, and build with the compiled binary. Fixture: `/tmp/ocx-starter-manual-p2ppz7w1`. Binary assets are covered by dedicated registry tests.
- Existing native service: start the normal service with a marker config, launch OCX profile API calls, confirm the marker is absent, inspect authentication/session/path commands, and stop the fixture service. Fixture: `/tmp/ocx-native-extra-6pTRoi`.
- Headless resume: `oc run --session` resumed sessions created by the native API while a separate server for that profile was still running. Both project discovery modes passed against the local mock model.
- ACP: initialize through the built OCX launcher, receive protocol 1 and OpenCode 2.0.3 identity, close stdin, observe exit 0. Fixture: `/tmp/ocx-native-extra-8ONavF`.
- Terminal: opened the actual native TUI in a PTY through OCX, inspected the rendered prompt/model, and exited with `/exit` successfully. No paid model requests were made.
- Compiled install lifecycle: copy Linux binary into a path with spaces, initialize, create/list profiles, preview uninstall, execute uninstall, and verify the copied binary and OCX root are removed while the V1 root remains. Fixture: `/tmp/ocx-binary-uninstall-it26ytor`.
- Published legacy client: isolated OCX 2.0.15 installed frozen workspace dependencies and both legacy profile recipes from restored artifacts served over local HTTP. 59 local requests; files verified. Fixture: `/tmp/ocx-legacy-install-RFXHn3`.

The maintained `test:native` and `test:legacy` commands reproduce the native and frozen-client probes. The actual release, public deployment, and paid provider integrations were not exercised; this change prepares a preview, not a production rollout. Linux was exercised locally. PR CI also passed macOS and Windows binary smoke checks against the built artifacts.

The deployed PR worker previews were checked over HTTPS: all **61 legacy files** matched the hashes recorded before retirement. The published OCX preview installed the new minimal profile from the preview catalog, verified it, updated it, and launched native API health successfully. Fixture: `/tmp/ocx-live-catalog-09rn5iat`. The V2 overview and profile pages also rendered correctly on the Mintlify preview.

## Facade retirement

Final notices were published before synchronization was disabled and repositories were archived on 2026-09-16:

- [background-agents notice](https://github.com/kdcokenny/opencode-background-agents/commit/46cfb3dec517b8686dfb085dbff8a7a67e689480)
- [notify notice](https://github.com/kdcokenny/opencode-notify/commit/6f430555495fa788347591c53c6770090a479211)
- [worktree notice](https://github.com/kdcokenny/opencode-worktree/commit/fdaae0eb5b6fbfdc7c9d58e75da7b52abf4738ac)
- [workspace notice](https://github.com/kdcokenny/opencode-workspace/commit/7b34c0711bfc371c2d94ccb856d81019150f01de)

GitHub readback confirmed the `Sync Facades` workflow is `disabled_manually` and all four repositories are archived. Tags, releases, package publications, and history were preserved. The workflow and sync map are removed from this PR. The shared credential was not revoked because its other consumers are unknown.

## PR review and CI

[PR #272](https://github.com/kdcokenny/ocx/pull/272) is open. The first CI pass found an obsolete assertion requiring the deleted facade sync workflow. That assertion was removed; the other workflow checks remain, and the full CLI suite passes again.

The commit-specific PR preview package was installed using npm into an isolated prefix. Profile creation/default selection, native version, and API health passed through its published executable. Fixture: `/tmp/ocx-preview-journey-jwi2_2mu`.

No tagged release or manual worker deployment was performed. The GitHub Actions preview workflow published the CLI package. Separately, the installed Mintlify and Cloudflare GitHub integrations published [documentation](https://kdco-kdcokenny-public-mammals-tease-i1kbm.mintlify.site/v2/overview), [KDCO registry](https://b3dfb1c8-kdco-registry.kdco.workers.dev/opencode-v2/index.json), and [legacy kit](https://e9371d05-ocx-kit.kdco.workers.dev/index.json) previews. Their successful `Mintlify Deployment` and `Workers Builds` checks are attached to PR #272; these integrations are configured outside `.github/workflows`. Cubic review cycles and checks for the current revision are tracked on [PR #272](https://github.com/kdcokenny/ocx/pull/272).

## Cubic review fixes

The full source review prompted fixes for credential forwarding during alias conflicts, overlapping source/build paths, journaled publication and profile moves, lock ownership, concurrent edits during rollback, destination identity checks, metadata editor locking/arguments, canonical removal resolution, schema input defaults and path patterns, preview deployment commands, and conformance cleanup. Recovery and credential regressions now have executable checks. The frozen-client probe restores fresh archives itself and runs in CI.

The built CLI manual journeys passed again after these fixes (`/tmp/ocx-manual-journeys-ofm2lvyx`). A separate manual editor check covered command arguments, a quoted path containing spaces, preservation of the default selection, and exclusion of a concurrent metadata writer (`/tmp/ocx-editor-manual-gdnhbq5a`). Native conformance passed again with the released 2.0.3 binary (`/tmp/ocx-native-probe-ZVcw9k`, `/tmp/ocx-instruction-probe-RsjkvI`), and the restored legacy-client probe passed (`/tmp/ocx-legacy-install-SnRNVk`). Findings about bare dependency qualification, fresh import directory creation, boolean environment values, and lock deadlocks were checked against existing code and successful probes rather than accepted automatically.

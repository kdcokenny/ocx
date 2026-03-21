# OCX CLI Phase 1: Baseline + Compatibility Tooling

This document defines the **Phase 1 contract and baseline workflow** for `packages/cli`.

Phase 1 intentionally does **not** change runtime behavior. It captures the current published surface in machine-checkable form so later phases can measure drift safely.

## Contract Scope

Contract manifest: `packages/cli/phase1/contract.manifest.json`

The manifest separates two categories:

1. **Supported contract** (compatibility commitments)
	- Bin resolution (`ocx`)
	- Main entrypoint and import specifier(s)
	- Runtime export names from manifest-declared import specifiers
	- Observed side-effect behavior for bare import (stdout/stderr)
	- CLI parity matrix (`stdout`, `stderr`, `exitCode`)

2. **Observed publish shape** (baseline-only, not guarantees)
	- Packed `package.json` metadata (`main`, `bin`, `files`, `exports`, `types`)
	- Required tarball entries
	- Disallowed stray files in tarball
	- Sourcemap publication (`dist/index.js.map`) classified as **observed only** (it may be present or omitted across releases)

## Tooling Commands

From `packages/cli`:

```bash
bun run phase1:pack
bun run phase1:inspect
bun run phase1:verify
bun run phase1:benchmark
bun run phase1:baseline
```

All commands operate on a freshly packed tarball from `npm pack --json`.

Implementation details of the tooling flow:

- Tarball inspection and extraction are handled in-process (no external `tar` binary required).
- Verify/benchmark execute against an isolated **installed-command sandbox** built from the packed tarball.
- The sandbox creates a temp install project and runs a real local install (`npm install <absolute-path-to-tarball>`), so `node_modules` layout and `node_modules/.bin` launcher generation come from the package manager.
- Windows launcher behavior is taken directly from the installed tarball (`node_modules/.bin/ocx.cmd`) rather than a handcrafted shim.
- CLI matrix verification and startup benchmarks execute `ocx` by command name with `PATH` prefixed to the sandbox `.bin` directory, so command resolution and installed entrypoint startup are part of the measured path.
- Package-name imports (for example `import("ocx")`) resolve from the same sandbox install root.
- The flow requires local `bun` + `npm` availability (`npm` for packing and local tarball install behavior, `bun` because the packed CLI entrypoint is Bun-targeted). If dependencies are not already cached, the `npm install` step may contact the npm registry.
- Portability note: the in-process tar reader is intentionally scoped to the `npm pack` archive shape used here. Verify/benchmark no longer depend on external tar tooling, but if future packed artifacts require unsupported tar header extensions, this script should be upgraded before broadening archive formats.

`phase1:baseline` runs the full sequence:

1. Build + pack tarball
2. Inspect tarball publish shape
3. Verify contract against packed artifact
4. Run cold-start benchmark against the **isolated installed `ocx` command from that packed tarball**

## Benchmark Protocol

`phase1:benchmark` (and `phase1:baseline`) uses this protocol:

- **Target artifact:** isolated installed `ocx` command from npm-installed local packed tarball (not workspace checkout)
- **Commands under test:**
	- `ocx --help`
	- `ocx --version`
	- `ocx search foo --cwd <clean-temp-project>`
- **Warmup runs per command:** 1
- **Measured runs per command:** 7
- **Cache/reset policy:**
	- one isolated npm-installed local tarball sandbox dedicated to benchmark execution
	- benchmark sandbox starts from a fresh install and does not reuse any verify/import preflight work
	- command invocation uses `PATH`-resolved `ocx` from sandbox `node_modules/.bin`
	- each sample is a new process launch
	- no privileged OS page-cache flush
- **Metric:** median of measured runs only (warmup excluded)
- **Behavioral guardrails:** every benchmark sample must match CLI matrix expectations for exit code and output checks; benchmark mode fails fast on behavioral regressions and does not emit a success artifact.

## Durable Outputs

Generated files (committed baseline artifacts):

- `packages/cli/phase1/baselines/publish-shape.latest.json`
- `packages/cli/phase1/baselines/contract-verification.latest.json`
- `packages/cli/phase1/baselines/startup-cold.latest.json`

These files include environment metadata (platform/arch/runtime versions). Treat metrics as **environment-scoped baselines**, not universal guarantees.

To reduce baseline churn, generated artifacts intentionally exclude capture timestamps and absolute local filesystem paths.

## How Later Phases Should Use Phase 1

- Run `bun run phase1:baseline` before and after behavior/perf changes.
- Keep the supported contract stable unless intentionally changed.
- If intentionally changing contract, update `contract.manifest.json` in the same change.
- Use publish-shape and startup files as regression baselines; compare medians and tarball metadata over time.

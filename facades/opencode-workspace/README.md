# opencode-workspace

Bundled multi-agent orchestration harness for OpenCode. One install, complete control.

## Quick Start

```bash
# One-time setup
ocx init --global

# Install the KDCO workspace profile (OpenCode Free Models Only)
ocx profile add ws --source tweak/p-1vp4xoqv --from https://tweakoc.com/r --global

# Launch
ocx oc -p ws
```

Need a custom profile? Open the KDCO Workspace harness in TweakOC: https://tweakoc.com/h/kdco-workspace

See the [full installation guide](../../docs/guides/kdco-workspace.mdx) for more customization options.

## What This Is

A **bundle** — a curated collection of 16 components that work together as a complete AI development harness. Installing `kdco/workspace` gives you:

- 4 plugins (delegation, planning, notifications, worktrees)
- 2 npm plugins (DCP, markdown table formatter)
- 3 MCP servers (Context7, Exa, GitHub Grep)
- 4 agents (researcher, coder, scribe, reviewer)
- 4 skills (plan protocol, code review, code philosophy, frontend philosophy)
- 1 command (/review)
- Orchestrator configurations for plan/build/explore agents
- Permission boundaries (webfetch deny, agent sandboxing)

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     ORCHESTRATORS                        │
│         ┌──────┐                    ┌───────┐            │
│         │ plan │                    │ build │            │
│         └──┬───┘                    └───┬───┘            │
└────────────┼────────────────────────────┼────────────────┘
             │                            │
     ┌───────┴───────┐            ┌───────┴───────┐
     ▼       ▼       ▼            ▼       ▼       ▼
┌─────────────────────────────────────────────────────────┐
│                      SPECIALISTS                        │
│  ┌─────────┐ ┌────────────┐ ┌───────┐ ┌──────┐ ┌──────┐ │
│  │ explore │ │ researcher │ │ coder │ │scribe│ │review│ │
│  └─────────┘ └────────────┘ └───────┘ └──────┘ └──────┘ │
└─────────────────────────────────────────────────────────┘
```

| Role          | Agents                                             |
| ------------- | -------------------------------------------------- |
| Orchestrators | `plan`, `build`                                    |
| Specialists   | `explore`, `researcher`, `coder`, `scribe`, `reviewer` |

## Components

| Category | Component           | Description                                  |
| -------- | ------------------- | -------------------------------------------- |
| Plugin   | workspace-plugin    | Plan management, agent rule injection        |
| Plugin   | background-agents   | Async delegation system                      |
| Plugin   | notify              | OS notifications on completion               |
| Plugin   | worktree            | Git worktree isolation                       |
| Plugin   | @tarquinen/opencode-dcp | Differential context protocol          |
| Plugin   | @franlol/opencode-md-table-formatter | Markdown table formatting |
| Skill    | plan-protocol       | Implementation planning guidelines           |
| Skill    | code-review         | Review methodology + severity classification |
| Skill    | code-philosophy     | Internal logic philosophy (5 Laws)           |
| Skill    | frontend-philosophy | Visual/UI philosophy (5 Pillars)             |
| Agent    | researcher          | External research (MCP tools, read-only)     |
| Agent    | coder               | Implementation (full file + bash)            |
| Agent    | scribe              | Documentation (write, no bash)               |
| Agent    | reviewer            | Code review (read-only + git)                |
| Command  | review              | `/review` slash command                      |
| Bundle   | philosophy          | Code + frontend philosophy skills            |
| MCP      | context7            | Library documentation lookup                 |
| MCP      | exa                 | Web search for external research             |
| MCP      | gh_grep             | GitHub code search                           |

## Permissions

The bundle configures security boundaries:

| Scope      | Setting                                                  |
| ---------- | -------------------------------------------------------- |
| Global     | `webfetch: deny` — no direct web fetching                |
| plan       | Read-only orchestrator, delegates via `task` tool        |
| build      | Read-only orchestrator, delegates via `task` tool        |
| explore    | Read-only specialist, filesystem + git inspection only   |
| researcher | Read-only, MCP tools only (Context7, Exa, GitHub Grep)   |
| coder      | Full file + bash access                                  |
| scribe     | File write only, no bash                                 |
| reviewer   | Read-only + git inspection                               |

## Advanced: Direct Install (No Profile)

```bash
ocx add kdco/workspace --from https://registry.kdco.dev
```

If you don't have OCX installed, install it from the [OCX repository](https://github.com/kdcokenny/ocx).

## Owning Your Code

Every file in this bundle is synced to this repository. Fork it, modify the agents, tune the skills, make it yours. That's the point of OCX.

## Contributing

This facade is maintained from the main [OCX monorepo](https://github.com/kdcokenny/ocx).

If you want to update opencode-workspace itself, start here:

- https://github.com/kdcokenny/ocx/blob/main/workers/kdco-registry/files/plugins/workspace-plugin.ts
- https://github.com/kdcokenny/ocx/tree/main/workers/kdco-registry/files

- Open issues here: https://github.com/kdcokenny/ocx/issues/new
- Open pull requests here: https://github.com/kdcokenny/ocx/compare
- Please do **not** open issues or PRs in this facade repository.

## Disclaimer

This project is not built by the OpenCode team and is not affiliated with [OpenCode](https://github.com/sst/opencode) in any way.

## License

MIT

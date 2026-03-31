# opencode-background-agents

> Keep working while research runs in the background. Your work survives context compaction.

A plugin for [OpenCode](https://github.com/sst/opencode) that enables async background delegation. Fire off research tasks, continue brainstorming or coding, and retrieve results when you need them.

## Why This Exists

Context windows fill up. When that happens, compaction kicks in and your AI loses track of research it just did. You end up re-explaining, re-researching, starting over.

Background agents solve this:

- **Keep working** - Delegate research and continue your conversation. Brainstorm, code review, discuss architecture - you're not blocked waiting.
- **Survive compaction** - Results are saved to disk as markdown. When context gets tight, the AI knows exactly where to retrieve past research.
- **Fire and forget** - Use the "waiter model": you don't follow the waiter to the kitchen. A notification arrives when your order is ready.

## Installation

```bash
ocx add kdco/background-agents --from https://registry.kdco.dev
```

If you don't have OCX installed, install it from the [OCX repository](https://github.com/kdcokenny/ocx).

**Optional:** Install `kdco-workspace` for the full experience—it bundles background agents with specialist agents, planning tools, and research protocols:

```bash
ocx add kdco/workspace --from https://registry.kdco.dev
```

## How It Works

```
1. Delegate    →  "Research OAuth2 PKCE best practices"
2. Continue    →  Keep coding, brainstorming, reviewing
3. Notified    →  <task-notification> arrives on terminal state
4. Retrieve    →  AI calls delegation_read() to get the result
```

Results are persisted to `~/.local/share/opencode/delegations/` as markdown files. Each delegation is automatically tagged with a title and summary, so the AI can scan past research and find what's relevant.

## Lifecycle Behavior

The plugin mirrors Claude Code-style background-agent lifecycle behavior as closely as possible inside OpenCode plugin boundaries:

- Stable delegation IDs are reused across state, artifact path, notifications, and retrieval.
- Explicit lifecycle transitions (`registered` → `running` → terminal).
- Terminal-state protection (late progress events cannot regress terminal status).
- Persistence occurs before terminal notification delivery.
- `delegation_read(id)` blocks until terminal/timeout and returns deterministic terminal info with persisted fallback.
- Compaction carries forward running and unread completed delegation context with retrieval hints.

## Usage

The plugin adds three tools:

| Tool | Purpose |
|------|---------|
| `delegate(prompt, agent)` | Launch a background task |
| `delegation_read(id)` | Retrieve a specific result |
| `delegation_list()` | List all delegations with titles and summaries |

## Limitations

### Read-Only Sub-Agents Only

Only read-only sub-agents (permissions: `edit=deny`, `write=deny`, `bash={"*":"deny"}`) can use `delegate`.
Any write-capable sub-agent (any write/edit/bash allow) must use the native `task` tool.

**Why?** Background delegations run in isolated sessions outside OpenCode's session tree. The undo/branching system cannot track changes made in background sessions—reverting would not affect these changes, risking unexpected data loss.

> A workaround is being explored.

### Timeout

Delegations timeout after **15 minutes**.

### Upstream Parity Boundaries

This is plugin-compatible lifecycle parity, not runtime-internal parity. It does not replicate:

- Claude/OpenCode internal AppState/task queue internals
- runtime notification priority controls
- write-capable background execution with native undo/branching parity

Write-capable sub-agents should continue to use native `task`.

### Real-Time Monitoring

View active and completed sub-agents using OpenCode's navigation shortcuts:

| Shortcut | Action |
|----------|--------|
| `Ctrl+X Up` | Jump to parent session |
| `Ctrl+X Left` | Previous sub-agent |
| `Ctrl+X Right` | Next sub-agent |

## FAQ

### How does the AI know what each delegation contains?

Each delegation is automatically tagged with a title and summary when it completes. When the AI calls `delegation_list()`, it sees all past research with descriptions - not just opaque IDs. This lets it scan for relevant prior work and retrieve exactly what it needs.

### Does this persist after the session ends?

Results are saved to disk and survive context compaction, session restarts, and process crashes. Within a session, the AI can retrieve any past delegation. New sessions start fresh but the files remain on disk.

### Does this bloat my context?

The opposite - it *saves* context. Heavy research runs in a separate sub-agent session. Only the distilled result comes back to your main conversation when you call `delegation_read()`.

### How is this different from Claude Code's Task tool?

Claude's native task tool runs sub-agents but results can be lost when context compacts. This plugin adds a persistence layer - results are written to markdown files, so the AI always knows where to find them.

### Why install via OCX?

One command, auto-configured, registry-backed updates. You could copy the files manually, but you'd need to handle dependencies (`unique-names-generator`) and updates yourself.

## Manual Installation

If you prefer not to use OCX, copy the source files from [`src/`](./src) to `.opencode/plugin/background-agents.ts`.

**Caveats:**
- Manually install dependencies (`unique-names-generator`)
- Updates require manual re-copying

## Part of the OCX Ecosystem

This plugin is part of the [KDCO Registry](https://github.com/kdcokenny/ocx/tree/main/registry/src/kdco). For the full experience, check out [kdco-workspace](https://github.com/kdcokenny/ocx) which bundles background agents with specialist agents, planning tools, and notification support.

## Contributing

This facade is maintained from the main [OCX monorepo](https://github.com/kdcokenny/ocx).

If you want to update opencode-background-agents itself, start here:

- https://github.com/kdcokenny/ocx/blob/main/workers/kdco-registry/files/plugins/background-agents.ts

- Open issues here: https://github.com/kdcokenny/ocx/issues/new
- Open pull requests here: https://github.com/kdcokenny/ocx/compare
- Please do **not** open issues or PRs in this facade repository.

## Disclaimer

This project is not built by the OpenCode team and is not affiliated with [OpenCode](https://github.com/sst/opencode) in any way.

## License

MIT

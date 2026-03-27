# opencode-notify

> Native OS notifications for OpenCode.

A plugin for [OpenCode](https://github.com/sst/opencode) that delivers Native OS notifications when tasks complete, errors occur, or the AI needs your input. It uses native OS notification delivery on macOS, Windows, and Linux, with an additional [cmux](https://www.cmux.dev/)-native path when available.

## Why This Exists

You delegate a task and switch to another window. Now you're checking back every 30 seconds. Did it finish? Did it error? Is it waiting for permission?

This plugin solves that:

- **Stay focused** - Work in other apps. A notification arrives when the AI needs you.
- **Native OS notifications first** - Uses macOS Notification Center, Windows Toast, or Linux notify-send via `node-notifier`.
- **Smart defaults** - Won't spam you. Only notifies for meaningful events, with parent-session filtering and quiet-hours support.
- **Additional [cmux](https://www.cmux.dev/)-native path** - When running in [cmux](https://www.cmux.dev/), can route through `cmux notify` and still falls back safely to desktop notifications.

## Installation

```bash
ocx add kdco/notify --from https://registry.kdco.dev
```

If you don't have OCX installed, install it from the [OCX repository](https://github.com/kdcokenny/ocx).

**Optional:** Get everything at once with `kdco-workspace`:

```bash
ocx add kdco/workspace --from https://registry.kdco.dev
```

## How It Works

> "Notify the human when the AI needs them back, not for every micro-event."

| Event | Notifies? | Sound | Why |
|-------|-----------|-------|-----|
| Session complete | Yes | Glass | Main task done - time to review |
| Session error | Yes | Basso | Something broke - needs attention |
| Permission needed | Yes | Submarine | AI is blocked, waiting for you |
| Question asked | Yes | Submarine (default) | Questions should always reach you promptly |
| Sub-task complete / error | No (default) | - | Set `notifyChildSessions: true` to include child-session `session.idle` and `session.error` events |

The plugin automatically:
1. Detects your terminal emulator (supports 37+ terminals)
2. Suppresses `session.idle`, `session.error`, and `permission.updated` notifications when your terminal is focused on macOS
3. Enables click-to-focus on macOS (click notification → terminal foregrounds)

Question notifications intentionally bypass macOS focus suppression so direct prompts are not missed.

## Native OS Notification Paths

By default, notifications go through the native OS desktop notification path:

- **macOS:** Notification Center (`terminal-notifier` backend)
- **Windows:** Toast notifications (`SnoreToast` backend)
- **Linux:** `notify-send`

### Additional [cmux](https://www.cmux.dev/)-native path

When running inside [cmux](https://www.cmux.dev/) (with `CMUX_WORKSPACE_ID` set), the plugin can also send notifications via [cmux](https://www.cmux.dev/):

```bash
cmux notify --title "..." --subtitle "..." --body "..."
```

If [cmux](https://www.cmux.dev/) is unavailable or invocation fails, notifications automatically fall back to the existing `node-notifier` desktop behavior.

## Platform Support

| Feature | macOS | Windows | Linux |
|---------|-------|---------|-------|
| Native OS notifications | Yes | Yes | Yes |
| Custom sounds | Yes | No | No |
| Focus detection | Yes | No | No |
| Click-to-focus | Yes | No | No |
| Terminal detection | Yes | Yes | Yes |

## Configuration (Optional)

Works out of the box. To customize, create `~/.config/opencode/kdco-notify.json`:

```json
{
  "notifyChildSessions": false,
  "terminal": "ghostty",
  "sounds": {
    "idle": "Glass",
    "error": "Basso",
    "permission": "Submarine",
    "question": "Submarine"
  },
  "quietHours": {
    "enabled": false,
    "start": "22:00",
    "end": "08:00"
  }
}
```

Configuration keys:

- `notifyChildSessions` (default `false`): when `true`, include child/sub-session `session.idle` and `session.error` notifications (question and permission notifications are unaffected).
- `terminal` (optional): override terminal auto-detection.
- `sounds`: per-event sounds (`idle`, `error`, `permission`, optional `question`).
- `quietHours`: scheduled suppression window.

**Available macOS sounds:** Basso, Blow, Bottle, Frog, Funk, Glass, Hero, Morse, Ping, Pop, Purr, Sosumi, Submarine, Tink

## FAQ

### Does this add bloat to my context?

Minimal footprint. The plugin is event-driven - it listens for session events and fires notifications. No tools are added to your conversation, no prompts are injected beyond initial setup.

### Will I get spammed with notifications?

No. Smart defaults prevent noise:
- Only notifies for parent sessions (not every sub-task)
- Supports quiet-hours suppression
- Suppresses when your terminal is the active window on macOS (except direct question notifications)

### Can I disable it temporarily?

This plugin does not currently expose an `enabled` config flag. To disable notifications, remove/uninstall the plugin (for example: `ocx remove kdco/notify`) and add it back when needed.

## Supported Terminals

Uses [`detect-terminal`](https://github.com/jonschlinkert/detect-terminal) to automatically identify your terminal. Supports 37+ terminals including:

Ghostty, Kitty, iTerm2, WezTerm, Alacritty, Hyper, Terminal.app, Windows Terminal, VS Code integrated terminal, and many more.

## Manual Installation

If you prefer not to use OCX, copy the plugin files into `.opencode/plugins/` and preserve the multi-file layout:

- `.opencode/plugins/notify.ts`
- `.opencode/plugins/notify/backend.ts`
- `.opencode/plugins/notify/cmux.ts`
- `.opencode/plugins/kdco-primitives/types.ts`
- `.opencode/plugins/kdco-primitives/with-timeout.ts`

**Caveats:**
- Manually install dependencies (`node-notifier`, `detect-terminal`)
- Install [cmux](https://www.cmux.dev/) if you want the additional [cmux](https://www.cmux.dev/)-native notification path
- Updates require manual re-copying

## Part of the OCX Ecosystem

This plugin is part of the [KDCO Registry](https://github.com/kdcokenny/ocx/tree/main/registry/src/kdco). For the full experience, check out [kdco-workspace](https://github.com/kdcokenny/ocx) which bundles notifications with background agents, specialist agents, and planning tools.

## Contributing

This facade is maintained from the main [OCX monorepo](https://github.com/kdcokenny/ocx).

If you want to update opencode-notify itself, start here:

- https://github.com/kdcokenny/ocx/blob/main/workers/kdco-registry/files/plugins/notify.ts

- Open issues here: https://github.com/kdcokenny/ocx/issues/new
- Open pull requests here: https://github.com/kdcokenny/ocx/compare
- Please do **not** open issues or PRs in this facade repository.

## Disclaimer

This project is not built by the OpenCode team and is not affiliated with [OpenCode](https://github.com/sst/opencode) in any way.

## License

MIT

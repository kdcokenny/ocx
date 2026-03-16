# opencode-notify

> Know when your AI needs you back. Native OS notifications for OpenCode.

A plugin for [OpenCode](https://github.com/sst/opencode) that delivers native desktop notifications when tasks complete, errors occur, or the AI needs your input. Stop tab-switching to check if it's done.

## Why This Exists

You delegate a task and switch to another window. Now you're checking back every 30 seconds. Did it finish? Did it error? Is it waiting for permission?

This plugin solves that:

- **Stay focused** - Work in other apps. A notification arrives when the AI needs you.
- **Native feel** - Uses `cmux notify` inside cmux, otherwise macOS Notification Center, Windows Toast, or Linux notify-send.
- **Smart defaults** - Won't spam you. Only notifies for meaningful events, and only when you're not already looking at the terminal.

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
| Sub-task complete | No | - | Parent session handles orchestration |

The plugin automatically:
1. Detects your terminal emulator (supports 37+ terminals)
2. Suppresses notifications when your terminal is focused
3. Enables click-to-focus on macOS (click notification → terminal foregrounds)

## cmux Support

When running inside cmux (with `CMUX_WORKSPACE_ID` set), the plugin prefers native cmux notifications via:

```bash
cmux notify --title "..." --subtitle "..." --body "..."
```

If cmux is unavailable or invocation fails, notifications automatically fall back to the existing `node-notifier` desktop behavior.

## Platform Support

| Feature | macOS | Windows | Linux |
|---------|-------|---------|-------|
| Native notifications | Yes | Yes | Yes |
| Custom sounds | Yes | No | No |
| Focus detection | Yes | No | No |
| Click-to-focus | Yes | No | No |
| Terminal detection | Yes | Yes | Yes |

## Configuration (Optional)

Works out of the box. To customize, create `~/.config/opencode/kdco-notify.json`:

```json
{
  "enabled": true,
  "notifyChildSessions": false,
  "suppressWhenFocused": true,
  "sounds": {
    "idle": "Glass",
    "error": "Basso",
    "permission": "Submarine"
  }
}
```

**Available macOS sounds:** Basso, Blow, Bottle, Frog, Funk, Glass, Hero, Morse, Ping, Pop, Purr, Sosumi, Submarine, Tink

## FAQ

### Does this add bloat to my context?

Minimal footprint. The plugin is event-driven - it listens for session events and fires notifications. No tools are added to your conversation, no prompts are injected beyond initial setup.

### Will I get spammed with notifications?

No. Smart defaults prevent noise:
- Only notifies for parent sessions (not every sub-task)
- Suppresses when your terminal is the active window
- Batches notifications when multiple delegations complete together

### Can I disable it temporarily?

Set `"enabled": false` in the config file, or delete the config to return to defaults.

## Supported Terminals

Uses [`detect-terminal`](https://github.com/jonschlinkert/detect-terminal) to automatically identify your terminal. Supports 37+ terminals including:

Ghostty, Kitty, iTerm2, WezTerm, Alacritty, Hyper, Terminal.app, Windows Terminal, VS Code integrated terminal, and many more.

## Manual Installation

If you prefer not to use OCX, copy the source from [`src/`](./src) to `.opencode/plugin/`.

**Caveats:**
- Manually install dependencies (`node-notifier`, `detect-terminal`)
- Install `cmux` if you want native cmux notifications
- Updates require manual re-copying

## Part of the OCX Ecosystem

This plugin is part of the [KDCO Registry](https://github.com/kdcokenny/ocx/tree/main/registry/src/kdco). For the full experience, check out [kdco-workspace](https://github.com/kdcokenny/ocx) which bundles notifications with background agents, specialist agents, and planning tools.

## Disclaimer

This project is not built by the OpenCode team and is not affiliated with [OpenCode](https://github.com/sst/opencode) in any way.

## License

MIT

> **Frozen V1 reference.** This document is preserved from [OCX `e79df6f`](https://github.com/kdcokenny/ocx/blob/e79df6f/workers/ocx-kit/files/profiles/omo/README.md). Its tool names, models, APIs, and installation instructions describe OpenCode V1. For the supported V2 setup, see the [OCX 3 documentation](https://ocx.kdco.dev/v2/overview).

# OMO Starter Profile

This profile uses [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) with [OpenCode Zen](https://opencode.ai/docs/zen/) models.

## Models

- **DeepSeek V4 Flash Free**: primary model for OMO agents and deep categories
- **Nemotron 3 Super Free**: small model, quick tasks, writing, and search helpers
- **Big Pickle**: fallback model for orchestration and compatibility

The profile includes all current upstream OMO agents: Sisyphus, Hephaestus, Prometheus, Oracle, Librarian, Explore, Multimodal-Looker, Metis, Momus, Atlas, and Sisyphus-Junior.

## Customization

Edit `~/.config/opencode/profiles/omo/oh-my-openagent.jsonc` to change models.

See available models: `opencode models`

Full docs: https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/reference/configuration.md

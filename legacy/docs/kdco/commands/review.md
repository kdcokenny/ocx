---
description: Run code review on files or recent changes
---

> **Frozen V1 reference.** This document is preserved from [OCX `e79df6f`](https://github.com/kdcokenny/ocx/blob/e79df6f/workers/kdco-registry/files/commands/review.md). Its tool names, models, APIs, and installation instructions describe OpenCode V1. For the supported V2 setup, see the [OCX 3 documentation](https://ocx.kdco.dev/v2/overview).

Delegate to the `reviewer` agent to perform a code review.

**Scope:** $ARGUMENTS

If no arguments provided, review staged changes using `git diff --cached`.
If argument is "recent", review changes since last commit using `git diff HEAD~1`.
Otherwise, review the specified file(s) or directory.

The reviewer agent will:
- Load the code-review skill
- Apply the 4 Review Layers (Correctness, Security, Performance, Style)
- Classify findings by severity (Critical, Major, Minor, Nitpick)
- Only report findings with >=80% confidence
- Include positive observations
- Provide Philosophy Compliance checklist results

Return the complete review findings to the user.

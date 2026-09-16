---
name: code-review
description: Review a change for concrete correctness issues, regressions, and missing validation.
---

Read the complete changed behavior and its callers. Identify the trigger, affected path, and user-visible consequence before reporting a finding. Prefer reproducible evidence over hypothetical concerns.

Check error paths, ownership of persisted data, compatibility contracts, and the tests that exercise the behavior. Distinguish a demonstrated defect from a question or an optional improvement.

Report actionable findings with a concise explanation and a source location. State the checks you ran and any limits of the review. If no actionable defect is found, say so directly.

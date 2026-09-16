> **Frozen V1 reference.** This document is preserved from [OCX `e79df6f`](https://github.com/kdcokenny/ocx/blob/e79df6f/workers/kdco-registry/files/tools/philosophy.md). Its tool names, models, APIs, and installation instructions describe OpenCode V1. For the supported V2 setup, see the [OCX 3 documentation](https://ocx.kdco.dev/v2/overview).

## Code Philosophy - MANDATORY

Before writing or modifying any code, you MUST:

1. **Select the relevant philosophy** based on your task:
   - Working on UI/frontend? → Load **`frontend-philosophy`** (The 5 Pillars of Intentional UI)
   - Working on backend/logic? → Load **`code-philosophy`** (The 5 Laws of Elegant Defense)
   - Working on both? → Load both

2. **Load the skill** using the `skill` tool BEFORE implementation

3. **Verify your implementation** against the philosophy checklist BEFORE completing

4. **Refactor if needed** - if code violates any principle, fix it before proceeding

This is NOT optional. These philosophies define how code must be written in this project.

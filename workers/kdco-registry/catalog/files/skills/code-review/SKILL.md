---
name: code-review
description: Review a change for concrete correctness issues, regressions, and missing validation.
---

# Code review

Use this skill when asked to review a diff, commit, pull request, or a focused code change. Assess the behavior introduced by the change and report findings the author can act on.

## Establish the scope

1. Read the requested diff and the project's contribution and testing guidance.
2. Identify changed entry points, callers, stored data, and external contracts.
3. Read enough surrounding code to distinguish a new regression from existing behavior.
4. Note the intended behavior and any acceptance criteria. Ask for missing context only when it materially affects the review.

Do not expand a focused review into unrelated refactoring. Check an apparent defect against its real callers before reporting it.

## Review in four layers

### 1. Correctness

- Trace normal, empty, malformed, and boundary inputs through the changed behavior.
- Check ordering, asynchronous work, cancellation, retries, and concurrency where relevant.
- Follow errors through cleanup and recovery. Confirm a failed operation leaves persisted data usable.
- Check compatibility with existing files, callers, and supported platforms.
- Compare tests with the behavior users rely on, including failure paths.

### 2. Security and trust boundaries

- Identify where external data enters a path, command, query, template, or privileged operation.
- Check authorization at the operation that reads or changes protected data.
- Follow secrets through logs, errors, generated files, and outbound requests.
- Check that path handling and ownership checks also apply to recovery and cleanup.
- Report a security issue only with a credible source, reachable operation, and consequence.

### 3. Performance and resource use

- Look for repeated work, unbounded reads, unnecessary network requests, and missing cleanup.
- Relate complexity to realistic input sizes and call frequency.
- Check that limits, timeouts, and cancellation apply to the operation they are intended to bound.
- Distinguish measured or traceable regressions from speculative optimization ideas.

### 4. Maintainability

- Check whether names and control flow make the changed contract understandable.
- Prefer boundary parsing, explicit states, and predictable operations over scattered checks.
- Look for duplicate logic that can drift across runtime paths.
- Identify misleading documentation or tests that would conceal a behavioral mistake.
- Follow the project's established style; do not report personal formatting preferences as defects.

## Evidence and confidence

For each candidate finding, establish:

1. **Trigger:** the input, state, or sequence that reaches the problem.
2. **Path:** the changed code and relevant callers or downstream operations.
3. **Consequence:** what fails, which data is affected, or what the user observes.
4. **Evidence:** a reproducer, test result, or complete code trace supporting the claim.

Use the project's existing commands when practical. State whether a check actually ran; do not imply that inspection is execution. If a key assumption is unresolved, identify it as a question or limitation rather than a confirmed defect. Avoid assigning artificial confidence percentages.

## Severity

| Severity | Use when |
| --- | --- |
| Critical | A reachable change causes broad compromise, destructive data loss, or an equivalent release-blocking failure. |
| Major | A supported workflow produces incorrect behavior or fails under a realistic condition. |
| Minor | A bounded defect has a limited effect or a reasonable workaround. |
| Suggestion | An optional improvement with no demonstrated defect. Keep separate from findings. |

Calibrate severity to impact and reachability. A theoretical worst case alone does not establish urgency.

## Reporting

Lead with actionable findings, highest severity first. Each finding should include:

- A concise title describing the defect.
- A file and line reference to the smallest useful location.
- The trigger and consequence in plain language.
- Evidence and any condition required for the problem to occur.
- A proposed correction when it is clear, without prescribing unnecessary refactoring.

Example:

> **Major — Preserve the original file when replacement fails** (`src/store.ts:84`)
> If the temporary file cannot be renamed, this path has already removed the
> user's original. A failed save therefore loses the previous contents. Keep
> the original until publication succeeds and restore it on failure.

Finish with the validation performed and meaningful limits of the review. If no actionable defect was found, say so directly. Do not invent findings or praise to fill a template, and do not call an untested change fully verified.

## Before returning the review

- [ ] Read the changed behavior and relevant callers, not only the diff fragments.
- [ ] Check success, failure, and recovery paths appropriate to the change.
- [ ] Confirm each finding is caused by or exposed by the reviewed change.
- [ ] Give each finding a concrete trigger, consequence, and source location.
- [ ] Separate confirmed defects, unresolved questions, and optional suggestions.
- [ ] Report checks that ran, their results, and remaining uncertainty.

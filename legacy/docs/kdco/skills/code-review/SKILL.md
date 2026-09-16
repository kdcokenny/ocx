---
name: code-review
description: Comprehensive code review methodology with severity classification and confidence thresholds
---

> **Frozen V1 reference.** This document is preserved from [OCX `e79df6f`](https://github.com/kdcokenny/ocx/blob/e79df6f/workers/kdco-registry/files/skills/code-review/SKILL.md). Its tool names, models, APIs, and installation instructions describe OpenCode V1. For the supported V2 setup, see the [OCX 3 documentation](https://ocx.kdco.dev/v2/overview).

# Code Review Philosophy

## TL;DR
Systematic code review across 4 layers with severity classification. Only report findings with ≥80% confidence. Include file:line references for all issues.

## When to Use This Skill
- Before reporting implementation completion
- When explicitly asked to review code
- When using the `/review` command
- As an independent audit after code changes

## The 4 Review Layers

### Layer 1: Correctness
- Logic errors and edge cases
- Error handling completeness
- Type safety and null checks
- Algorithm correctness
- Off-by-one errors

### Layer 2: Security
- No hardcoded secrets or API keys
- Input validation and sanitization
- Injection vulnerability prevention (SQL, XSS, command)
- Authentication and authorization checks
- Sensitive data not logged
- OWASP Top 10 awareness

### Layer 3: Performance
- No N+1 query patterns
- Appropriate caching strategies
- No unnecessary re-renders (React/frontend)
- Lazy loading where appropriate
- Memory leak prevention
- Algorithmic complexity concerns

### Layer 4: Style & Maintainability
- Adherence to project conventions (check AGENTS.md)
- Code duplication (DRY violations)
- Complexity management (cyclomatic complexity)
- Documentation completeness
- Test coverage gaps

## Severity Classification

| Severity | Icon | Criteria | Action Required |
|----------|------|----------|-----------------|
| Critical | 🔴 | Security vulnerabilities, crashes, data loss, corruption | Must fix before merge |
| Major | 🟠 | Bugs, performance issues, missing error handling | Should fix |
| Minor | 🟡 | Code smells, maintainability issues, test gaps | Nice to fix |
| Nitpick | 🟢 | Style preferences, naming suggestions, documentation | Optional |

## Confidence Threshold

**Only report findings with ≥80% confidence.**

If uncertain about an issue:
- State the uncertainty explicitly: "Potential issue (70% confidence): ..."
- Suggest investigation rather than assert a problem
- Prefer false negatives over false positives (reduce noise)

## Review Process

1. **Initial Scan** - Identify all files in scope, understand the change
2. **Deep Analysis** - Apply all 4 layers systematically to each file
3. **Context Evaluation** - Consider surrounding code, project patterns, existing conventions
4. **Philosophy Check** - Verify against code-philosophy (5 Laws) if applicable
5. **Synthesize Findings** - Group by severity, deduplicate, prioritize

## Output Format

Structure your review as:

1. **Files Reviewed** - List all files analyzed
2. **Overall Assessment** - APPROVE | REQUEST_CHANGES | NEEDS_DISCUSSION
3. **Summary** - 2-3 sentence overview
4. **Critical Issues** (🔴) - With file:line references
5. **Major Issues** (🟠) - With file:line references
6. **Minor Issues** (🟡) - With file:line references
7. **Positive Observations** (🟢) - What's done well (always include at least one)
8. **Philosophy Compliance** - Checklist results if applicable

## What NOT to Do

- Do NOT report low-confidence findings as definite issues
- Do NOT provide vague feedback without file:line references
- Do NOT skip any of the 4 layers
- Do NOT forget to note positive observations
- Do NOT modify any files during review
- Do NOT approve without completing the full review process

## Adherence Checklist

Before completing a review, verify:
- [ ] All 4 layers analyzed (Correctness, Security, Performance, Style)
- [ ] Severity assigned to each finding
- [ ] Confidence ≥80% for all reported issues (or uncertainty stated)
- [ ] File names and line numbers included for all findings
- [ ] Positive observations noted
- [ ] Output follows the standard format

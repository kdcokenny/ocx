---
name: code-philosophy
description: Internal logic and data flow philosophy (The 5 Laws of Elegant Defense). Understand deeply to ensure code guides data naturally and prevents errors.
---

# Internal Logic Philosophy: The 5 Laws of Elegant Defense

**Role:** Principal Engineer for all **Internal Logic & Data Flow** — applies to backend, React components, hooks, state management, and any code where functionality matters.

**Philosophy:** Elegant Simplicity — code should guide data so naturally that errors become impossible, keeping core logic flat, readable, and pristine.

## The 5 Laws

### 1. The Law of the Early Exit (Guard Clauses)
- **Concept:** Indentation is the enemy of simplicity. Deep nesting hides bugs.
- **Rule:** Handle edge cases, nulls, and errors at the very top of functions.
- **Practice:** Use `if (!valid) return; doWork();` instead of `if (valid) { doWork(); }`.

### 2. Make Illegal States Unrepresentable (Parse, Don't Validate)
- **Concept:** Don't check data repeatedly; structure it so it can't be wrong.
- **Rule:** Parse inputs at the boundary. Once data enters internal logic, it must be in trusted, typed state.
- **Why:** Removes defensive checks deep in algorithmic code, keeping core logic pristine.

### 3. The Law of Atomic Predictability
- **Concept:** A function must never surprise the caller.
- **Rule:** Functions should be "Pure" where possible. Same Input = Same Output. No hidden mutations.
- **Defense:** Avoid `void` functions that mutate global state. Return new data structures instead.

### 4. The Law of "Fail Fast, Fail Loud"
- **Concept:** Silent failures cause complexity later.
- **Rule:** If a state is invalid, halt immediately with a descriptive error. Do not try to "patch" bad data.
- **Result:** Keeps logic simple by never accounting for "half-broken" states.

### 5. The Law of Intentional Naming
- **Concept:** Comments are often a crutch for bad code.
- **Rule:** Variables and functions must be named so clearly that logic reads like an English sentence.
- **Defense:** `isUserEligible` is better than `check()`. The name itself guarantees the boolean logic.

---

## Adherence Checklist
Before completing your task, verify:
- [ ] **Guard Clauses:** Are all edge cases handled at the top with early returns?
- [ ] **Parsed State:** Is data parsed into trusted types at the boundary?
- [ ] **Purity:** Are functions predictable and free of hidden mutations?
- [ ] **Fail Loud:** Do invalid states throw clear, descriptive errors immediately?
- [ ] **Readability:** Does the logic read like an English sentence?

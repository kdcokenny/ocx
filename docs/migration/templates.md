# Page Templates

Standard templates for OCX Mintlify documentation pages.

## Template Types

1. **Concept** — Explain ideas, architecture, and principles
2. **Task** — Step-by-step procedures for users to follow
3. **Command Reference** — Detailed CLI command documentation

---

## Concept Page Template

Use for: Architecture explanations, design principles, feature overviews

````markdown
---
title: "Page Title"
description: "One-line description for SEO and previews"
---

## Overview

2-3 sentence introduction explaining what this concept is and why it matters.

## When to Use This

Bulleted list of scenarios where this concept applies:

- When you need to solve X problem
- When your project has Y characteristics
- When integrating with Z systems

## Core Concepts

### Concept 1 Name

Explanation of the first key concept. Use analogies where helpful.

```
[Diagram or code example if applicable]
```

### Concept 2 Name

Explanation of the second key concept.

## How It Works

1. **Step in process**: Brief explanation
2. **Next step**: Brief explanation
3. **Final step**: Brief explanation

## Trade-offs and Considerations

| Approach | Pros | Cons |
|----------|------|------|
| Option A | Benefit 1, Benefit 2 | Drawback 1 |
| Option B | Benefit 1 | Drawback 1, Drawback 2 |

## Related Concepts

- [Related Concept A](/section/concept-a)
- [Related Concept B](/section/concept-b)

## See Also

- [Task: How to do X](/guides/doing-x)
- [Reference: Configuration Options](/reference/config)
````

### Concept Page Checklist

- [ ] Title is clear and descriptive
- [ ] Description is under 160 characters
- [ ] Overview explains "what" and "why"
- [ ] Core concepts section breaks down key ideas
- [ ] Examples use OCX-specific terminology
- [ ] Trade-offs section presents balanced view
- [ ] Related links point to valid Mintlify paths

---

## Task Page Template

Use for: Tutorials, setup guides, how-to procedures

````markdown
---
title: "How to [Achieve Result]"
description: "Step-by-step guide to [achieving result] with OCX"
---

## Overview

What you will accomplish in this guide. 2-3 sentences maximum.

**Time to complete**: X minutes  
**Prerequisites**: [Prerequisite 1](/link), [Prerequisite 2](/link)

## Before You Begin

Checklist of prerequisites:

- [ ] Item 1 is complete
- [ ] Item 2 is installed/configured
- [ ] Item 3 is understood

## Step 1: [Action Name]

Brief explanation of what this step accomplishes.

```bash
# Command to run
ocx command --option value
```

Expected output or result:

```
Success message or output here
```

## Step 2: [Action Name]

Continue with next step...

<Tip>
Optional tip for making this step easier or avoiding common mistakes.
</Tip>

## Step 3: [Action Name]

Final step...

## Verify Your Setup

How to confirm everything worked:

```bash
ocx verify-command
```

You should see:

```
Expected verification output
```

## Next Steps

- [Advanced configuration](/section/advanced)
- [Related task](/guides/related-task)
- [Troubleshooting](/troubleshooting)

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Error message X | Do Y to fix |
| Unexpected behavior Z | Check W setting |
````

### Task Page Checklist

- [ ] Title starts with "How to" or action verb
- [ ] Time estimate is accurate
- [ ] Prerequisites are actual requirements (not nice-to-haves)
- [ ] Each step has clear action and expected result
- [ ] Commands are copy-paste ready
- [ ] Verification step confirms success
- [ ] Troubleshooting covers common issues

---

## Command Reference Template

Use for: CLI command documentation, API endpoints, configuration options

````markdown
---
title: "ocx [command]"
description: "Reference for the ocx [command] command"
---

## Usage

```bash
ocx [command] [subcommand] [arguments] [flags]
```

## Description

1-2 sentence description of what this command does.

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `arg1` | Yes | Description of first argument |
| `arg2` | No | Description of second argument |

## Flags

| Flag | Shorthand | Default | Description |
|------|-----------|---------|-------------|
| `--flag-name` | `-f` | `false` | What this flag does |
| `--output` | `-o` | `table` | Output format: table, json, yaml |

## Examples

### Basic Usage

```bash
ocx command required-arg
```

### With Options

```bash
ocx command arg --flag-name value
```

### Common Pattern

```bash
# Real-world example showing typical usage
ocx profile add my-profile --source kit/omo --from https://ocx-kit.kdco.dev --global
```

## Output

### Success

```json
{
  "status": "success",
  "data": {
    "field": "value"
  }
}
```

### Error

```json
{
  "status": "error",
  "code": "ERROR_CODE",
  "message": "Human-readable error description"
}
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Invalid arguments |

## See Also

- [Related command](/cli/related-command)
- [Concept: What this command manages](/section/concept)
````

### Command Reference Checklist

- [ ] Usage line shows all possible components
- [ ] Description focuses on behavior, not implementation
- [ ] Arguments table includes all positional args
- [ ] Flags table includes all options
- [ ] Examples progress from simple to complex
- [ ] Output examples show actual format (JSON, table, etc.)
- [ ] Exit codes documented if non-zero codes have meaning
- [ ] Related commands point to relevant other commands

---

## Style and Tone Constraints

### Voice Guidelines

| Do | Don't |
|----|-------|
| Use "you" to address the reader | Use "we" or "the user" |
| Write in present tense | Use future or past tense |
| Be specific and concrete | Use vague qualifiers ("very", "really") |
| Lead with the benefit | Lead with the feature name |
| Use active voice | Use passive voice |

### Terminology Standards

Use these terms consistently:

| Term | Meaning | Notes |
|------|---------|-------|
| Profile | User configuration for OpenCode | Not "config" or "settings" |
| Registry | Curated collection of profiles/components | Not "repository" or "store" |
| Component | Installable code snippet or configuration | Not "package" or "module" |
| CLI | Command-line interface | Spell out on first use |
| OCX | The tool itself | Always uppercase |

### Code Example Standards

- Use `bash` for shell commands
- Use `json` for configuration examples
- Use `typescript` for code samples
- Include comments explaining non-obvious parts
- Keep examples copy-paste ready
- Use realistic values (not `foo`, `bar`, `example.com`)

### Formatting Rules

- **Bold** for UI elements and important terms
- `code` for commands, filenames, and inline code
- [Links](/v2/overview) for internal references (use site-root paths starting with `/`)
- Tables for structured comparisons
- Bullet lists for unordered items
- Numbered lists for sequential steps

### Frontmatter Requirements

Every page must include:

```yaml
---
title: "Page Title in Title Case"
description: "SEO description under 160 characters"
---
```

Optional frontmatter:

```yaml
---
title: "Page Title"
description: "Description"
icon: "terminal"        # For navigation icons
sidebarTitle: "Short"   # If title is too long for sidebar
---
```

### Accessibility Considerations

- Alt text for all images: `![Descriptive text](path)`
- Table headers clearly describe content
- Code blocks have language specified
- Link text is descriptive (not "click here")
- Heading hierarchy is maintained (no skipping levels)

### Review Checklist

Before submitting any documentation page:

- [ ] Follows appropriate template structure
- [ ] Title case used for titles (AP style)
- [ ] No spelling or grammar errors
- [ ] All code examples tested and working
- [ ] All internal links are valid
- [ ] Images have alt text
- [ ] Tables have headers
- [ ] Tone is consistent with other pages
- [ ] Terminology matches standards

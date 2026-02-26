# Data Validation Skill

## Overview

This skill provides utilities and patterns for validating data inputs, ensuring type safety, and maintaining data integrity throughout your application.

## Validation Strategies

### Type Validation

Use TypeScript's type system combined with runtime validation libraries like Zod for comprehensive type safety.

```typescript
import { z } from "zod"

const userSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  age: z.number().min(0).max(150)
})

type User = z.infer<typeof userSchema>
```

### Input Sanitization

Always sanitize user inputs to prevent security vulnerabilities:

- Trim whitespace from strings
- Escape special characters in HTML contexts
- Validate against allowed character sets
- Check input length limits

### Boundary Validation

Test edge cases and boundary conditions:

- Minimum and maximum values
- Empty collections
- Null and undefined handling
- Special characters and unicode

## Common Patterns

### Schema-Based Validation

Define schemas once and reuse them across your codebase for consistency.

### Early Validation

Validate data at system boundaries (API endpoints, form submissions) rather than deep in business logic.

### Descriptive Errors

Provide clear, actionable error messages that help users understand what went wrong and how to fix it.

# Coding Standards Skill Guide

## Overview

This skill provides guidelines for writing clean, maintainable code that follows industry best practices. The standards are designed to improve code quality, readability, and team collaboration.

## Key Principles

### 1. Code Clarity

Write code that is self-documenting and easy to understand. Use descriptive variable and function names that clearly convey their purpose.

**Good:**
```typescript
function calculateUserAge(birthDate: Date): number {
  const today = new Date()
  return today.getFullYear() - birthDate.getFullYear()
}
```

**Bad:**
```typescript
function calc(d: Date): number {
  const t = new Date()
  return t.getFullYear() - d.getFullYear()
}
```

### 2. Consistency

Maintain consistent formatting, naming conventions, and code structure throughout your codebase. Use automated formatters and linters to enforce standards.

### 3. Testing

Write comprehensive tests for all critical functionality. Aim for high test coverage while focusing on meaningful test cases that validate actual business logic.

### 4. Documentation

Document complex algorithms, non-obvious design decisions, and public APIs. Avoid over-documenting obvious code.

## Best Practices

- Keep functions small and focused on a single responsibility
- Use meaningful commit messages that explain the "why" behind changes
- Review code regularly and provide constructive feedback
- Refactor proactively to prevent technical debt accumulation

## Resources

- [Clean Code by Robert Martin](https://www.example.com/clean-code)
- [Code Complete by Steve McConnell](https://www.example.com/code-complete)

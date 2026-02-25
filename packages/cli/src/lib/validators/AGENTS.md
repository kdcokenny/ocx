# Registry Validation System

OCX uses a unified validation architecture that ensures consistent checking across both `ocx build` and `ocx validate` commands. All validation logic is centralized in this `validators/` module.

## Validation Checks

The validation system performs four types of checks:

### 1. Schema Validation
- **What:** Validates `registry.jsonc` structure against the Zod schema
- **Checks:** Required fields, types, formats, component names, dependency references
- **When:** Always first (required for subsequent checks)
- **Result:** Errors (blocking)
- **Commands:** build, validate

### 2. File Existence
- **What:** Verifies all source files referenced in `registry.jsonc` exist
- **Checks:** Files in `<source>/files/<path>` directory
- **When:** After schema validation passes
- **Result:** Errors (blocking)
- **Commands:** build, validate

### 3. Circular Dependencies
- **What:** Detects dependency cycles within the same namespace
- **Checks:** A → B → C → A patterns (skips cross-namespace deps)
- **When:** After schema validation passes
- **Result:** Errors (blocking)
- **Commands:** build, validate
- **Algorithm:** Depth-first search with visiting/visited sets

### 4. Duplicate File Targets
- **What:** Detects when multiple components install to the same target path
- **Checks:** Overlapping `file.target` values across components
- **When:** After schema validation passes
- **Result:** Warnings (non-blocking, unless `--no-duplicate-targets` flag)
- **Commands:** build (warning), validate (warning or error)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ validators/index.ts                                         │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ validateSchema(data)                                    │ │
│ │ → SchemaValidationResult { errors }                     │ │
│ └─────────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ validateFileExistence(registry, sourcePath)             │ │
│ │ → FileExistenceValidationResult { errors, filesCount }  │ │
│ └─────────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ detectCircularDependencies(registry)                    │ │
│ │ → CircularDependencyValidationResult { errors }         │ │
│ └─────────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ detectDuplicateTargets(registry)                        │ │
│ │ → DuplicateTargetValidationResult { warnings }          │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │
                              │ composed by
                              │
┌─────────────────────────────────────────────────────────────┐
│ validators/run-validation.ts                                │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ runValidation(sourcePath, options?)                     │ │
│ │ → ValidationResult { valid, errors, warnings, stats }   │ │
│ │                                                          │ │
│ │ Options:                                                │ │
│ │   skipCircularDeps?: boolean                            │ │
│ │   skipDuplicateTargets?: boolean                        │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │
                ┌─────────────┴─────────────┐
                │                           │
     ┌──────────▼───────────┐    ┌─────────▼──────────┐
     │ buildRegistry()      │    │ validateCommand()  │
     │ commands/build.ts    │    │ commands/validate  │
     └──────────────────────┘    └────────────────────┘
```

## Validator Functions

Each validator is a pure function that:
- Accepts registry data and context (e.g., sourcePath)
- Returns a partial `ValidationResult` (errors and/or warnings)
- Is independent and composable
- Can be unit tested in isolation

**Location:** `validators/index.ts`

## Validation Runner

The `runValidation()` function orchestrates all validators:
- Runs validators in sequence (schema → files → circular deps → duplicates)
- Short-circuits on schema failure (can't proceed without valid schema)
- Supports skip options for selective validation
- Aggregates results into a unified `ValidationResult`

**Location:** `validators/run-validation.ts`

## Command Integration

### Build Command
```typescript
// packages/cli/src/commands/build.ts
const validationResult = await runValidation(sourcePath)
if (!validationResult.valid) {
  throw new BuildRegistryError("Validation failed", validationResult)
}
// Proceed with build...
```

**With --show-validation flag:**
- Shows validation output before building
- Exits early if validation fails
- Continues without prompt if warnings only

### Validate Command
```typescript
// packages/cli/src/commands/validate.ts (conceptual)
const validationResult = await runValidation(sourcePath)
console.log(formatValidationResult(validationResult))
process.exit(validationResult.valid ? 0 : 1)
```

**With --strict flag:**
- Treats warnings as errors
- Exits with code 1 if any warnings present

**With --no-duplicate-targets flag:**
- Treats duplicate target warnings as errors

## Error Result Types

Both build and validate use the same `ValidationResult` type:

```typescript
interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
  warnings: ValidationWarning[]
  stats: {
    componentsCount: number
    filesCount: number
  }
  metadata?: {
    name: string
    namespace: string
    version: string
    author: string
  }
}
```

**BuildRegistryError** carries a `ValidationResult` for consistent error formatting:

```typescript
class BuildRegistryError extends Error {
  public readonly validationResult?: ValidationResult
  // ...
}
```

## Testing Strategy

**Unit Tests:** Each validator function has isolated unit tests
- `packages/cli/tests/validators.test.ts` (20 tests)
- Test individual validators with fixtures
- Test `runValidation()` orchestration and skip options

**Integration Tests:** Commands test full validation flow
- `packages/cli/tests/build.test.ts` (14 tests)
- `packages/cli/tests/validate.test.ts`
- Test error handling, output formatting, exit codes

**Regression Tests:** Ensure existing behavior unchanged
- Validate command tests ensure no behavior changes
- Build command tests verify new checks don't break existing workflows

## Key Files

| File | Purpose |
|------|---------|
| `index.ts` | Individual validator functions |
| `run-validation.ts` | Validation orchestrator |
| `../validate-registry-local.ts` | Uses validators via runValidation |
| `../build-registry.ts` | Runs validation before building |
| `../validate-registry-types.ts` | Type definitions |
| `../format-validation-result.ts` | Human-readable output formatter |
| `../../commands/build.ts` | Build command with --show-validation flag |
| `../../commands/validate.ts` | Validate command |
| `../../../tests/validators.test.ts` | Validator unit tests |
| `../../../tests/build.test.ts` | Build command integration tests |

## Best Practices

1. **Always validate before build:** The build command automatically validates
2. **Use --show-validation flag:** For debugging and CI/CD visibility
3. **Fix all errors:** Build will fail if any errors present
4. **Review warnings:** Even if build succeeds, warnings indicate potential issues
5. **Use --strict in CI/CD:** Treat warnings as errors in automated pipelines
6. **Test validators in isolation:** Unit test each validator separately
7. **Keep validators pure:** No side effects, just input → output

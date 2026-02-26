# Multi-Level Test Agent

## Description

This agent tests dependency resolution across multiple levels of dependencies.

## Capabilities

- Level 1: Main agent functionality
- Level 2: Intermediate skill integration
- Level 3: Base tool integration

## Usage

This is a test component designed to verify that dependency resolution works correctly for nested dependency chains.

### Dependencies

- test-level-2: Provides intermediate functionality
  - test-level-3: Provides base tooling

## Testing Scenarios

1. **Dependency Resolution**: Verify all levels are resolved in correct order
2. **Token Estimation**: Calculate cumulative token costs across all levels
3. **Installation**: Ensure all dependencies are installed recursively

## Expected Behavior

When installed, this component should:
- Download the main agent files
- Resolve and download test-level-2 dependency
- Resolve and download test-level-3 dependency (transitive)
- Report cumulative token cost for all components

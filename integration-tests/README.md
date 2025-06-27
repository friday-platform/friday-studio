# Integration Tests

This directory contains cross-package integration tests for the Atlas monorepo.

## Structure

- `client-cli/` - Tests for @atlas/client integration with CLI commands
- `client-daemon/` - Tests for @atlas/client integration with the daemon
- `e2e/` - End-to-end tests for complete workflows

## Running Tests

```bash
# Run all integration tests
deno test integration-tests/

# Run specific test suite
deno test integration-tests/client-cli/
```

# Claude Instructions for atlas-operator

## Code Quality Requirements

**CRITICAL: ALWAYS run these commands after making ANY code changes:**

```bash
make fmt    # Format all Go code
make lint   # Run golangci-lint to check for issues
```

These commands MUST be run before committing any code changes. Do NOT skip this step.

## Workflow

1. Make code changes
2. Run `make fmt` to format code
3. Run `make lint` to check for issues
4. Fix any linting errors
5. Run tests with `make test`
6. Only then commit changes

## Common Linting Issues

- **Unchecked errors**: Always check error returns, especially in tests use `t.Setenv()` instead of `os.Setenv()`
- **Unused variables**: Remove or use them
- **Missing error handling**: Always handle errors appropriately

## Testing

- Use `t.Setenv()` in tests instead of `os.Setenv()` - it automatically checks errors and cleans up
- All tests should be table-driven where appropriate
- Test both success and error cases

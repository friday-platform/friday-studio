# Atlas Scripts

This directory contains utility scripts for the Atlas project.

## Import Validation Scripts

### `validate-imports.ts`

Validates all TypeScript/JavaScript imports in the codebase to ensure they reference existing files.

**Usage:**
```bash
deno task validate-imports
# or
deno run --allow-read --allow-write scripts/validate-imports.ts
```

**Features:**
- Scans all TypeScript/JavaScript files in the project
- Validates relative imports (e.g., `./file.ts`, `../dir/file.ts`)
- Handles different file extensions (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`)
- Supports directory imports with index files
- Skips external packages and URLs
- Provides detailed error reporting with file paths and line numbers

### `validate-imports-staged.ts`

Validates imports only for staged files (used in pre-commit hooks).

**Usage:**
```bash
deno task validate-imports-staged
# or
deno run --allow-read --allow-write --allow-run scripts/validate-imports-staged.ts
```

**Features:**
- Only validates files that are staged for commit
- Faster than full validation for pre-commit hooks
- Uses `git diff --cached` to find staged files
- Same validation logic as the full validator

## Integration

### Pre-commit Hook

The import validation is automatically run on staged files via `lint-staged` when you commit changes.

### GitHub Actions

Import validation runs in all build workflows:
- `validate-imports.yml` - Standalone validation workflow
- `edge-release.yml` - Validates before edge builds
- `nightly-release.yml` - Validates before nightly builds  
- `release.yml` - Validates before releases

### Local Development

Run validation manually:
```bash
# Validate all files
deno task validate-imports

# Validate only staged files
deno task validate-imports-staged
```

## Error Examples

The validator will catch issues like:

```typescript
// ❌ This will fail validation
import { BaseAgent } from "./base-agent.ts"; // File doesn't exist

// ✅ This will pass validation  
import { BaseAgent } from "./base-agent-v2.ts"; // File exists
```

## Benefits

- **Prevents build failures**: Catches missing imports before they break CI/CD
- **Faster feedback**: Validates locally before pushing to remote
- **Consistency**: Ensures all imports are valid across the codebase
- **Documentation**: Clear error messages help developers fix issues quickly
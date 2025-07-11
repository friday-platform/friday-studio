# Import Validation System

Atlas includes a comprehensive import validation system to prevent build failures caused by missing or incorrect import paths.

## Problem Solved

TypeScript/JavaScript builds can fail when imports reference files that don't exist, such as:
- Typos in file paths
- Files that have been renamed or moved
- Missing file extensions
- Incorrect relative paths

These issues are often caught only during compilation, leading to CI/CD failures.

## Solution

The import validation system catches these issues early through:

1. **Pre-commit validation** - Validates imports in staged files before commit
2. **CI/CD validation** - Validates all imports before builds
3. **Local validation** - Run validation manually during development

## How It Works

### Full Validation (`validate-imports.ts`)

Scans all TypeScript/JavaScript files in the project and validates that:
- Relative imports point to existing files
- File extensions are handled correctly
- Directory imports with index files work
- External packages and URLs are skipped

### Staged Validation (`validate-imports-staged.ts`)

Optimized for pre-commit hooks:
- Only validates files staged for commit
- Uses `git diff --cached` to find changed files
- Faster execution for better developer experience

## Integration Points

### 1. Pre-commit Hook

Automatically runs when you commit changes:
```bash
git add .
git commit -m "Fix imports"
# Import validation runs automatically
```

### 2. GitHub Actions

Validates imports in all build workflows:
- Before edge builds
- Before nightly builds  
- Before releases
- In standalone validation workflow

### 3. Local Development

Run validation manually:
```bash
# Validate all files
deno task validate-imports

# Validate only staged files
deno task validate-imports-staged
```

## Example Error Output

```
❌ Found 2 import issues in staged files:

📄 src/core/memory/fact-extractor.ts:12
  Import: ../agents/base-agent.ts
  Issue: File not found: /path/to/atlas/src/core/agents/base-agent.ts

📄 src/cli/tests/helpers.ts:136
  Import: ../../../core/agents/base-agent.ts
  Issue: File not found: /path/to/atlas/core/agents/base-agent.ts

💡 Fix these import issues before committing.
```

## Benefits

- **Prevents CI/CD failures**: Catches import issues before they reach the build system
- **Faster feedback**: Developers get immediate feedback on import problems
- **Consistency**: Ensures all imports are valid across the entire codebase
- **Documentation**: Clear error messages help developers fix issues quickly

## Configuration

The validation system is configured in:
- `lint-staged.config.js` - Pre-commit hook configuration
- `.github/workflows/*.yml` - CI/CD integration
- `deno.json` - Task definitions for local usage

## Files Created

- `scripts/validate-imports.ts` - Full validation script
- `scripts/validate-imports-staged.ts` - Staged validation script
- `scripts/README.md` - Documentation for scripts
- `.github/workflows/validate-imports.yml` - Standalone validation workflow

## Historical Context

This system was created after a build failure where `base-agent.ts` was imported but the actual file was named `base-agent-v2.ts`. The validation system would have caught this issue before it caused a CI/CD failure.

## Future Enhancements

- **IDE Integration**: VS Code extension for real-time validation
- **Auto-fix**: Automatically suggest corrections for common import issues
- **Performance**: Incremental validation for large codebases
- **Exclusions**: Configuration file for excluding specific patterns or directories
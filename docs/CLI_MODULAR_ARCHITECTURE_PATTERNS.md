# CLI Modular Architecture Patterns

This document establishes the patterns, principles, and rules derived from implementing the `/signals` interactive command, which demonstrated best practices for creating modular, reusable CLI components in Atlas.

## Core Principles

### 1. DRY (Don't Repeat Yourself)
**Rule**: Never duplicate logic between CLI commands and interactive components.

**Pattern**: Extract shared functionality into modules under `src/cli/modules/`

**Example**: Instead of creating separate signal display logic for interactive mode, we extracted the existing `SignalListCommand` component and `resolveWorkspaceAndConfig` function into shared modules.

### 2. Separation of Concerns
**Rule**: Organize code by functional domain, not by usage context.

**Directory Structure**:
```
src/cli/
├── modules/                    # Shared, reusable modules
│   ├── signals/               # Signal-related functionality
│   │   └── SignalListComponent.tsx
│   └── workspaces/            # Workspace-related functionality
│       └── resolver.ts
├── commands/                  # Command implementations
│   ├── signal/
│   │   └── list.tsx           # CLI command (imports from modules)
│   └── interactive.tsx        # Interactive command (imports from modules)
└── views/                     # UI components
```

### 3. Consistent UI Theming
**Rule**: Use ThemeProvider for consistent visual styling across all components.

**Implementation**:
```typescript
// Custom theme with yellow highlights for Select components  
const customTheme = extendTheme(defaultTheme, {
  components: {
    Select: {
      styles: {
        focusIndicator: () => ({ color: 'yellow' }),
        label: ({isFocused, isSelected}) => ({
          color: isSelected ? 'yellow' : isFocused ? 'yellow' : undefined
        })
      }
    }
  }
});

// Wrap entire interactive interface
export function handler() {
  render(
    <ThemeProvider theme={customTheme}>
      <InteractiveCommand />
    </ThemeProvider>
  );
}
```

**Update DEV_FEEDBACK**: Document color consistency requirements for future development.

## Module Organization Patterns

### Module Directory Structure
**Rule**: All shared CLI functionality goes under `src/cli/modules/`

**Naming Convention**:
- Domain-based folders: `signals/`, `workspaces/`, `agents/`, etc.
- Component files: PascalCase with descriptive names (`SignalListComponent.tsx`)
- Utility files: camelCase with descriptive names (`resolver.ts`)

### Import Path Management
**Rule**: When moving files deeper in directory structure, update all import paths accordingly.

**Pattern**: 
- From `src/cli/commands/` to `src/cli/modules/`: Add one more `../` level
- Always use relative imports within CLI structure
- Use absolute imports for core modules

**Example**:
```typescript
// Before move (in src/cli/commands/signal/list.tsx):
import { ConfigLoader } from "../../../core/config-loader.ts";

// After move (in src/cli/modules/workspaces/resolver.ts):
import { ConfigLoader } from "../../../core/config-loader.ts";

// Usage (in src/cli/commands/signal/list.tsx):
import { resolveWorkspaceAndConfig } from "../../modules/workspaces/resolver.ts";
```

### Component Extraction Pattern
**Rule**: When extracting components, maintain original functionality and interfaces.

**Steps**:
1. Identify shared logic in existing command
2. Extract to appropriate module directory
3. Update original command to import from module
4. Update any other consumers to use shared module
5. Remove duplicate code

## Interactive Command Patterns

### State Management for Mode Switching
**Pattern**: Use boolean flags for simple mode switches rather than complex state machines.

```typescript
const [showWorkspaceSelection, setShowWorkspaceSelection] = useState(false);

// In render:
{showWorkspaceSelection ? (
  <WorkspaceSelection 
    onEscape={() => setShowWorkspaceSelection(false)} 
    onWorkspaceSelect={handleWorkspaceSelect}
  />
) : (
  <CommandInput onSubmit={handleCommand} />
)}
```

### Loading States with Spinner
**Pattern**: Always provide visual feedback for async operations.

```typescript
// Add loading entry
addOutputEntry({
  id: `loading-${Date.now()}`,
  component: (
    <Box>
      <Spinner label="Loading signals..." />
    </Box>
  ),
});

// Remove loading entry when done
setOutputBuffer((prev) => prev.slice(0, -1));
```

### Output Buffer Management
**Pattern**: Build conversation-style interfaces using output buffer pattern.

```typescript
const [outputBuffer, setOutputBuffer] = useState<OutputEntry[]>([]);

const addOutputEntry = (entry: OutputEntry) => {
  setOutputBuffer((prev) => [...prev, entry]);
};

// Replace last entry pattern (for loading states)
setOutputBuffer((prev) => prev.slice(0, -1));
```

## Workspace Resolution Patterns

### Directory-Safe Resolution
**Rule**: Provide both directory-changing and directory-safe variants of workspace resolution.

**Implementation**:
```typescript
// For CLI commands (can change directory)
export async function resolveWorkspaceAndConfig(workspaceId?: string): Promise<{...}> {
  // Changes directory temporarily
  const originalCwd = Deno.cwd();
  try {
    Deno.chdir(workspacePath);
    // ... load config
  } finally {
    Deno.chdir(originalCwd);
  }
}

// For interactive use (preserves directory)
export async function resolveWorkspaceAndConfigNoCwd(workspaceId: string): Promise<{...}> {
  // Uses ConfigLoader with absolute path
  const configLoader = new ConfigLoader(targetWorkspace.path);
  // ... no directory change
}
```

### Error Handling Consistency
**Pattern**: Provide clear, actionable error messages with context.

```typescript
if (!targetWorkspace) {
  throw new Error(
    `Workspace '${workspaceId}' not found in registry. Use 'atlas workspace list' to see registered workspaces.`
  );
}
```

## Component Interface Patterns

### Callback-Based Communication
**Pattern**: Use callback props for parent-child communication in interactive components.

```typescript
interface WorkspaceSelectionProps {
  onEscape: () => void;
  onWorkspaceSelect: (workspaceId: string) => void;
}

// Usage allows clean separation of concerns
<WorkspaceSelection 
  onEscape={() => setShowWorkspaceSelection(false)} 
  onWorkspaceSelect={handleWorkspaceSelect}
/>
```

### Shared Component Interfaces
**Pattern**: Maintain consistent interfaces when extracting shared components.

```typescript
// Extracted component maintains original interface
export function SignalListComponent({
  signalEntries,
  workspaceName,
}: {
  signalEntries: Array<[string, WorkspaceSignalConfig]>;
  workspaceName: string;
}) {
  // Original implementation unchanged
}
```

## Refactoring Rules

### 1. Identify Before Extract
- **Always examine existing implementations** before creating new ones
- **Look for shared patterns** across CLI and interactive modes
- **Identify the minimal shared interface** needed

### 2. Extract to Correct Location
- **Create proper module structure** (`src/cli/modules/`)
- **Group by functional domain**, not usage pattern
- **Use descriptive names** that indicate purpose

### 3. Update All Consumers
- **Update import paths** in all files that use the functionality
- **Test both CLI and interactive modes** after extraction
- **Verify no functionality is lost** in the extraction process

### 4. Clean Up Duplicates
- **Remove duplicate code** from original locations
- **Ensure no broken imports** remain
- **Update any documentation** that references old locations

## UI Consistency Rules

### Theme Integration
**Rule**: All interactive components must use the established theme system.

**Yellow Highlight Standard**: Interactive selections (Select components, suggestion lists) use yellow highlighting for visual consistency.

### Input Handling Patterns
**Rule**: Maintain consistent keyboard navigation patterns.

**Standard Bindings**:
- `Escape`: Return to previous state/cancel current operation
- `Up/Down Arrows`: Navigate lists and suggestions
- `Enter`: Confirm selection
- `Tab`: Switch focus or exit suggestion mode

### Visual Feedback Requirements
**Rule**: All async operations must provide immediate visual feedback.

**Required Elements**:
- Loading spinners for operations > 100ms
- Clear error messages with actionable guidance
- Success confirmation when appropriate
- Progress indicators for multi-step operations

## Testing Considerations

### Module Testing
**Pattern**: Test extracted modules independently of their consumers.

### Integration Testing
**Pattern**: Test that both CLI and interactive modes work with shared modules.

### Path Testing
**Pattern**: Verify import paths work correctly after module extraction.

## Future Module Candidates

Based on this pattern, consider extracting these areas into modules:

1. **`src/cli/modules/agents/`** - Agent listing, status checking, management
2. **`src/cli/modules/sessions/`** - Session management, monitoring, lifecycle
3. **`src/cli/modules/config/`** - Configuration validation, loading, display
4. **`src/cli/modules/logging/`** - Log viewing, filtering, formatting
5. **`src/cli/modules/workspaces/`** - Expand with more workspace operations

## Success Metrics

A successful modular implementation should achieve:

- **Zero code duplication** between CLI and interactive modes
- **Consistent UI behavior** across all interfaces
- **Maintainable import structure** that's easy to follow
- **Single source of truth** for each functional area
- **Testable components** that can be verified independently

## Conclusion

The `/signals` implementation established a reusable pattern for creating rich interactive CLI experiences while maintaining code quality and consistency. These patterns should be applied to all future CLI enhancements to ensure a cohesive, maintainable codebase.
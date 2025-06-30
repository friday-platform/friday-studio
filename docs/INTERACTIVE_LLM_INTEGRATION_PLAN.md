# Interactive LLM Integration Migration Plan

## Overview

This document outlines the plan to migrate the conversational LLM capabilities from `cx-client.tsx`
into the main `interactive.tsx` interface while preserving all existing functionality and styling.

## Goal

Enable direct LLM conversation in the main Atlas interactive interface by:

- Preserving ALL current `interactive.tsx` functionality and styling
- Adding ConversationClient integration for non-slash input
- Implementing simplified message handling (only `message_complete` events)
- Maintaining existing command structure and UI patterns

## Current State Analysis

### `interactive.tsx` (Main Interface)

- **Output Buffer**: Complex multi-component system with 1800+ lines
- **Commands**: 10+ slash commands with sophisticated parsing
- **State Management**: 20+ state variables for workspace/selection flows
- **UI System**: Multi-view architecture (help, init, config, credits)
- **Styling**: Established color scheme and component patterns

### `cx-client.tsx` (LLM Playground)

- **Output Buffer**: Simple conversation display (485 lines)
- **LLM Integration**: ConversationClient with streaming events
- **Message Handling**: Full event handling (tool_call, transparency, orchestration)
- **Simple Commands**: Only 3 commands (/clear, /exit, /help)

## Migration Strategy

### Phase 1: Core Integration Setup

#### 1.1 Add ConversationClient Dependencies

**File**: `src/cli/commands/interactive.tsx`

```typescript
// Add to existing imports
import { ConversationClient } from "../utils/conversation-client.ts";

// Add state variables (preserving all existing state)
const [conversationClient, setConversationClient] = useState<ConversationClient | null>(null);
const [conversationSessionId, setConversationSessionId] = useState<
  string | null
>(null);
const [isLLMProcessing, setIsLLMProcessing] = useState(false);
```

#### 1.2 Initialize Conversation Client

**Location**: Within existing `checkDaemonAndInitialize` useEffect

```typescript
// Add after successful daemon connection
if (client && workspaces.length > 0) {
  // Initialize conversation client with first available workspace
  const defaultWorkspace = workspaces[0];
  const conversationClient = new ConversationClient(
    "http://localhost:8080",
    defaultWorkspace.id,
    "cli-user",
  );

  try {
    const session = await conversationClient.createSession();
    setConversationClient(conversationClient);
    setConversationSessionId(session.sessionId);
  } catch (error) {
    console.warn("Failed to initialize conversation client:", error);
  }
}
```

### Phase 2: Input Handling Modification

#### 2.1 Modify `handleCommand` Function

**Rule**: If input does NOT start with `/`, send to LLM instead of showing error

**Current Logic**:

```typescript
const parsed = parseSlashCommand(input);
if (!parsed) {
  // Currently shows error - CHANGE THIS
  addOutputEntry({
    id: `error-${Date.now()}`,
    component: (
      <Text>
        Commands must start with /. Type /help for available commands.
      </Text>
    ),
  });
  return;
}
```

**New Logic**:

```typescript
const parsed = parseSlashCommand(input);
if (!parsed) {
  // Send non-slash input to LLM
  handleLLMInput(input);
  return;
}
// Continue with existing slash command handling...
```

#### 2.2 Create `handleLLMInput` Function

**File**: `src/cli/commands/interactive.tsx` **Style**: Follow existing function patterns in
interactive.tsx

```typescript
const handleLLMInput = async (input: string) => {
  if (!conversationClient || !conversationSessionId) {
    addOutputEntry({
      id: `llm-error-${Date.now()}`,
      component: (
        <Text color="red">
          LLM not available. Try a workspace command first.
        </Text>
      ),
    });
    return;
  }

  // Add user message (following existing styling patterns)
  addOutputEntry({
    id: `user-${Date.now()}`,
    component: (
      <Box flexDirection="column" paddingLeft={1}>
        <Text color="blue">
          <Text bold>You:</Text> {input}
        </Text>
      </Box>
    ),
  });

  // Show processing indicator (using existing Spinner pattern)
  setIsLLMProcessing(true);
  const spinnerId = `llm-processing-${Date.now()}`;
  addOutputEntry({
    id: spinnerId,
    component: (
      <Box paddingLeft={1}>
        <Spinner label="Thinking..." />
      </Box>
    ),
  });

  try {
    await conversationClient.sendMessage(conversationSessionId, input);

    let responseMessage = "";

    // Listen ONLY for message_complete events (simplified from cx-client)
    for await (
      const event of conversationClient.streamEvents(
        conversationSessionId,
      )
    ) {
      if (event.type === "message_chunk") {
        responseMessage = event.data.content;
      } else if (event.type === "message_complete") {
        setIsLLMProcessing(false);

        // Remove spinner (following existing pattern)
        setOutputBuffer((prev) => prev.filter((entry) => entry.id !== spinnerId));

        // Add response (following existing styling)
        if (responseMessage) {
          addOutputEntry({
            id: `llm-response-${Date.now()}`,
            component: (
              <Box flexDirection="column" paddingLeft={1}>
                <Text color="cyan">
                  <Text bold>Atlas:</Text>
                </Text>
                <Text wrap="wrap" color="white" marginLeft={2}>
                  {responseMessage}
                </Text>
              </Box>
            ),
          });
        }

        if (event.data.error) {
          addOutputEntry({
            id: `llm-error-${Date.now()}`,
            component: (
              <Text color="red" paddingLeft={1}>
                Error: {event.data.error}
              </Text>
            ),
          });
        }
        return; // Exit stream
      }
    }
  } catch (error) {
    setIsLLMProcessing(false);
    setOutputBuffer((prev) => prev.filter((entry) => entry.id !== spinnerId));
    addOutputEntry({
      id: `llm-error-${Date.now()}`,
      component: (
        <Text color="red" paddingLeft={1}>
          LLM Error: {error instanceof Error ? error.message : String(error)}
        </Text>
      ),
    });
  }
};
```

### Phase 3: UI Integration

#### 3.1 Update Input Placeholder

**File**: `src/cli/commands/interactive.tsx` **Component**: `CommandInput`

**Current**:

```typescript
placeholder = "Type / for commands";
```

**New**:

```typescript
placeholder = "Type / for commands or chat with Atlas...";
```

## Implementation Rules

### MUST PRESERVE (Critical Requirements)

1. **All existing styling and colors** - No changes to current visual appearance
2. **All existing slash commands** - Every current command must work identically
3. **All existing state management** - No removal of current state variables
4. **All existing UI flows** - Workspace selection, signal triggering, etc.
5. **All existing components** - No modification to selection components, views, etc.
6. **All existing error handling** - Current error patterns must remain
7. **🚨 CRITICAL: Zero modifications to cx-client.tsx** - This file must remain completely unchanged
8. **🚨 CRITICAL: Zero modifications to cx-dev.tsx** - This file must remain completely unchanged

### MUST ADD (New Requirements)

1. **ConversationClient integration** - Import and initialize
2. **Non-slash input handling** - Route to LLM instead of error
3. **Message display** - Simple user/assistant conversation format
4. **Processing indicators** - Use existing Spinner component
5. **Error handling** - LLM-specific errors in existing error style

### MUST SIMPLIFY (Scope Reduction)

1. **Event handling** - Only `message_complete` and `message_chunk`
2. **No transparency display** - Skip complex reasoning displays
3. **No tool call display** - Skip tool execution details
4. **No orchestration display** - Skip coordination plans
5. **Simple responses only** - Just final response text

## File Dependencies

### Files That Must NOT Be Modified

**🚨 ABSOLUTE PROHIBITION - DO NOT TOUCH:**

- `src/cli/commands/cx-client.tsx` - Must remain completely unchanged
- `src/cli/commands/cx-dev.tsx` - Must remain completely unchanged
- These files serve as specialized debugging tools and must be preserved exactly as-is

### Required Imports (Add to interactive.tsx ONLY)

```typescript
import { ConversationClient } from "../utils/conversation-client.ts";
```

### State Variables (Add to InteractiveCommand)

```typescript
const [conversationClient, setConversationClient] = useState<ConversationClient | null>(null);
const [conversationSessionId, setConversationSessionId] = useState<
  string | null
>(null);
const [isLLMProcessing, setIsLLMProcessing] = useState(false);
```

### New Functions (Add to InteractiveCommand)

```typescript
const handleLLMInput = async (input: string) => {
  /* implementation */
};
```

## Testing Strategy

### Phase 1 Testing: Basic Integration

1. Verify existing commands still work: `/help`, `/workspaces`, `/signal`, etc.
2. Verify existing UI flows work: workspace selection, signal triggering
3. Verify existing styling preserved: colors, spacing, layout

### Phase 2 Testing: LLM Integration

1. Test non-slash input routes to LLM
2. Test LLM responses display correctly
3. Test processing indicators work
4. Test error handling for LLM failures
5. Test disabled state during processing

### Phase 3 Testing: Edge Cases

1. Test LLM not available scenarios
2. Test network errors during LLM calls
3. Test very long LLM responses
4. Test special characters in LLM input/output
5. Test concurrent slash commands during LLM processing

## Success Criteria

### Functional Requirements

- [ ] All existing `/` commands work identically
- [ ] Non-`/` input sends to LLM and displays response
- [ ] Only `message_complete` events handled (simplified)
- [ ] Processing indicators work during LLM calls
- [ ] Error handling works for LLM failures

### UI/UX Requirements

- [ ] All existing styling preserved exactly
- [ ] All existing components work identically
- [ ] All existing color schemes maintained
- [ ] All existing layouts preserved
- [ ] New LLM features blend seamlessly

### Technical Requirements

- [ ] No removal of existing functionality
- [ ] No modification of existing command handlers
- [ ] No changes to existing state management patterns
- [ ] Clean integration with ConversationClient
- [ ] Proper error boundaries and handling

## Risk Mitigation

### High Risk: Breaking Existing Functionality

**Mitigation**: Implement as pure addition - no modification of existing code paths

### High Risk: Accidentally Modifying cx-client.tsx or cx-dev.tsx

**Mitigation**:

- **ABSOLUTE PROHIBITION** on touching these files
- These files serve as specialized debugging tools and must remain pristine
- All LLM integration must be built independently in interactive.tsx
- Use completely separate import paths and state management
- No shared code modifications between cx-client/cx-dev and interactive

### Medium Risk: Styling Inconsistencies

**Mitigation**: Use exact same patterns as existing output entries

### Low Risk: Performance Impact

**Mitigation**: LLM calls are async and don't block existing operations

## Post-Migration Cleanup

### Optional Future Enhancements (Out of Scope)

- Advanced LLM features (tool calls, transparency)
- Conversation history persistence
- LLM model selection
- Advanced error recovery

### cx-client.tsx and cx-dev.tsx Preservation

- **PERMANENT PRESERVATION**: These files will remain as specialized debugging tools
- **NO DEPRECATION**: They serve distinct purposes from the interactive interface
- **INDEPENDENT OPERATION**: They provide dedicated LLM development and debugging capabilities
- **COMPLEMENTARY TOOLS**: interactive.tsx for general use, cx-client/cx-dev for specialized
  debugging
- Document clear separation of concerns between the interfaces

## Implementation Timeline

1. **Week 1**: Phase 1 & 2 - Core integration and input handling
2. **Week 2**: Phase 3 & 4 - UI integration and styling consistency
3. **Week 3**: Phase 5 & Testing - Command registry updates and comprehensive testing
4. **Week 4**: Polish and documentation updates

This plan ensures that the powerful LLM conversation capabilities from `cx-client.tsx` are
seamlessly integrated into the main `interactive.tsx` interface while preserving all existing
functionality and maintaining the established UI/UX patterns.

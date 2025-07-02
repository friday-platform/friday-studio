# Conversation Supervisor Debugging and User Experience

## Overview

This document summarizes the debugging process and desired user experience for the conversation
supervisor's draft-based workspace creation flow. The goal is to create a seamless, conversational
experience where users can iteratively build workspaces through natural dialogue.

## Desired User Experience

### Example Conversation Flow

**User**: "I want to create a new workspace. I want it to play the game of telephone with 3 members.
The first slightly mishears the users message, the second embellishes it, and the third turns the
embellished message into a haiku."

**Expected Response**:

```
I've created a draft workspace called 'telephone-game' that will transform messages through three stages:
1. A mishearing agent that slightly alters the original message
2. An embellishing agent that adds creative details
3. A haiku agent that converts it to poetry

Now let's design these agents. For the mishearing agent, what kind of alterations should it make? Should it:
- Swap similar-sounding words (like 'bear' → 'bare')?
- Drop or add small words?
- Slightly change pronunciation-based errors?

This will help me configure the agent's transformation rules appropriately.
```

### Key Experience Principles

1. **Immediate Acknowledgment**: Every workspace creation request should be immediately acknowledged
   with draft creation
2. **Conversational Continuity**: The assistant should always provide next steps and questions
   without requiring prompting
3. **Iterative Refinement**: Users build workspaces step-by-step through guided conversation
4. **Clear Progress Indicators**: Users should understand what's been created and what's next
5. **Adaptive Behavior**: The system adapts based on input specificity - creating all specified
   components upfront for detailed requests, or asking for clarification on vague requests

## Issues Encountered and Solutions

### Issue 1: No Visible Output

**Problem**: Users would type workspace creation requests but receive no response.

**Root Cause**: The conversation supervisor was making tool calls (like `workspace_draft_create`)
but not following up with `cx_reply` to provide user-facing messages.

**Solution**:

- Set `toolChoice: "required"` to force tool usage
- Added explicit instructions in system prompt to always use `cx_reply`
- Implemented fallback mechanism to generate messages when `cx_reply` isn't called

### Issue 2: Tool Calls Without Conversation

**Problem**: The LLM would call workspace modification tools without explaining what it did or
asking follow-up questions.

**Example**:

```
User: [workspace creation request]
System: [Shows tool call to update_workspace_config but no message]
User: "Do you need additional information?" (forced to prompt)
```

**Solution**:

- Increased `maxSteps` from 1 to 7 to allow complete workspace creation
- Added adaptive behavior to system prompt based on input specificity
- Created continuation check that auto-generates messages if workspace tools are called without
  `cx_reply`

### Issue 3: Complex System Prompt Confusion

**Problem**: The original system prompt was too complex with nested instructions, causing the LLM to
miss critical behaviors.

**Solution**: Implemented adaptive system prompt that analyzes user input:

```typescript
## ADAPTIVE WORKSPACE CREATION
Analyze the user's request to determine how specific they are:

### If user provides SPECIFIC agent descriptions:
1. Call workspace_draft_create
2. Call update_workspace_config for EACH agent they described
3. Call cx_reply to summarize what you created and ask for refinement details

### If user provides VAGUE request:
1. Call workspace_draft_create
2. Call cx_reply to ask for more details
```

### Issue 4: Timeout with Multiple Tool Calls

**Problem**: The default 30-second timeout was insufficient for complex workspace creation with
multiple agents.

**Solution**:

- Increased timeout from 30s to 90s for complex operations
- Limited maxSteps to 7 to balance between functionality and performance
- Optimized tool call sequences in system prompt

### Issue 5: Session Context Not Being Passed

**Problem**: All drafts were created with sessionId "default" instead of actual session IDs.

**Solution**:

- Converted static tools object to factory function `createCxTools(sessionId)`
- Tools now have access to sessionId through closure
- Each conversation session has properly isolated drafts

### Issue 6: Field Mapping Mismatches

**Problem**: LLM was sending `name/description` but code expected `id/purpose`, causing "undefined"
displays.

**Solution**:

- Updated helper functions to handle both field formats
- Modified `workspace-draft-store.ts` to properly map fields
- Fixed agent configuration to use correct schema fields (`purpose`, `type: "llm"`)

## Technical Implementation

### 1. Tool Chaining Configuration

```typescript
const result = await LLMProviderManager.generateTextWithTools(message, {
  systemPrompt,
  tools,
  model: "claude-3-5-haiku-20241022",
  temperature: 0.7,
  maxSteps: 7, // Allow complete workspace creation with agents and jobs
  toolChoice: "required", // Force tool usage to ensure cx_reply is called
  operationContext: { operation: "conversation_supervision" },
  timeout: 90000, // 90 seconds for complex multi-agent workspace creation
});
```

### 2. Adaptive Tool Creation

```typescript
// Create tools with session context
const createCxTools = (sessionId: string): Record<string, Tool> => ({
  workspace_draft_create: {
    // ... tool definition
    execute: async ({ name, description, pattern }) => {
      // Uses sessionId from closure
      const draft = await store.createDraft({
        name,
        description,
        pattern,
        sessionId, // Properly isolated per session
        userId: "system",
      });
      // ...
    },
  },
  // ... other tools
});
```

### 3. Enhanced Agent and Job Creation

When user provides specific agent descriptions, the system now:

1. Creates the draft workspace
2. Adds all specified agents with proper configuration:
   ```json
   {
     "name": "mishearing-agent",
     "purpose": "Slightly mishears and alters the message",
     "type": "llm",
     "model": "claude-3-5-haiku-20241022"
   }
   ```
3. Creates a job to chain the agents:
   ```json
   {
     "name": "telephone-pipeline",
     "description": "Run agents in sequence for telephone game",
     "triggers": ["telephone-game-trigger"],
     "execution": {
       "strategy": "sequential",
       "agents": ["mishearing-agent", "embellishing-agent", "haiku-agent"]
     }
   }
   ```
4. Provides a comprehensive summary with refinement questions

## Draft-Based Workspace Creation Flow

### Tools Involved

1. **workspace_draft_create**: Creates initial draft in Deno KV
2. **update_workspace_config**: Iteratively adds agents, jobs, triggers
3. **show_draft_config**: Reviews current configuration
4. **publish_workspace**: Validates and creates actual workspace
5. **list_session_drafts**: Shows all drafts in current session

### Data Flow for Specific Requests

```
User Request (with specific agents) → workspace_draft_create → Draft in Deno KV
                        ↓
              update_workspace_config → Add Agent 1
                        ↓
              update_workspace_config → Add Agent 2
                        ↓
              update_workspace_config → Add Agent 3
                        ↓
              update_workspace_config → Add Job (chains agents)
                        ↓
                    cx_reply → User sees comprehensive summary + refinement questions
                        ↓
User Response → update_workspace_config → Refined configuration
                        ↓
                    (iterate)
                        ↓
User Approval → publish_workspace → Validated YAML → Workspace Created
```

## Best Practices for Conversation Design

1. **Adaptive Creation**: Analyze user input to determine how much can be created upfront
2. **Always Chain cx_reply**: Every workspace tool call sequence must end with cx_reply
3. **Provide Context**: Include what was done and what's next in every message
4. **Ask Specific Questions**: Guide users with concrete options rather than open-ended queries
5. **Show Progress**: Let users know what's been configured at each step
6. **Handle Errors Gracefully**: Provide helpful messages when validation fails

## Testing the Experience

To test if the conversation flow is working correctly:

1. Clean old drafts: `deno run --allow-all --unstable-kv scripts/clean-drafts.ts`
2. Start daemon: `deno task atlas daemon start`
3. Start client: `deno task atlas cx`
4. Test with specific request: "I want to create a new workspace. I want it to play the game of
   telephone with 3 members..."
5. Expected: Creates draft + all 3 agents + job + asks for refinement
6. Test with vague request: "Help me create a workspace"
7. Expected: Creates draft + asks what the workspace should do
8. Use "show me the current configuration" to review
9. Say "publish it" when ready to create the workspace

## Recent Fixes Summary

1. **Session Isolation**: Fixed drafts using "default" sessionId by creating tools with session
   context
2. **Field Mapping**: Fixed "undefined" displays by handling both id/purpose and name/description
   formats
3. **Adaptive Behavior**: System now creates all specified components upfront for detailed requests
4. **Timeout Handling**: Increased timeout to 90s and optimized maxSteps to 7
5. **Job Creation**: Added automatic job creation to chain agents in pipeline pattern

## Future Enhancements

1. **Pattern Templates**: Pre-configured agent sets for common patterns
2. **Workspace Visualization**: ASCII or text-based diagrams of agent flow
3. **Validation Feedback**: Real-time validation as components are added
4. **Undo/Redo**: Allow users to revert changes during draft phase
5. **Import/Export**: Save and share draft configurations
6. **Smart Defaults**: Automatically suggest agent models and configurations based on purpose

## Storage Architecture Migration (2025-07-01)

### Overview

The workspace draft storage has been migrated from direct `Deno.Kv` usage to the standardized
storage abstraction layer used throughout Atlas. This ensures consistency, testability, and the
ability to swap storage backends without changing business logic.

### Changes Made

1. **Created WorkspaceDraftStorageAdapter**
   - Location: `/src/core/storage/workspace-draft-storage-adapter.ts`
   - Implements domain-specific draft operations on top of the generic `KVStorage` interface
   - Follows the same pattern as `RegistryStorageAdapter` and `LibraryStorageAdapter`
   - Provides methods: `createDraft`, `updateDraft`, `getDraft`, `getSessionDrafts`, `publishDraft`,
     `getDraftStats`, `cleanupAbandonedDrafts`

2. **Updated Conversation Supervisor**
   - Removed all direct `Deno.openKv()` calls
   - Created singleton draft storage adapter using `createKVStorage(StorageConfigs.defaultKV())`
   - All draft operations now go through the adapter, maintaining the same API surface

3. **Storage Location**
   - Draft data continues to be stored in `~/.atlas/storage.db`
   - Key structure remains the same:
     - Draft data: `["workspace_drafts", draftId]`
     - Session index: `["workspace_drafts_by_session", sessionId, draftId]`
     - Metadata: `["draft_metadata", "version"]` and `["draft_metadata", "lastUpdated"]`

### Technical Details

```typescript
// Old approach (direct Deno.Kv)
const kv = await Deno.openKv();
const store = new WorkspaceDraftStore(kv);
const draft = await store.createDraft({...});
kv.close();

// New approach (storage abstraction)
const adapter = await getDraftStorageAdapter(); // Singleton
const draft = await adapter.createDraft({...});
// No manual close needed for singleton
```

### Benefits

1. **Consistency**: All storage operations now use the same abstraction layer
2. **Testability**: Can easily swap in `MemoryKVStorage` for testing
3. **Future-proof**: Can migrate to Redis, PostgreSQL, etc. without changing conversation supervisor
4. **No Deno.Kv leakage**: Business logic is completely isolated from storage implementation

### Verification

The migration can be verified using the test script:

```bash
deno run --allow-all scripts/test-draft-storage.ts
```

Or by checking data directly with the DenoKV MCP:

```bash
# List all drafts
denokv_list --prefix '["workspace_drafts"]'

# Get specific draft
denokv_get --key '["workspace_drafts", "draft-id-here"]'

# Check session drafts
denokv_list --prefix '["workspace_drafts_by_session", "session-id"]'
```

### Impact on Conversation Flow

The storage migration is transparent to the user experience. All conversation flows continue to work
exactly as before, with drafts being created, updated, and published through the same conversational
interface. The only difference is the underlying storage mechanism is now properly abstracted.

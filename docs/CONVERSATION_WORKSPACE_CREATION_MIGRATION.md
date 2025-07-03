# Conversation Workspace Creation Migration

## Overview

This document outlines the migration of workspace creation functionality from the deprecated
ConversationSupervisor into the new conversation system workspace architecture. The migration
successfully combines the clean system workspace design with the sophisticated workspace creation
capabilities that were developed for the ConversationSupervisor.

## Migration Status: ✅ COMPLETED (2025-01-02)

All phases of the migration have been successfully implemented.

## Implementation Summary

### What Was Built

#### 1. Storage Infrastructure

- **Created**: `/src/core/storage/conversation-draft-adapter.ts`
- **Purpose**: Extends WorkspaceDraftStorageAdapter with conversation-specific functionality
- **Features**:
  - Conversation-scoped draft management
  - Message context tracking
  - Integration with existing KV storage patterns

#### 2. Workspace Creation Capabilities

- **Modified**: `/src/core/workspace-capabilities.ts`
- **Added 11 new capabilities**:
  - `workspace_draft_create` - Create workspace drafts with optional initial configuration
  - `workspace_draft_update` - Update draft configurations based on user feedback
  - `validate_draft_config` - Validate configurations without publishing
  - `pre_publish_check` - Run comprehensive validation checks
  - `publish_workspace` - Publish drafts to filesystem via daemon API
  - `show_draft_config` - Display configurations in YAML or summary format
  - `list_session_drafts` - List all drafts for current session
  - `library_list` - List library items with filtering
  - `library_get` - Retrieve specific library items with full content
  - `library_search` - Search across all libraries

#### 3. Schema Updates

- **Modified**: `/src/core/utils/capability-to-tool.ts`
- **Added**: Complete Zod schema definitions for all workspace creation tools
- **Features**: Type-safe input validation and parameter mapping

#### 4. Conversation Agent Enhancement

- **Modified**: `/packages/system/conversation/workspace.yml`
- **Integrated**: Full workspace creation module from ConversationSupervisor
- **Preserved**: Two-step workflow pattern (plan → confirm → build)
- **Added**: All workspace creation tools to agent's toolkit

## Migration Strategy

### Phase 1: Tool Migration to System Workspace

#### 1.1 Add Workspace Creation Capabilities

Extend the existing WorkspaceCapabilityRegistry in `/src/core/workspace-capabilities.ts` with
workspace creation capabilities:

```typescript
// Add to WorkspaceCapabilityRegistry.initialize()
// Workspace creation capabilities
this.registerCapability({
  id: "workspace_draft_create",
  name: "Create Workspace Draft",
  description: "Create a new workspace draft with optional initial configuration",
  category: "workspace",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      initialConfig: { type: "object" },
    },
    required: ["name", "description"],
  },
  implementation: async (context, name, description, initialConfig) => {
    // Implementation using WorkspaceDraftStorageAdapter
  },
});
```

#### 1.2 Port Workspace Creation Tools

Add all workspace creation tools from ConversationSupervisor as workspace capabilities:

- `workspace_draft_create`
- `workspace_draft_update`
- `publish_workspace`
- `validate_draft_config`
- `pre_publish_check`
- `show_draft_config`
- `list_session_drafts`
- Library access tools

#### 1.3 Update capability-to-tool.ts

Extend the schema mapping in `/src/core/utils/capability-to-tool.ts` to handle the complex input
schemas for workspace creation tools.

### Phase 2: Enhance Conversation Agent

#### 2.1 Update System Prompt

Merge the sophisticated workspace creation module from ConversationSupervisor into the conversation
agent's system prompt:

```yaml
# Enhanced conversation-agent configuration
agents:
  conversation-agent:
    type: "llm"
    model: "claude-3-5-sonnet-20241022"
    purpose: "Handle conversations with scope awareness and workspace creation"
    tools:
      - "stream_reply"
      - "workspace_draft_create"
      - "workspace_draft_update"
      - "publish_workspace"
      - "validate_draft_config"
      - "pre_publish_check"
      - "show_draft_config"
      - "list_session_drafts"
      - "library_list"
      - "library_get"
      - "library_search"
    system_prompt: |
      # Include enhanced prompt with workspace creation module
```

#### 2.2 Implement Response Patterns

The conversation agent needs specific implementation patterns that were in the old
ConversationSupervisor:

1. **Two-Step Workflow Pattern**:
   - Implement logic in the agent's system prompt to ALWAYS plan first before calling
     `workspace_draft_create`
   - The agent must use `stream_reply` to describe the planned workspace and ask for confirmation
   - Only proceed with workspace creation after user approval
   - Example flow: User request → Plan description → User confirmation → Create draft

2. **Progress Streaming for Long Operations**:
   - Modify workspace capabilities to send progress updates via `context.responseChannel`
   - For `validate_draft_config`: Stream validation progress ("Checking agents...", "Validating
     signals...")
   - For `publish_workspace`: Stream publishing steps ("Creating directory...", "Writing config...",
     "Initializing workspace...")
   - Implement in each capability's implementation function

3. **Structured Error Handling**:
   - Each capability should catch and format errors appropriately
   - Use `stream_reply` with structured error information including:
     - What failed
     - Why it failed
     - Suggested fixes (from generateValidationFixSuggestions)
   - Never let raw technical errors reach the user

4. **Rich Publishing Feedback**:
   - When `publish_workspace` succeeds, the response must include:
     - Full absolute path to the workspace
     - Clear next steps (cd command, .env setup, example trigger command)
     - Format this in the capability implementation, not just in the agent prompt

### Phase 3: Storage Integration

#### 3.1 Draft Storage Adapter

Port the WorkspaceDraftStorageAdapter to work within the system workspace context:

- Create `/src/core/storage/conversation-draft-adapter.ts`
- Integrate with existing KV storage patterns
- Scope drafts by conversation ID and user

#### 3.2 Conversation Context

Extend ConversationStorageAdapter to track:

- Active draft workspaces per conversation
- Workspace creation history
- User preferences and patterns

### Phase 4: Tool Implementation Details

#### 4.1 Tool Mapping

Map old tools to new workspace capabilities:

| Old Tool                 | New Capability            | Changes Required                                     |
| ------------------------ | ------------------------- | ---------------------------------------------------- |
| `cx_reply`               | `stream_reply` (existing) | Adapt transparency format                            |
| `workspace_draft_create` | `workspace_draft_create`  | Add conversation context, use context.conversationId |
| `workspace_draft_update` | `workspace_draft_update`  | Maintain compatibility                               |
| `publish_workspace`      | `publish_workspace`       | Integrate with daemon client                         |
| `validate_draft_config`  | `validate_draft_config`   | Use daemon validation endpoint                       |
| `pre_publish_check`      | `pre_publish_check`       | Comprehensive validation                             |
| `show_draft_config`      | `show_draft_config`       | Support YAML/summary formats                         |
| `list_session_drafts`    | `list_session_drafts`     | Filter by conversation ID                            |
| Library tools            | `library_*` capabilities  | Port AtlasClient integration                         |

#### 4.2 Response Channel Integration

Ensure all capabilities properly utilize the streaming response channel via context.responseChannel:

- Progress updates during validation
- Real-time feedback during publishing
- Streaming YAML display for configurations
- Use `context.responseChannel?.write()` for streaming updates

### Phase 5: Testing and Validation

#### 5.1 Test Scenarios

1. **Basic Creation**: Simple workspace from user description
2. **Iterative Refinement**: Multiple draft updates before publishing
3. **Error Recovery**: Handle validation errors gracefully
4. **Library Integration**: Search and reference existing workspaces
5. **Context Switching**: Multiple drafts in single conversation

#### 5.2 Migration Testing

- Ensure all example workflows from ConversationSupervisor work
- Verify draft persistence across conversation resumption
- Test concurrent draft management

## Key Implementation Details

### Progress Streaming

All long-running operations now stream progress updates via `context.responseChannel`:

```typescript
if (context.responseChannel?.write) {
  await context.responseChannel.write({
    type: "progress",
    message: "Validating configuration...",
  });
}
```

### Validation Integration

- Uses daemon API endpoint for configuration validation
- Provides structured error messages with fix suggestions
- Validates both schema compliance and cross-references

### Draft Storage

- Drafts are stored in Deno KV with conversation scoping
- Keys follow pattern: `["conversation_drafts", draftId]`
- Conversation index: `["conversation_drafts_by_conversation", conversationId, draftId]`

### Publishing Flow

1. Validates configuration via daemon API
2. Generates YAML from validated config
3. Calls daemon's `create-from-config` endpoint
4. Handles collision detection (workspace-2, workspace-3, etc.)
5. Returns full absolute path to created workspace

## Key Decisions

1. **Tool Architecture**: Implement as MCP server vs workspace capabilities
   - **Decision**: Use existing workspace capabilities system for consistency

2. **Storage Scope**: Conversation-scoped vs user-scoped drafts
   - **Decision**: Conversation-scoped with user access control

3. **Validation Approach**: Client-side vs daemon-side validation
   - **Decision**: Daemon-side for consistency with workspace creation

4. **Response Streaming**: How to handle long-running operations
   - **Decision**: Progressive updates via context.responseChannel

5. **Tool Naming**: Keep old names vs align with capability naming
   - **Decision**: Keep familiar names from ConversationSupervisor for user continuity

## Success Criteria

1. **Feature Parity**: All workspace creation capabilities from ConversationSupervisor work in new
   system
2. **Performance**: Workspace creation completes within 10 seconds for typical workspaces
3. **User Experience**: Clear progress feedback and error messages
4. **Reliability**: Draft persistence and recovery from failures
5. **Integration**: Seamless interaction with existing Atlas architecture

## Risks and Mitigations

| Risk                      | Impact | Mitigation                             |
| ------------------------- | ------ | -------------------------------------- |
| Tool response size limits | High   | Implement pagination for large configs |
| Draft storage conflicts   | Medium | Use conversation-scoped keys           |
| Validation performance    | Medium | Cache validation results               |
| Complex error states      | High   | Comprehensive error handling           |

## Future Enhancements

1. **Template Library**: Pre-built workspace templates
2. **Workspace Cloning**: Create from existing workspaces
3. **Collaborative Drafts**: Multi-user workspace design
4. **AI-Suggested Improvements**: Proactive optimization suggestions
5. **Visual Workspace Designer**: GUI integration for configuration

## Conclusion

This migration will bring the sophisticated workspace creation capabilities into the clean system
workspace architecture, providing users with a powerful conversational interface for designing and
deploying Atlas workspaces. The phased approach ensures we can deliver value incrementally while
maintaining system stability.

## Actionable Tasks for Conversation Workspace Creation Migration

### Phase 1: Foundation Setup (Week 1)

**Storage Infrastructure**

1. Create `/src/core/storage/conversation-draft-adapter.ts` by porting WorkspaceDraftStorageAdapter
2. Implement Deno KV storage patterns for draft persistence
3. Add conversation ID and user scoping to draft storage keys
4. Extend ConversationStorageAdapter to track active drafts and creation history

**Capability Registration** 5. Add `workspace_draft_create` capability to
WorkspaceCapabilityRegistry 6. Add `workspace_draft_update` capability with full config editing
support 7. Add `validate_draft_config` capability with daemon integration 8. Add `pre_publish_check`
capability for comprehensive validation 9. Add `publish_workspace` capability with daemon client
integration 10. Add `show_draft_config` capability supporting YAML/summary formats 11. Add
`list_session_drafts` capability with conversation filtering 12. Add library access capabilities
(`library_list`, `library_get`, `library_search`)

**Schema Updates** 13. Update `/src/core/utils/capability-to-tool.ts` to handle complex workspace
creation schemas 14. Add Zod schemas for all workspace creation input/output types

### Phase 2: Tool Implementation (Week 2)

**Core Tool Logic** 15. Implement workspace draft creation with initial config support 16. Implement
draft update logic with incremental config changes 17. Port validation logic with streaming progress
updates 18. Implement pre-publish checks (directory availability, permissions, etc.) 19. Implement
workspace publishing with atomic file operations 20. Add YAML formatter for draft config display 21.
Implement draft listing with filtering and sorting

**Library Integration** 22. Integrate AtlasClient for library access 23. Implement library search
with relevance scoring 24. Add library workspace reference resolution

**Response Streaming** 25. Add progress streaming to validation capability 26. Add step-by-step
feedback to publishing capability 27. Implement structured error formatting with fix suggestions 28.
Add response channel integration to all long-running operations

### Phase 3: Agent Enhancement (Week 3)

**System Prompt Updates** 29. Extract workspace creation module from ConversationSupervisor system
prompt 30. Merge workspace creation patterns into conversation agent prompt 31. Add two-step
workflow enforcement (plan → confirm → execute) 32. Include error handling and recovery patterns

**Agent Configuration** 33. Update `/packages/system/conversation/workspace.yml` to include all
workspace tools 34. Configure tool permissions and access controls 35. Add tool usage examples to
agent configuration

**Behavioral Patterns** 36. Implement mandatory planning before workspace creation 37. Add user
confirmation requirement for draft creation 38. Implement iterative refinement workflow support 39.
Add context-aware suggestions based on user patterns

### Phase 4: Integration & Testing (Week 4)

**Integration Testing** 40. Test basic workspace creation from description 41. Test iterative draft
refinement workflow 42. Test validation error handling and recovery 43. Test library search and
reference integration 44. Test multiple concurrent drafts in single conversation 45. Test draft
persistence across conversation resumption 46. Test publishing to various directory locations 47.
Test daemon validation endpoint integration

**Error Handling** 48. Implement comprehensive error catching in each capability 49. Add
user-friendly error message formatting 50. Create validation fix suggestion generator 51. Test error
recovery scenarios

**Performance Optimization** 52. Add validation result caching 53. Implement pagination for large
configurations 54. Optimize draft storage queries 55. Profile and optimize publishing operations

### Phase 5: Documentation & Cleanup

**Documentation** 56. Update capability documentation with workspace creation tools 57. Create user
guide for workspace creation workflow 58. Document draft storage format and lifecycle 59. Add
troubleshooting guide for common issues

**Migration** 60. Remove deprecated ConversationSupervisor code 61. Update any references to old
supervisor 62. Migrate existing conversation data if needed 63. Update integration tests

### Phase 6: Verification

**Feature Parity** 64. Verify all ConversationSupervisor capabilities work in new system 65. Ensure
workspace creation completes within 10 seconds 66. Validate clear progress feedback throughout
operations 67. Test draft persistence and failure recovery 68. Verify seamless Atlas architecture
integration

These tasks should be executed in order, with each phase building on the previous one. Dependencies
between tasks should be carefully managed, especially between storage implementation and capability
registration.

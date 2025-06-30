# ConversationSupervisor Memory Integration Task

## Problem Summary

The ConversationSupervisor currently loses all context between messages. When a user asks follow-up
questions (e.g., "can you call it kenspace instead?"), the supervisor has no memory of the previous
conversation and responds as if it's a completely new conversation.

## Current State

- **ConversationSessionManager** tracks message history in memory but doesn't persist it
- **ConversationSupervisor** only receives the current message with no conversation history
- The CoALA memory system exists and works well for other supervisors but isn't connected to
  conversations

## Example of the Problem

```
User: "help me create a new workspace for finding bugs in the atlas repo"
Assistant: [Provides helpful response about creating a workspace]
User: "can you call it kenspace instead?"
Assistant: "I'd be happy to help you with a workspace! However, I need more context..." [Lost all context]
```

## Proposed Integration with CoALA Memory

### Option 1: Quick Fix (Implemented)

- Pass message history from ConversationSessionManager to ConversationSupervisor
- Include recent conversation context in the system prompt
- Maintains context within a session but doesn't persist across daemon restarts

### Option 2: Full CoALA Integration (Recommended)

The ConversationSupervisor should leverage the existing CoALA memory system:

1. **Initialize CoALA Memory** in ConversationSupervisor:
   ```typescript
   private memory: CoALAMemoryManager;

   constructor(workspaceId: string, workspaceContext?: any) {
     // Initialize with conversation-specific storage path
     const storageAdapter = new CoALALocalFileStorageAdapter(
       join(workspacePath, ".atlas", "conversations")
     );
     this.memory = new CoALAMemoryManager(storageAdapter);
   }
   ```

2. **Store Conversations in EPISODIC Memory**:
   ```typescript
   // After each conversation exchange
   await this.memory.rememberWithMetadata(
     `conversation-${messageId}`,
     {
       userMessage: message,
       assistantResponse: response,
       transparency: transparencyData,
       sessionId,
       timestamp,
       fromUser,
     },
     {
       memoryType: CoALAMemoryType.EPISODIC,
       tags: ["conversation", sessionId, fromUser],
       relevanceScore: 0.9,
     },
   );
   ```

3. **Enhance Prompts with Relevant Memory**:
   ```typescript
   // Before processing user message
   const { enhancedPrompt, memoriesUsed } = await this.memory.enhancePromptWithMemory(
     message,
     {
       includeEpisodic: true, // Past conversations
       includeSemantic: true, // Knowledge about workspaces
       includeContextual: true, // Session-specific context
       maxMemories: 10,
       memoryWindow: "recent", // Focus on recent conversations
     },
   );
   ```

4. **Use Vector Search for Semantic Retrieval**:
   ```typescript
   // Find semantically similar past conversations
   const relatedConversations = await this.memory.searchMemoriesByVector(
     message,
     {
       memoryTypes: [CoALAMemoryType.EPISODIC],
       tags: ["conversation", sessionId],
       limit: 5,
       minSimilarity: 0.7,
     },
   );
   ```

5. **Cross-Session Intelligence**:
   ```typescript
   // Find patterns across all conversations
   const userPatterns = await this.memory.getMemoriesByTag(
     ["conversation", fromUser],
     { memoryTypes: [CoALAMemoryType.EPISODIC] },
   );
   ```

## Benefits of Full Integration

1. **Persistent Context**: Conversations survive daemon restarts
2. **Semantic Retrieval**: Find relevant past conversations even with different wording
3. **User Patterns**: Track user preferences and patterns across sessions
4. **Workspace Knowledge**: Build up semantic knowledge about workspace configurations
5. **Shared Learning**: ConversationSupervisor can learn from all conversations

## Implementation Priority

1. **Phase 1**: Quick fix to pass message history (DONE)
2. **Phase 2**: Basic EPISODIC memory storage for conversations
3. **Phase 3**: Memory enhancement for prompts
4. **Phase 4**: Vector search and cross-session intelligence

## Technical Considerations

- Storage location: `.atlas/conversations/` directory
- Memory types to use: Primarily EPISODIC, with some SEMANTIC for learned patterns
- Cleanup policy: Consider memory age and relevance for automatic cleanup
- Privacy: Ensure conversation memories respect workspace boundaries

The CoALA memory system is already battle-tested with other supervisors, so this should be a
straightforward integration that dramatically improves the conversation experience.

# MECMF Debug Logging Example

This example shows how to enable and use MECMF debug logging to see how prompts are transformed.

## Quick Setup

```typescript
import { enableMECMFDebugLogging, setupMECMF } from "@atlas/memory";

// Method 1: Environment Variables (Recommended)
// export MECMF_DEBUG=true
// export MECMF_DEBUG_LEVEL=detailed

// Method 2: Programmatic (Alternative)
enableMECMFDebugLogging({
  logLevel: "detailed",
  includeMemoryContent: true,
});

const manager = await setupMECMF(scope);
```

## Example Output

When you run your Atlas agents with debug logging enabled, you'll see:

### 1. Memory Classification (When storing content)

```
🧠 MECMF MEMORY CLASSIFICATION & STORAGE
Memory ID: working_1754493283243_d0w7mbwco
Content: "Currently implementing JWT authentication for the API"
Classified as: working
Entities found: 3 (JWT, API, implement)
Tags: [jwt, api, implement]
Classification time: 0.3ms
Entity extraction time: 0.2ms
Total time: 0.8ms
────────────────────────────────────────
```

### 2. Prompt Enhancement (When agents receive enhanced prompts)

```
════════════════════════════════════════════════════════════════════════════════
🧠 MECMF PROMPT ENHANCEMENT DEBUG LOG
Session: api-workspace-001
Timestamp: 2025-01-08T09:15:30.123Z
════════════════════════════════════════════════════════════════════════════════
📝 ORIGINAL PROMPT (12 tokens):
"How should I implement JWT authentication?"

🗃️ MEMORY CONTEXT ADDED:
"Working Memory: Currently implementing JWT authentication for the API. Procedural Memory: Install jsonwebtoken, create middleware, protect routes..."

📊 MEMORY BREAKDOWN (3 memories used):
  ⚡ working: 1 memories
  📖 episodic: 0 memories
  🧠 semantic: 1 memories  
  ⚙️ procedural: 1 memories

🎯 TOKEN ANALYSIS:
  Original: 12 tokens
  Enhanced: 67 tokens
  Change: +55 tokens (+458.3%)

⚡ PERFORMANCE METRICS:
  Memory Retrieval: 15ms
  Classification: 1ms
  Embedding Generation: 8ms
  Total Enhancement: 24ms

✨ ENHANCEMENT SUMMARY:
  Memories integrated: 3
  Processing time: 24ms
  Token efficiency: Added context (+458% tokens)
════════════════════════════════════════════════════════════════════════════════
```

## Advanced Usage

### Monitor Performance Programmatically

```typescript
import { getGlobalMECMFDebugLogger } from "@atlas/memory";

const logger = getGlobalMECMFDebugLogger();

// After some operations...
const stats = logger.getTokenEfficiencyStats();
console.log(`Average token reduction: ${stats.averageTokenChangePercent}%`);

const avgTime = logger.getAverageEnhancementTime();
console.log(`Average enhancement time: ${avgTime}ms`);
```

### Get Recent Logs for Analysis

```typescript
// Get last 10 prompt enhancement logs
const recentLogs = logger.getRecentLogs(10);

recentLogs.forEach((log) => {
  console.log(
    `Session ${log.sessionId}: ${log.memoriesUsed} memories, ${log.performanceMetrics.totalEnhancementMs}ms`,
  );
});
```

## Environment Variables

```bash
# Enable debug logging
export MECMF_DEBUG=true

# Set debug level (minimal, detailed, verbose)
export MECMF_DEBUG_LEVEL=detailed

# Enable full debug logs to stderr (optional)
export MECMF_DEBUG_LOGS=true
```

## What This Shows You

1. **Memory Classification**: How content gets categorized into WORKING, EPISODIC, SEMANTIC, or
   PROCEDURAL memory
2. **Entity Extraction**: What entities and tags are extracted from content
3. **Prompt Transformation**: How original prompts are enhanced with memory context
4. **Token Analysis**: Token counts before/after enhancement
5. **Performance**: Timing for each step of the process
6. **Memory Usage**: Which types of memories are being used

## Production Considerations

- Debug logging adds ~1-2ms overhead per operation
- Logs are automatically rotated (last 100 entries kept)
- Use `minimal` level in production if needed
- Memory content logging can be disabled for privacy

This helps you understand exactly how MECMF is working and optimize your memory usage patterns!

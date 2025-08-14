# MECMF Debug Logging Guide

The Memory-Enhanced Context Management Framework (MECMF) includes comprehensive debug logging to
help you understand how prompts are transformed and enhanced with memory context.

## Quick Start

Enable debug logging by setting environment variables:

```bash
export MECMF_DEBUG=true
export MECMF_DEBUG_LEVEL=detailed  # options: minimal, detailed, verbose
```

Or enable programmatically:

```typescript
import { enableMECMFDebugLogging } from "@atlas/memory";

enableMECMFDebugLogging({
  logLevel: "detailed",
  includeMemoryContent: true,
  maxPromptLength: 500,
});
```

## What You'll See

### 1. Memory Classification & Storage

When content is classified and stored in memory:

```
🧠 MECMF MEMORY CLASSIFICATION & STORAGE
Memory ID: working_1754493283243_d0w7mbwco
Content: "Currently working on authentication API implementation using JWT tokens"
Classified as: working
Entities found: 4 (API, JWT, Currently, implement)
Tags: [api, jwt, currently, implement]
Classification time: 0.3ms
Entity extraction time: 0.2ms
Total time: 0.8ms
────────────────────────────────────────
```

### 2. Prompt Enhancement Transformation

When user prompts are enhanced with memory context:

```
════════════════════════════════════════════════════════════════════════════════
🧠 MECMF PROMPT ENHANCEMENT DEBUG LOG
Session: test-workspace-001
Timestamp: 2025-01-08T09:15:30.123Z
════════════════════════════════════════════════════════════════════════════════
📝 ORIGINAL PROMPT (12 tokens):
"How should I implement JWT authentication in my API?"

🗃️ MEMORY CONTEXT ADDED:
"Context from working memory: Currently working on authentication API implementation using JWT tokens. From procedural memory: To implement JWT authentication: first install jsonwebtoken, then create middleware, finally protect routes..."

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

🔄 TRANSFORMATION STEPS:
  1. Memory manager initialized and ready
  2. Retrieved 3 relevant memories in 15.2ms
  3. Constructed token-aware prompt in 8.7ms
  4. Total enhancement completed in 24.1ms

✨ ENHANCEMENT SUMMARY:
  Memories integrated: 3
  Processing time: 24ms
  Token efficiency: Added context (+458% tokens)
════════════════════════════════════════════════════════════════════════════════
```

## Debug Logging Levels

### `minimal`

- Basic token counts and timing
- Memory usage summary

### `detailed` (recommended)

- Original and enhanced prompts (truncated)
- Memory breakdown by type
- Performance metrics
- Transformation steps

### `verbose`

- Everything from detailed
- Full enhanced prompts
- Complete transformation step details
- Memory content (when enabled)

## Configuration Options

```typescript
interface MECMFDebugConfig {
  enabled: boolean;
  logLevel: "minimal" | "detailed" | "verbose";
  logToFile?: string; // Future: write to file
  includeMemoryContent?: boolean; // Show actual memory content
  maxPromptLength?: number; // Truncate long prompts for readability
}
```

## Programmatic Access

Access debug logs programmatically:

```typescript
import { getGlobalMECMFDebugLogger } from "@atlas/memory";

const logger = getGlobalMECMFDebugLogger();

// Get recent enhancement logs
const recentLogs = logger.getRecentLogs(10);

// Get logs for specific session
const sessionLogs = logger.getLogsForSession("workspace-123");

// Get performance statistics
const avgTime = logger.getAverageEnhancementTime();
const tokenStats = logger.getTokenEfficiencyStats();

console.log(`Average enhancement time: ${avgTime}ms`);
console.log(`Average token change: ${tokenStats.averageTokenChangePercent}%`);
```

## Debug Output Channels

Debug information is written to:

1. **stderr** - When `MECMF_DEBUG=true` environment variable is set
2. **Memory** - Always collected for programmatic access
3. **Future**: File output (configurable via `logToFile`)

## Production Considerations

### Performance Impact

- Debug logging adds ~1-2ms per operation
- Memory usage increases by ~10KB per logged operation
- Logs are automatically rotated (keeps last 100 entries)

### Security

- Memory content logging is optional (`includeMemoryContent: false`)
- Prompts are truncated for privacy (`maxPromptLength`)
- No sensitive information is logged by default

### Recommendations

- Use `detailed` level in development
- Use `minimal` level in production (if needed)
- Enable only for specific debugging sessions
- Monitor memory usage with frequent operations

## Common Debug Patterns

### Check Memory Classification

```bash
export MECMF_DEBUG=true
# Watch logs to see how content gets classified into memory types
```

### Analyze Token Efficiency

```typescript
// After some operations
const stats = logger.getTokenEfficiencyStats();
console.log(`Token reduction: ${stats.averageTokenChangePercent}%`);
```

### Monitor Performance

```typescript
const avgTime = logger.getAverageEnhancementTime();
if (avgTime > 100) {
  console.warn("MECMF enhancement taking longer than 100ms target");
}
```

### Debug Memory Retrieval

Enable `verbose` logging to see:

- Which memories are retrieved for each query
- Relevance scoring details
- Vector search vs fallback usage

## Troubleshooting

### No Debug Output

- Check `MECMF_DEBUG=true` is set
- Verify debug logging is enabled: `logger.isEnabled()`
- Ensure operations are going through MECMF (not bypassing)

### Performance Issues

- Check average enhancement time with `getAverageEnhancementTime()`
- Look for vector search timeouts in logs
- Monitor memory retrieval times

### Memory Classification Issues

- Enable `includeMemoryContent: true`
- Check entity extraction in classification logs
- Verify memory type assignments make sense

This debug system gives you complete visibility into how MECMF enhances your prompts and manages
memory, making it easy to optimize performance and understand the system's behavior.

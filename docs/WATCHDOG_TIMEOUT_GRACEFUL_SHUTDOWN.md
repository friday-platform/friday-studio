# Watchdog Timeout Graceful Shutdown Implementation

## Summary

Implemented graceful shutdown for watchdog timer inactivity timeouts, making it a normal completion
flow rather than an error condition. This allows LLM agents to complete successfully when they don't
produce output within the timeout period, rather than failing with an error.

## Problem Statement

Previously, when an LLM agent didn't produce output within the watchdog timeout period (default 2
minutes), it would:

- Throw an error: "Operation timed out due to inactivity (no progress reported)"
- Mark the session as failed
- Prevent email notifications from being sent
- Log the timeout as an error

This was particularly problematic for workspaces that completed their work but waited for additional
user input.

## Solution Overview

Modified the timeout handling to treat inactivity as a normal completion:

- LLM provider returns empty response instead of throwing error
- Session completes successfully with empty output
- Email notifications are sent with available content
- Improved logging to distinguish between actual errors and expected timeouts

## Implementation Details

### 1. LLM Provider (packages/core/src/llm-provider.ts)

Modified `generateText` method to catch inactivity timeout errors and return gracefully:

```typescript
// Check if this is an inactivity timeout (graceful shutdown scenario)
if (errorMessage.includes("Operation timed out due to inactivity")) {
  logger.info("LLM generation ended due to inactivity timeout", {
    provider: providerConfig.provider,
    model: providerConfig.model,
    duration: Date.now() - startTime,
    reason: "No activity for configured timeout period - graceful shutdown",
  });
  // Return empty response for graceful shutdown
  return {
    text: "",
    toolCalls: [],
    toolResults: [],
    steps: [],
  };
}
```

### 2. Workspace Manager (packages/core/src/workspace-manager.ts)

Improved error handling for `updateWorkspaceStatus` calls:

- Added detection for system workspaces (prefix "atlas-")
- Changed from error to warning level logging
- Added contextual notes explaining why status updates fail for system workspaces

```typescript
const isSystemWorkspace = workspaceId.startsWith("atlas-");
logger.warn("Failed to update workspace status", {
  workspaceId,
  errorMessage,
  isSystemWorkspace,
  note: isSystemWorkspace
    ? "System workspaces are not tracked in registry"
    : "Non-critical - workspace still runs",
});
```

## Behavior Changes

### Before Implementation

- Timeout due to inactivity threw error
- Error propagated through session supervisor
- Logged as error: "Operation timed out due to inactivity (no progress reported)"
- Session marked as failed
- No email notifications sent

### After Implementation

- Timeout due to inactivity returns empty response
- Session completes normally with empty output
- Logged as info: "LLM generation ended due to inactivity timeout"
- Session completes successfully
- User receives email notification (if configured)

## Technical Details

### Watchdog Timer System

The watchdog timer uses two configurable timeouts:

1. **Progress timeout**: Default 2 minutes - operation must report progress
2. **Total timeout**: Default 10 minutes - absolute maximum duration

When no progress is reported within the progress timeout, the operation is aborted with "Operation
timed out due to inactivity".

### Empty Response Handling

Empty responses from LLM agents are valid and handled throughout the system:

- Agent execution actor returns empty string
- Session supervisor includes it in results
- Workspace runtime processes it normally
- Email notifications still sent with available content

### System Workspace Considerations

System workspaces (like atlas-conversation) are not tracked in the registry, so status update
failures are expected and logged as warnings rather than errors.

## Testing and Verification

### 1. Real-World Evidence

Found actual timeout behavior in workspace logs before changes:

```json
{
  "timestamp": "2025-07-30T04:18:53.495Z",
  "level": "error",
  "message": "Agent execution failed",
  "context": {
    "agentId": "email_reporter",
    "error": "Operation timed out due to inactivity (no progress reported)"
  }
}
```

### 2. Test Scenarios

To test the graceful timeout behavior:

1. Create a workspace with email notifications
2. Trigger it with a task that completes quickly
3. Wait for 2+ minutes without providing additional input
4. Verify:
   - Session completes successfully (not failed)
   - Email notification is sent
   - Logs show "graceful shutdown" instead of error

### 3. Verification Methods

To verify the implementation works correctly:

1. **Check logs after deployment:**
   ```bash
   grep -E "inactivity timeout|graceful shutdown" ~/.atlas/logs/workspaces/*.log
   ```

2. **Look for changed log levels:**
   - Old: `"level": "error"` for timeout messages
   - New: `"level": "info"` with "graceful shutdown" in message

3. **Verify session completion:**
   - Sessions should show `"status": "completed"` even after timeout
   - No `"error": "Operation timed out"` in session results

### 4. Edge Cases Covered

- Empty responses are valid throughout the system
- System workspaces (like atlas-conversation) handle status update failures gracefully
- Multiple concurrent sessions handle timeouts independently
- Workspace continues running after individual session timeouts

## Expected Log Examples

### Graceful Shutdown Log

```json
{
  "timestamp": "2025-07-30T12:00:00.000Z",
  "level": "info",
  "message": "LLM generation ended due to inactivity timeout",
  "context": {
    "provider": "anthropic",
    "model": "claude-3.5-sonnet",
    "duration": 120000,
    "reason": "No activity for configured timeout period - graceful shutdown"
  }
}
```

### System Workspace Warning

```json
{
  "timestamp": "2025-07-30T12:00:00.000Z",
  "level": "warn",
  "message": "Failed to update workspace status to running",
  "context": {
    "workspaceId": "atlas-conversation",
    "errorMessage": "Workspace not found",
    "isSystemWorkspace": true,
    "note": "System workspaces are not tracked in registry"
  }
}
```

## Notes

- The timeout behavior only applies to LLM generation operations
- Other types of operations that timeout will still throw errors as before
- The 2-minute default timeout can be configured per workspace
- This change maintains backward compatibility while improving user experience

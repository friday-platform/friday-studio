# Patch: ATLAS-5VT/5VM/5VK/5VH/5V9/5VJ/5V8 — Improve Session Failure Sentry Fingerprinting

## Sentry Issues
| ID | Title | Events |
|----|-------|--------|
| ATLAS-5VT | Session failed | 1 |
| ATLAS-5VM | Session failed | 1 |
| ATLAS-5VK | Session failed | 1 |
| ATLAS-5VH | Session failed | 1 |
| ATLAS-5V9 | Session failed | 1 |
| ATLAS-5VJ | Session actor execution failed | 5 |
| ATLAS-5V8 | Session actor execution failed | 5 |

Links:
- https://tempestteam.sentry.io/issues/ATLAS-5VT/
- https://tempestteam.sentry.io/issues/ATLAS-5VM/
- https://tempestteam.sentry.io/issues/ATLAS-5VK/
- https://tempestteam.sentry.io/issues/ATLAS-5VH/
- https://tempestteam.sentry.io/issues/ATLAS-5V9/
- https://tempestteam.sentry.io/issues/ATLAS-5VJ/
- https://tempestteam.sentry.io/issues/ATLAS-5V8/

## Root Cause
In `atlas-daemon.ts` ~line 1233, `waitForSignalCompletion()` catches all
session failures under the same generic wrapper message. Different
underlying errors (disk full, permission denied, agent crash, etc.) all
appear as one Sentry issue, making triage impossible.

For `ATLAS-5VJ` and `ATLAS-5V8`: `executeAgent()` in the XState machine
transitions to `failed` state. The pattern of 5 events on 2 different
hosts suggests a systematic workspace/agent config failure.

## Fix

### File: `packages/atlas-daemon/src/atlas-daemon.ts`

Add a `categorizeSessionError()` helper and use it in the Sentry capture
call to produce meaningful fingerprints:

```typescript
function categorizeSessionError(sessionError: unknown): {
  category: string;
  fingerprint: string[];
  level: Sentry.SeverityLevel;
} {
  if (!sessionError) {
    return { category: 'unknown', fingerprint: ['session-failed-unknown'], level: 'error' };
  }

  const msg = sessionError instanceof Error
    ? sessionError.message
    : String(sessionError);
  const msgLower = msg.toLowerCase();

  if (msgLower.includes('enoent') || msgLower.includes('no such file')) {
    return { category: 'filesystem', fingerprint: ['session-failed-enoent'], level: 'warning' };
  }
  if (msgLower.includes('eacces') || msgLower.includes('permission denied')) {
    return { category: 'permissions', fingerprint: ['session-failed-permissions'], level: 'warning' };
  }
  if (msgLower.includes('timeout') || msgLower.includes('timed out')) {
    return { category: 'timeout', fingerprint: ['session-failed-timeout'], level: 'warning' };
  }
  if (msgLower.includes('agent') || msgLower.includes('xstate') || msgLower.includes('actor')) {
    return { category: 'agent-execution', fingerprint: ['session-failed-agent-execution', msg.slice(0, 100)], level: 'error' };
  }
  if (msgLower.includes('model') || msgLower.includes('llm')) {
    return { category: 'llm', fingerprint: ['session-failed-llm'], level: 'error' };
  }

  return { category: 'other', fingerprint: ['session-failed', msg.slice(0, 100)], level: 'error' };
}

// In waitForSignalCompletion() where the session error is captured:
// Before:
Sentry.captureException(new Error(`Session failed`), { extra: { sessionError } });

// After:
const sessionErr = session.error ?? sessionError;
const { category, fingerprint, level } = categorizeSessionError(sessionErr);
Sentry.captureException(
  sessionErr instanceof Error ? sessionErr : new Error(`Session failed: ${category}`),
  {
    level,
    fingerprint,
    extra: { sessionId: session.id, category, rawError: String(sessionErr) },
  }
);
```

### File: `packages/atlas-daemon/src/execute-agent.ts` (or XState machine)

For `executeAgent()` failures, extract the agent name and error cause
before sending to Sentry:

```typescript
// In the XState 'failed' state handler:
Sentry.captureException(error, {
  fingerprint: ['agent-execution-failed', agentId],
  extra: {
    agentId,
    workspaceId,
    sessionId,
  },
  tags: {
    agent_id: agentId,
  },
});
```

## Testing
1. Trigger a session failure with each of the known failure modes
   (missing file, permission error, agent crash).
2. Verify Sentry receives separate issues for each category.
3. Verify ATLAS-5VJ/5V8 pattern shows the agent ID in extras.

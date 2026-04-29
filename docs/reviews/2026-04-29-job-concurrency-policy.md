# Review: Job Concurrency Policy

**Date:** 2026-04-29
**Branch:** main (uncommitted working tree)
**Verdict:** Needs Work

## Summary

Adds `JobConcurrencyPolicy` (`single-flight` | `isolated`) to `FSMJob`. Default jobs now reject concurrent signals; `handle-chat` uses `isolated` so multiple chats can run concurrently on fresh per-session engines. The core concurrency logic is correct. One concrete bug needs fixing before this ships; one disk accumulation issue needs a follow-up; and zero tests cover any of the new behaviors.

## Critical

None.

## Important

**1. `handleSessionCompletion` still reads `job?.engine?.documents` — always `[]` for isolated jobs**
`runtime.ts:2921`

```ts
const docs = job?.engine?.documents.filter((d) => !plumbingTypes.has(d.type)) ?? [];
this.completedSessionDocuments.set(sessionResult.id, docs);
```

`job.engine` is only set by `initializeJobEngine`, which is skipped for isolated jobs. So `completedSessionDocuments` is always `[]` for any isolated session. `sessionResult.engineDocuments` is already populated at this point (captured in the `finally` block before `processSignalForJob` returns). Fix:

```ts
const docs = (sessionResult.engineDocuments ?? []).filter((d) => !plumbingTypes.has(d.type));
```

No user-visible impact today — `handle-chat` is not called via `triggerSignalAndWait` — but this will silently produce empty output the first time any isolated job is invoked through the job-tool path.

Worth doing: **Yes** — one-line fix, and the context is hot.

---

**2. Isolated session `FileSystemDocumentStore` files are never cleaned up**
`runtime.ts:~1171`

Each isolated session writes to `~/.atlas/workspaces/{workspaceId}/sessions/{sessionId}/...`. The `documentStore` reference lives in the `processSignalForJob` closure but is never passed to a cleanup call. For `handle-chat` the FSM is simple (one `chat-result` document plus a few plumbing files), so the per-session cost is small. But it accumulates without bound across all chat sessions.

A `rm` of the session directory in the `finally` block after snapshotting `session.engineDocuments` would close this. Not urgent for the current `handle-chat` usage rate, but needs addressing before isolated policy is used for heavier jobs.

Worth doing: **No in this PR** — low severity now, but track as a follow-up.

## Tests

Zero test coverage for any of the new behaviors. No test file references `activeJobExecutions`, `single-flight`, `isolated`, `engineDocuments`, `finalState`, or the new `hasActiveSessionsForSignal` branch.

Missing tests in priority order:

1. **Single-flight concurrent rejection** — two overlapping `processSignal` calls on the same job; second must throw `"Job '...' is already processing"`. Highest value — tests the core invariant.

2. **Isolated concurrent success** — two concurrent `processSignal` calls with `concurrency: "isolated"` must both complete. Also: assert `handle-chat`'s registered job has `concurrency === "isolated"` so a dropped line doesn't silently revert it to single-flight.

3. **`activeJobExecutions` cleanup on error** — mock `createJobEngine` to throw for a single-flight job; first call throws; second call must fail with the engine error, not the concurrency error. Without this, a bug in the error path permanently locks the job.

4. **`activeJobExecutions` cleanup on success** — two sequential `processSignal` calls on the same single-flight job must both complete. Guards against the finally-block cleanup being misplaced.

5. **`hasActiveSessionsForSignal` in-flight detection** — call during the concurrent overlap window (before the session appears in `this.sessions`) and assert `true`. This is the specific race the change was written to fix.

6. **`engineDocuments` capture** — strengthen the existing session-summary test to assert `completedPhases > 0` after a session with real state transitions; the current test passes even if `engineDocuments` is never set.

## Needs Decision

None — the issues above have clear recommended actions.

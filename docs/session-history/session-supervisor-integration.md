# Session Supervisor Integration Plan

1. **Inject history storage into `SessionSupervisorActor`**
   - Update `src/core/actors/session-supervisor-actor.ts` constructor to accept a `historyStorage` dependency exposing `createSessionRecord`, `appendSessionEvent`, `markSessionComplete`, `listSessions`, and `loadSessionTimeline`. Provide a default that opens `packages/core/src/session/history-storage.ts`.
   - Store the dependency on `this.historyStorage` and ensure `SessionSupervisorActor.create()` (or factory helpers) pass it through. Update tests/mocks to supply an in-memory fake.
   - When the supervisor is instantiated with an open `Deno.Kv`, hand it through to the storage helper so all persistence in a session shares the same connection.

2. **Persist session metadata during initialization**
   - Within `initializeSession`, gather the metadata defined in the storage plan: `sessionId`, `workspaceId`, timestamps, signal info, job spec id, available agents, optional stream id, raw signal payload, and any artifact ids or summary data already known.
   - Call `await this.historyStorage.createSessionRecord(metadataInput)` before any execution begins; on failure, log via `@atlas/logger` and continue (storage must never block the session).
   - Emit a `session-start` event immediately after metadata is written so chronological viewers always have an opening entry.

3. **Log execution plan and supervisor state changes**
   - In `createExecutionPlan`, after the plan is finalized, persist a `plan-created` event containing the plan JSON, summarised reasoning, and chosen strategy. When the plan mutates (replan/retry), append `plan-updated`.
   - Wrap supervisor-controlled transitions (queued → running, retry scheduled, cancellation received, etc.) in helper methods that call `appendSessionEvent` with `supervisor-action` payloads capturing the prior state, new state, and rationale.
   - Ensure events include `context` with `phaseId` or `executionId` when available so downstream UI grouping aligns with the data model.

4. **Capture phase and agent lifecycle events**
   - On phase entry/exit in `executePhase`, append `phase-start` and `phase-complete` events including ordered agent ids, phase goals, and summarized outputs. Record durations by calculating `Date.now()` differences before writing.
   - Inside `executeAgent`, emit `agent-start` (prompt summary, inputs, tool availability) before invoking the handler. After completion, persist `agent-output` with normalized reasoning, text output, structured payload, tool usage, artifacts, and usage metrics.
   - When orchestration fails or exceeds retry limits, write `agent-error` and `agent-retry` events with error stack, retry count, and supervisor decision.
   - Stream tool activity by wiring orchestrator callbacks (e.g., `onToolCall`, `onToolResult`) to storage adapters defined in Phase 1 so each tool interaction becomes `agent-tool-call` / `agent-tool-result` events linked by `toolCallId`.

5. **Persist validation, memory, and completion outcomes**
   - In `handlePostExecutionValidation` and `validateAgentResult`, append `validation-result` entries that capture the validator name, score, hallucination analysis, and remediation decision.
   - When the session triggers memory writes or supervisor remediation, log `memory-update` or `supervisor-action` events summarizing the payload that reached memory or the decision made.
   - Centralize finalization logic (`emitSessionFinish` / shutdown path) to call `markSessionComplete(sessionId, status, finishedAt, summary)`; include failure reason/context when status is not success. Append a terminal `session-finish` event for timeline completeness.
   - Guard all storage writes with `void this.historyStorage.appendSessionEvent(...).catch(err => logger.error(...))` so the main execution path never awaits retries after initial persistence.

6. **Expose history-backed views through the `Session` facade**
   - Update `src/core/session.ts` (and any exported `Session` helpers) to pull metadata/events from the storage module when available, falling back to in-memory state for actively running sessions.
   - Replace direct references to actor-held arrays (e.g., cached agent results) with calls to the new read APIs (`getSessionMetadata`, `listSessions`, `loadSessionTimeline`) so API consumers see the durable source of truth.
   - Ensure artifact retrieval merges persisted timeline events with actor in-memory artifacts during execution to maintain backward compatibility for live sessions. `loadSessionTimeline` performs a single prefix scan to rebuild the ordered event list; incremental streaming can land later.

7. **Validation checklist**
   - Manually verify with the daemon CLI that a sample session persists to KV and that the history API (wired in Phase 3) can reconstruct the sequence without assistance from in-memory state.

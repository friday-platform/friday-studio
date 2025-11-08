# Session History Backend Plan

## Current Behavior

- `src/core/actors/session-supervisor-actor.ts`: session context + plan in memory, emits SSE, caches `ExecutionPlan`, collects `AgentResult[]`, writes artifacts locally, no durable log, minimal agent reasoning capture, orchestration events not persisted.
- `src/core/session.ts`: thin wrapper over actor, status derived from actor promise, exposes artifacts via actor snapshot, no storage adapter hook, cancellation/completion limited to in-memory context.
- `packages/system/agents/session-supervisor/session-supervisor.agent.ts`: optimizes prompts, no persistent output structure, returns `success(object)` without standardized response typing for reasoning/tool metadata.

## Gaps vs Session History Goals

- Need append-only durable log keyed by session so UI can rebuild timeline (signal payload, plan, phases, agent steps, supervisor actions, validation, final state).
- Need incremental writes during execution (session start, plan ready, agent start/finish, retries, hallucination checks, stream events) not just final summary.
- Need consistent agent output payload to capture reasoning/text/tool data regardless of LLM vs MCP agent.
- API currently exposes only live runtime data; must surface stored sessions incl. completed/evicted ones.

## Storage & Data Model

- Detailed implementation plan lives in `docs/session-history/storage-and-data-model.md`. This doc now scopes that workstream so related changes stay self-contained.

## Session Supervisor Integration

1. Inject storage dependency into `SessionSupervisorActor` (import storage helpers).
   - `initializeSession`: persist session metadata (signal id/provider, payload snapshot/hashed, job spec id, available agents) via `recordSessionStart`.
   - `createExecutionPlan`: after plan ready persist `plan-created` event (plan JSON, reasoning, strategy).
   - `executeSession`: before loop emit `supervisor-action` for status transitions; keep `sessionId` storage handle.
   - `executePhase`: log `phase-start` and `phase-end` with agent list and strategy.
   - `executeAgent`: add `agent-start` event capturing prompt summary + derived context; after result log `agent-finish` with duration, output summary, tool call metadata; when orchestrator reports error log `agent-error/timeout`. Capture reasoning/tool data from standardized agent result (see below).
   - `handlePostExecutionValidation` / `validateAgentResult`: append `supervisor-action` events for retries, hallucination detections, validation scores.
   - `emitSessionFinish` / `shutdown`: persist `session-finish` status + duration; ensure final status stored even on error/cancel.
   - Ensure writes are awaited but shield session execution (wrap in `void storageFn().catch(log)` to avoid blocking).
2. Update `getExecutionArtifacts` / `Session` wrapper to fetch from storage when needed (e.g., `Session.getArtifacts` should read persisted events or summary; maintain backward compatibility for live sessions by merging in-memory when storage not yet consistent).
3. Consider memory cleanup: once stored, actor can drop heavy arrays earlier.

## Agent Output Standardization

1. Redefine `AgentHandler` signature in `packages/agent-sdk/src/types.ts` to return `Promise<TOutput | AgentGeneratedOutput<TOutput>>` where `AgentGeneratedOutput` wraps:
   - `result`: primary payload (text or structured)
   - optional `text`, `reasoning`, `steps`, `toolCalls`, `toolResults`, `usage`, `response` (matching AI SDK generate/streamText fields).
2. Update agent SDK utilities and existing core/system agents to return new shape (ensure backwards compatibility by normalizing old returns inside `createAgent`).
3. Adjust `AgentOrchestrator` and `SessionSupervisorActor` to expect normalized agent results containing `reasoning`, `outputText`, etc., and persist them to storage/log.
4. Document contract in CLAUDE/README for agent authors.

## API & Retrieval

1. Extend daemon session routes:
   - `GET /api/sessions/history`: list stored sessions via storage list helper with pagination + filters.
   - `GET /api/sessions/:id/history`: return metadata + ordered event timeline + derived summary (reconstruct phases, agent ordering).
   - Optionally `GET /api/sessions/:id/events?cursor=` for incremental fetch for UI streaming.
2. Wire routes to new storage module; fall back to live runtime session if storage entry absent (ongoing execution).
3. Update OpenAPI schema & client types if applicable.

## Additional Considerations

- Add unit/integration tests for storage helpers (ordering, pagination, survival across restarts).
- Add actor integration test verifying event log creation for simple session run.
- Ensure storage writes guard against large payloads (truncate/serialize jobs, maybe store references to artifacts instead of full data).
- Ensure concurrent sessions safe by using KV keys with timestamp+uuid ordering.
- Provide migration/cleanup utility (TTL or manual prune) once history grows.

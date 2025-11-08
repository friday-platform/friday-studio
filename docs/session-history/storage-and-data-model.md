# Storage & Data Model Implementation Plan

1. **Introduce typed KV wrapper**
   - Add `packages/core/src/session/history-storage.ts` (mirrors chat storage organization) and export through `packages/core/mod.ts`.
   - Reuse `storage.db` path with key helpers:
     - `["session_history", "metadata", sessionId]` → immutable metadata record.
     - `["session_history", "event", sessionId, isoTimestamp, eventId]` → append-only event log.
     - `["session_history", "index", workspaceId, createdAt, sessionId]` → secondary index for history listings.
   - Allow callers to inject an open `Deno.Kv` for batch work; otherwise open/close per helper invocation.

2. **Define canonical metadata schemas**
   - Create `SessionHistoryMetadata` interface + Zod schema capturing: `sessionId`, `workspaceId`, `createdAt`, `updatedAt`, `status` (`ReasoningResultStatusType`), `signal` (`IWorkspaceSignal`), raw `signalPayload`, `signalPayloadDigest` (sha256 of JSON stringified payload), `jobSpecificationId`, `availableAgents` (string IDs), `streamId`, `configSnapshot` (subset of `SessionSupervisorConfig` required for replay).
   - Persist full `artifactIds` and any additional context fields without truncation so downstream tooling can recreate the exact session inputs.
   - Export these types as the source of truth for API/UI consumers; avoid `Partial` fields—mark optional attributes explicitly.

3. **Model timeline events with strict typing**
   - Introduce `SessionHistoryEventBase` (`eventId`, `sessionId`, `emittedAt`, `emittedBy`, `type`, `context`) and build a discriminated union:
     - Planning: `plan-created`, `plan-updated`.
     - Phases: `phase-start`, `phase-complete`.
     - Agents: `agent-start`, `agent-output`, `agent-error`, `agent-tool-call`, `agent-tool-result`, `agent-retry`.
     - Supervisor/system: `session-start`, `supervisor-action`, `validation-result`, `memory-update`, `session-finish`.
   - Reuse existing shapes where possible:
     - Embed `AgentSnapshot` that wraps `AgentResult` plus AI SDK fields (`ReasoningOutput`, `TypedToolCall`, `TypedToolResult`, `LanguageModelUsage`). Snapshot stores the data the UI renders per agent block: `inputData` (structured + raw), `promptSummary`, `reasoning`, `toolCalls[]` (each with arguments, status), `toolResults[]` (each with output/error), `outputText`, `structuredOutput`, `artifacts`.
     - Tool call/result events store `TypedToolCall` / `TypedToolResult` from the AI SDK, linking via `toolCallId`.
     - Validation events reuse `HallucinationAnalysis`.
   - Add Zod schemas for each variant; store complete payloads (inputs, reasoning, outputs, tool args/results) so the UI can render the full session story without post-processing.
   - `context` captures identifiers used for UI grouping: `phaseId`, `agentId`, `executionId` (unique per agent run), and optional `relatedEventId` to correlate tool call/result pairs.

4. **Implement write helpers**
   - `createSessionRecord(metadataInput: CreateSessionMetadata)` hashes payload, writes metadata, and seeds the workspace index within a single `atomic()` call.
   - `appendSessionEvent(sessionId, eventInput)` validates with the event schema, generates monotonic `eventId` (UUID) and ISO timestamp, writes to KV, and updates `updatedAt` via `atomic()`.
   - `markSessionComplete(sessionId, status, finishedAt, summary?)` updates `status`, `updatedAt`, `durationMs`, `failureReason`.
   - Return `Result<T, string>` from helpers (matching `ChatStorage` ergonomics) and log failures through `@atlas/logger`.

5. **Provide read/query utilities**
   - `getSessionMetadata(sessionId)` and `streamSessionEvents(sessionId, { cursor?, limit })` expose typed responses; `cursor` is last `[timestamp, eventId]`.
   - `listSessions({ workspaceId, limit, cursor })` iterates workspace index keys to produce `SessionHistoryListItem` (id, status, started/ended timestamps, cached agent/phase counts).
   - `loadSessionTimeline(sessionId)` hydrates metadata + ordered events into a timeline DTO for API consumption.

6. **Publish normalization adapters**
   - `toAgentSnapshot(result: AgentResult)` extracts reasoning, tool usage, and AI SDK usage stats without redefining types.
   - `toToolCallEvent` / `toToolResultEvent` accept `ToolCallPart` / `ToolResultPart` from streaming so the actor persists incremental updates with zero new types.
   - Export adapters for reuse by `SessionSupervisorActor`, API handlers, and potential replay jobs to ensure a single serialization path.

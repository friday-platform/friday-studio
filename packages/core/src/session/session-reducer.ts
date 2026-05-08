/**
 * Session event reducer — pure function that transforms a stream of
 * `SessionStreamEvent | EphemeralChunk` into a `SessionView`.
 *
 * Shared by client (streamedQuery), server (JSON endpoint), and
 * finalization (pre-computed summaries). Single source of truth for
 * "how events become a session view."
 *
 * @module
 */

import type {
  AgentBlock,
  EphemeralChunk,
  SessionStreamEvent,
  SessionView,
} from "./session-events.ts";

/**
 * Returns an empty SessionView suitable as the initial accumulator
 * for the reducer.
 */
export function initialSessionView(): SessionView {
  return {
    sessionId: "",
    workspaceId: "",
    jobName: "",
    task: "",
    status: "active",
    startedAt: "",
    agentBlocks: [],
  };
}

/**
 * Pure reducer: folds a single event into the current SessionView,
 * returning a new SessionView (no mutation).
 */
export function reduceSessionEvent(
  view: SessionView,
  event: SessionStreamEvent | EphemeralChunk,
): SessionView {
  // Ephemeral chunks lack `type` — discriminate by presence of `chunk` field
  if ("chunk" in event) {
    return reduceEphemeral(view, event);
  }

  switch (event.type) {
    case "session:start":
      // Idempotent: if a session:start has already been folded in for this
      // sessionId, treat duplicates as no-ops. Without this guard a
      // republished session:start (e.g. when `save()` re-publishes events
      // that fell outside JetStream's `duplicate_window`) RESETS the view
      // back to status="active" and wipes `agentBlocks`, even after
      // session:complete has already been processed. That's the read-path
      // bug that surfaces as "stuck on running" in the detail endpoint.
      if (view.sessionId === event.sessionId) {
        return view;
      }
      return {
        ...view,
        sessionId: event.sessionId,
        workspaceId: event.workspaceId,
        jobName: event.jobName,
        task: event.task,
        status: "active",
        startedAt: event.timestamp,
        agentBlocks:
          event.plannedSteps?.map((step) => ({
            stepNumber: undefined,
            agentName: step.agentName,
            stateId: step.stateId,
            actionType: step.actionType,
            task: step.task,
            status: "pending" as const,
            toolCalls: [],
            output: undefined,
          })) ?? [],
      };

    case "step:start":
      return reduceStepStart(view, event);

    case "step:complete":
      return reduceStepComplete(view, event);

    case "step:skipped":
      return reduceStepSkipped(view, event);

    case "step:validation":
      // Validation pills are rendered via the playground accumulator (Task #28/#29);
      // they do not aggregate into SessionView state.
      return view;

    case "session:complete": {
      // Idempotent: a duplicate session:complete (republished by `save()`
      // outside the broker's `duplicate_window`, or replayed by a stream
      // consumer) must not re-stamp `completedAt`/`durationMs` to a
      // diverging value. If the session is already terminal, no-op.
      // First-wins is the safe semantic: the original terminal event
      // captured the session's actual outcome; a re-publish of identical
      // content is redundant, and a payload-divergent re-publish (which
      // shouldn't happen with Nats-Msg-Id dedup but defends against
      // upstream bugs) would otherwise corrupt the view.
      if (view.status !== "active" && view.completedAt) {
        return view;
      }

      // Transition any remaining pending blocks to skipped
      const finalizedBlocks = view.agentBlocks.map((block) =>
        block.status === "pending" ? { ...block, status: "skipped" as const } : block,
      );

      // Collect per-agent structured output into a session-level results map
      const results: Record<string, unknown> = {};
      for (const block of finalizedBlocks) {
        if (block.status === "completed" && block.output != null) {
          results[block.agentName] = block.output;
        }
      }
      return {
        ...view,
        agentBlocks: finalizedBlocks,
        status: event.status,
        completedAt: event.timestamp,
        durationMs: event.durationMs,
        results: Object.keys(results).length > 0 ? results : undefined,
        error: event.error,
      };
    }

    case "session:summary":
      return { ...view, aiSummary: { summary: event.summary, keyDetails: event.keyDetails } };
  }
}

/**
 * Convenience: reduce a full event array to a SessionView.
 */
export function buildSessionView(events: SessionStreamEvent[]): SessionView {
  return events.reduce(reduceSessionEvent, initialSessionView());
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function reduceStepStart(
  view: SessionView,
  event: SessionStreamEvent & { type: "step:start" },
): SessionView {
  // Idempotent on (stepNumber, agentName, startedAt): if a block already
  // exists with the same triple, this event is a duplicate publish (e.g.
  // `save()` republishing events outside JetStream's `duplicate_window`).
  // Without this guard, the duplicate falls through to the "no matching
  // pending block" branch below and APPENDS a second running block on top
  // of the already-completed one — the resulting view shows the same agent
  // twice, the second stuck running.
  //
  // We include `startedAt` in the key (not just stepNumber+agentName) so
  // a legitimate FSM re-entry — retry, loop, planned re-execution — that
  // emits a NEW step:start with a NEW timestamp is correctly admitted as
  // a new step rather than silently dropped. Republishes from `save()`
  // carry the original event payload byte-for-byte, so they share the
  // original timestamp and are filtered out here.
  if (
    view.agentBlocks.some(
      (b) =>
        b.stepNumber === event.stepNumber &&
        b.agentName === event.agentName &&
        b.startedAt === event.timestamp,
    )
  ) {
    return view;
  }

  // Find first pending block with matching agentName
  const pendingIdx = view.agentBlocks.findIndex(
    (b) => b.status === "pending" && b.agentName === event.agentName,
  );

  if (pendingIdx !== -1) {
    // Transition pending → running in-place (preserve array position)
    const pending = view.agentBlocks[pendingIdx];
    if (!pending) return view;
    const updated: AgentBlock = {
      ...pending,
      stepNumber: event.stepNumber,
      stateId: event.stateId ?? pending.stateId,
      actionType: event.actionType,
      task: event.task,
      input: event.input,
      status: "running",
      startedAt: event.timestamp,
    };
    const blocks = [...view.agentBlocks];
    blocks[pendingIdx] = updated;
    return { ...view, agentBlocks: blocks };
  }

  // No matching pending block — append new block (backward compat + dynamic steps)
  return {
    ...view,
    agentBlocks: [
      ...view.agentBlocks,
      {
        stepNumber: event.stepNumber,
        agentName: event.agentName,
        stateId: event.stateId,
        actionType: event.actionType,
        task: event.task,
        input: event.input,
        status: "running",
        startedAt: event.timestamp,
        toolCalls: [],
        output: undefined,
      },
    ],
  };
}

function reduceStepComplete(
  view: SessionView,
  event: SessionStreamEvent & { type: "step:complete" },
): SessionView {
  const idx = view.agentBlocks.findIndex((b) => b.stepNumber === event.stepNumber);

  if (idx === -1) {
    // No matching step:start — create a placeholder block
    const placeholder: AgentBlock = {
      stepNumber: event.stepNumber,
      agentName: "unknown",
      actionType: "agent",
      task: "",
      status: event.status,
      durationMs: event.durationMs,
      toolCalls: event.toolCalls,
      reasoning: event.reasoning,
      output: event.output,
      artifactRefs: event.artifactRefs,
      error: event.error,
    };
    return { ...view, agentBlocks: [...view.agentBlocks, placeholder] };
  }

  const existing = view.agentBlocks[idx];
  if (!existing) return view;

  // Idempotent: if the block is already in a terminal status, this is a
  // duplicate `step:complete` (e.g. `save()` republish landing outside
  // JetStream's `duplicate_window`). Re-applying would re-stamp
  // `durationMs`/`output`/`toolCalls`. Identical-payload duplicates would
  // overwrite to the same values (no-op), but a payload-divergent
  // re-publish (which shouldn't happen with Nats-Msg-Id dedup but defends
  // against upstream bugs) would corrupt the block. First-wins.
  if (
    existing.status === "completed" ||
    existing.status === "failed" ||
    existing.status === "skipped" ||
    existing.status === "cancelled"
  ) {
    return view;
  }

  const updated: AgentBlock = {
    ...existing,
    status: event.status,
    durationMs: event.durationMs,
    toolCalls: event.toolCalls,
    reasoning: event.reasoning,
    output: event.output,
    artifactRefs: event.artifactRefs,
    error: event.error,
    ephemeral: undefined, // clear ephemeral on completion
  };
  const blocks = [...view.agentBlocks];
  blocks[idx] = updated;
  return { ...view, agentBlocks: blocks };
}

function reduceStepSkipped(
  view: SessionView,
  event: SessionStreamEvent & { type: "step:skipped" },
): SessionView {
  const pendingIdx = view.agentBlocks.findIndex(
    (b) => b.stateId === event.stateId && b.status === "pending",
  );

  if (pendingIdx === -1) return view;

  const pending = view.agentBlocks[pendingIdx];
  if (!pending) return view;

  const blocks = [...view.agentBlocks];
  blocks[pendingIdx] = { ...pending, status: "skipped" as const };
  return { ...view, agentBlocks: blocks };
}

function reduceEphemeral(view: SessionView, event: EphemeralChunk): SessionView {
  // Match on stepNumber when the publisher provided it; otherwise (user-agent
  // SDK publishes have no stepNumber — the agent subprocess doesn't know its
  // FSM step) attach to the currently-running block.
  const idx =
    event.stepNumber != null
      ? view.agentBlocks.findIndex((b) => b.stepNumber === event.stepNumber)
      : view.agentBlocks.findIndex((b) => b.status === "running");
  if (idx === -1) {
    // No matching block — silently ignore
    return view;
  }

  const existing = view.agentBlocks[idx];
  if (!existing) return view;

  const updated: AgentBlock = {
    ...existing,
    ephemeral: [...(existing.ephemeral ?? []), event.chunk],
  };
  const blocks = [...view.agentBlocks];
  blocks[idx] = updated;
  return { ...view, agentBlocks: blocks };
}

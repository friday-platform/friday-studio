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
    case "session:start": {
      // Out-of-order tolerance: step:start can arrive before session:start.
      // The ordering hazard isn't in JetStream itself (it preserves subject
      // publish order) — it's in `NatsSessionStream.emit()`, which calls
      // `appendEvent` fire-and-forget, so two back-to-back emits can race
      // at `js.publish` ack time. When step:start lands first,
      // reduceStepStart already created a "running" block carrying the
      // signal `input` snapshot; this case must not destroy it. Pre-fix
      // the page rendered "No input provided" + the planned task because
      // session:start wiped the populated block.
      const planned =
        event.plannedSteps?.map((step) => ({
          stepNumber: undefined as number | undefined,
          agentName: step.agentName,
          stateId: step.stateId,
          actionType: step.actionType,
          task: step.task,
          status: "pending" as const,
          toolCalls: [],
          output: undefined,
        })) ?? [];

      // Union: layer planned entries onto matching existing blocks (by
      // stateId) AND keep any existing block whose stateId doesn't appear
      // in plannedSteps — those came from out-of-order step:starts (or
      // dynamic/replanned steps) and must survive. plannedSteps may be
      // empty/undefined entirely (some publishers omit it); in that case
      // every existing block is preserved verbatim.
      const matchedStateIds = new Set<string>();
      const fromPlanned = planned.map((plannedBlock) => {
        if (!plannedBlock.stateId) return plannedBlock;
        const existing = view.agentBlocks.find((b) => b.stateId === plannedBlock.stateId);
        if (!existing) return plannedBlock;
        matchedStateIds.add(plannedBlock.stateId);
        // Layer the planned `task` (descriptive label) on top of the
        // running block's typically-empty step-start task, but keep every
        // other field — status, input, startedAt — from the already-running
        // block. `actionType` is always assigned by reduceStepStart on a
        // running block so we don't need to fall back to plannedBlock.
        return {
          ...existing,
          task: existing.task && existing.task.length > 0 ? existing.task : plannedBlock.task,
        };
      });
      const orphans = view.agentBlocks.filter((b) => !b.stateId || !matchedStateIds.has(b.stateId));
      const mergedBlocks = [...fromPlanned, ...orphans];

      return {
        ...view,
        sessionId: event.sessionId,
        workspaceId: event.workspaceId,
        jobName: event.jobName,
        task: event.task,
        status: "active",
        startedAt: event.timestamp,
        agentBlocks: mergedBlocks,
      };
    }

    case "step:start":
      return reduceStepStart(view, event);

    case "step:complete":
      return reduceStepComplete(view, event);

    case "step:skipped":
      return reduceStepSkipped(view, event);

    case "session:complete": {
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
  // Defense in depth (J2 / review H1): if a `step:start` for this exact
  // (stepNumber, agentName) pair already lives in the view, treat the
  // re-publish as a no-op. Pre-J2 the broker dedup window (default 2m)
  // was shorter than long-running FSM jobs, so a `save()` republish past
  // the window landed as a NEW message. The reducer would then fail to
  // find a *pending* match (the prior copy was already running/done) and
  // append a duplicate block — status derivation then saw both pending
  // and complete simultaneously, surfacing as `status: "active"` post-
  // completion. The dedup_window bump fixes the broker side; this guard
  // protects the reducer regardless.
  //
  // The reducer is a pure function shared with browser clients, so we don't
  // log from here. Operators investigating "is this
  // guard firing in production?" should check the NATS dedup-rejection
  // counter (`nats stream info SESSION_EVENTS` reports duplicates) and
  // grep daemon logs for "step:start" with the same (stepNumber,
  // agentName). A non-zero dedup rate paired with this guard firing
  // means the dedup_window is still too short and should be raised.
  if (event.stepNumber !== undefined) {
    const dupIdx = view.agentBlocks.findIndex(
      (b) => b.stepNumber === event.stepNumber && b.agentName === event.agentName,
    );
    if (dupIdx !== -1) return view;
  }

  // Find first pending block with matching agentName. If agentName drifts
  // (e.g. the FSM action emits `actionId: undefined`, which
  // `mapActionToStepStart` falls back to "unknown" while the planned block
  // carries the real agentId), fall back to matching by `stateId` — the
  // FSM state name is a stable join key between `session:start.plannedSteps`
  // and the action execution event, regardless of how the name happened to
  // be projected onto the action.
  let pendingIdx = view.agentBlocks.findIndex(
    (b) => b.status === "pending" && b.agentName === event.agentName,
  );
  if (pendingIdx === -1 && event.stateId) {
    pendingIdx = view.agentBlocks.findIndex(
      (b) => b.status === "pending" && b.stateId === event.stateId,
    );
  }

  if (pendingIdx !== -1) {
    // Transition pending → running in-place (preserve array position).
    // Keep the planned block's agentName when we matched via stateId so the
    // UI doesn't relabel "Pr Reviewer" → "unknown" mid-transition.
    const pending = view.agentBlocks[pendingIdx];
    if (!pending) return view;
    const updated: AgentBlock = {
      ...pending,
      stepNumber: event.stepNumber,
      stateId: event.stateId ?? pending.stateId,
      agentName:
        pending.agentName && pending.agentName !== "unknown" ? pending.agentName : event.agentName,
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
  // Primary match: stepNumber. Fallback: stateId — covers the case where
  // step:start never transitioned the planned block (so its stepNumber is
  // still undefined) but a step:complete with the same FSM stateId arrived.
  // Without this fallback the reducer would synthesize an "unknown"
  // placeholder block alongside the original pending block, surfacing the
  // duplicate "Pr Reviewer · Skipped + Unknown · Succeeded" pair we hit
  // in the session view.
  let idx = view.agentBlocks.findIndex((b) => b.stepNumber === event.stepNumber);
  if (idx === -1 && event.stateId) {
    idx = view.agentBlocks.findIndex((b) => b.stateId === event.stateId);
  }

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
      // Surface step:complete.usage on the placeholder block too so
      // out-of-order completions (no preceding step:start) don't drop
      // token counts that downstream UI relies on.
      usage: event.usage,
    };
    return { ...view, agentBlocks: [...view.agentBlocks, placeholder] };
  }

  const existing = view.agentBlocks[idx];
  if (!existing) return view;

  const updated: AgentBlock = {
    ...existing,
    // Backfill stepNumber if we matched the block via stateId fallback —
    // the block may have been stuck without a stepNumber when step:start
    // never transitioned it.
    stepNumber: existing.stepNumber ?? event.stepNumber,
    status: event.status,
    durationMs: event.durationMs,
    toolCalls: event.toolCalls,
    reasoning: event.reasoning,
    output: event.output,
    artifactRefs: event.artifactRefs,
    error: event.error,
    ephemeral: undefined, // clear ephemeral on completion
    // Aggregate step:complete.usage onto the parent agentBlock. Prefer the
    // just-arrived event's usage; fall back to any value
    // already present (mid-flight reducer replays should not regress).
    usage: event.usage ?? existing.usage,
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

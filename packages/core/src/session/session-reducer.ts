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
  const idx = view.agentBlocks.findIndex((b) => b.stepNumber === event.stepNumber);
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

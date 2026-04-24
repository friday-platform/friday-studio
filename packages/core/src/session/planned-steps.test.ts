import type { FSMDefinition } from "@atlas/fsm-engine";
import { describe, expect, test } from "vitest";

import { extractPlannedSteps } from "./planned-steps.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal FSM definition builder for tests */
function makeDef(
  overrides: Partial<FSMDefinition> & { states: FSMDefinition["states"] },
): FSMDefinition {
  return { id: "test-fsm", initial: "idle", ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extractPlannedSteps", () => {
  test("returns empty array for FSM with no agent/LLM actions", () => {
    const def = makeDef({
      states: {
        idle: { entry: [{ type: "emit", event: "READY" }], on: { ADVANCE: { target: "done" } } },
        done: { type: "final" },
      },
    });

    expect(extractPlannedSteps(def)).toEqual([]);
  });

  test("collects agent entry actions in traversal order", () => {
    const def = makeDef({
      states: {
        idle: { on: { ADVANCE: { target: "step_1" } } },
        step_1: {
          entry: [{ type: "agent", agentId: "researcher", outputTo: "research_result" }],
          on: { ADVANCE: { target: "step_2" } },
        },
        step_2: {
          entry: [{ type: "agent", agentId: "writer", outputTo: "write_result" }],
          on: { ADVANCE: { target: "completed" } },
        },
        completed: { type: "final" },
      },
    });

    expect(extractPlannedSteps(def)).toEqual([
      { agentName: "researcher", stateId: "step_1", actionType: "agent" },
      { agentName: "writer", stateId: "step_2", actionType: "agent" },
    ]);
  });

  test("collects LLM entry actions using outputTo as agentName", () => {
    const def = makeDef({
      states: {
        idle: { on: { ADVANCE: { target: "step_1" } } },
        step_1: {
          entry: [
            {
              type: "llm",
              provider: "openai",
              model: "gpt-4",
              prompt: "summarize",
              outputTo: "summary_result",
            },
          ],
          on: { ADVANCE: { target: "completed" } },
        },
        completed: { type: "final" },
      },
    });

    expect(extractPlannedSteps(def)).toEqual([
      { agentName: "summary_result", stateId: "step_1", actionType: "llm" },
    ]);
  });

  test("skips LLM actions without outputTo", () => {
    const def = makeDef({
      states: {
        idle: { on: { ADVANCE: { target: "step_1" } } },
        step_1: {
          entry: [{ type: "llm", provider: "openai", model: "gpt-4", prompt: "think" }],
          on: { ADVANCE: { target: "completed" } },
        },
        completed: { type: "final" },
      },
    });

    expect(extractPlannedSteps(def)).toEqual([]);
  });

  test("skips emit actions", () => {
    const def = makeDef({
      states: {
        idle: { on: { ADVANCE: { target: "step_1" } } },
        step_1: {
          entry: [
            { type: "agent", agentId: "worker", outputTo: "work_result" },
            { type: "emit", event: "done" },
          ],
          on: { ADVANCE: { target: "completed" } },
        },
        completed: { type: "final" },
      },
    });

    expect(extractPlannedSteps(def)).toEqual([
      { agentName: "worker", stateId: "step_1", actionType: "agent" },
    ]);
  });

  test("prefers ADVANCE signal over other signals", () => {
    const def = makeDef({
      states: {
        idle: {
          on: {
            ERROR: { target: "error_state" },
            ADVANCE: { target: "step_1" },
            RETRY: { target: "idle" },
          },
        },
        step_1: {
          entry: [{ type: "agent", agentId: "worker" }],
          on: { ADVANCE: { target: "completed" } },
        },
        error_state: { type: "final" },
        completed: { type: "final" },
      },
    });

    expect(extractPlannedSteps(def)).toEqual([
      { agentName: "worker", stateId: "step_1", actionType: "agent" },
    ]);
  });

  test("falls back to first signal key when no ADVANCE", () => {
    const def = makeDef({
      states: {
        idle: { on: { trigger: { target: "step_1" } } },
        step_1: {
          entry: [{ type: "agent", agentId: "fetcher" }],
          on: { next: { target: "completed" } },
        },
        completed: { type: "final" },
      },
    });

    expect(extractPlannedSteps(def)).toEqual([
      { agentName: "fetcher", stateId: "step_1", actionType: "agent" },
    ]);
  });

  test("handles array-valued transitions by taking first target", () => {
    const def = makeDef({
      states: {
        idle: { on: { ADVANCE: [{ target: "step_1" }, { target: "fallback" }] } },
        step_1: {
          entry: [{ type: "agent", agentId: "primary" }],
          on: { ADVANCE: { target: "completed" } },
        },
        fallback: {
          entry: [{ type: "agent", agentId: "fallback-agent" }],
          on: { ADVANCE: { target: "completed" } },
        },
        completed: { type: "final" },
      },
    });

    expect(extractPlannedSteps(def)).toEqual([
      { agentName: "primary", stateId: "step_1", actionType: "agent" },
    ]);
  });

  test("detects cycles and stops traversal", () => {
    const def = makeDef({
      states: {
        idle: { on: { ADVANCE: { target: "step_1" } } },
        step_1: {
          entry: [{ type: "agent", agentId: "looper" }],
          on: { ADVANCE: { target: "idle" } },
        },
      },
    });

    expect(extractPlannedSteps(def)).toEqual([
      { agentName: "looper", stateId: "step_1", actionType: "agent" },
    ]);
  });

  test("stops at state with no transitions", () => {
    const def = makeDef({
      states: {
        idle: { on: { ADVANCE: { target: "step_1" } } },
        step_1: {
          entry: [{ type: "agent", agentId: "terminal" }],
          // no `on` — dead end
        },
      },
    });

    expect(extractPlannedSteps(def)).toEqual([
      { agentName: "terminal", stateId: "step_1", actionType: "agent" },
    ]);
  });

  test("handles mixed agent and LLM actions in multi-step pipeline", () => {
    const def = makeDef({
      states: {
        idle: { on: { ADVANCE: { target: "fetch" } } },
        fetch: {
          entry: [{ type: "agent", agentId: "fetcher" }],
          on: { ADVANCE: { target: "summarize" } },
        },
        summarize: {
          entry: [
            {
              type: "llm",
              provider: "openai",
              model: "gpt-4",
              prompt: "summarize",
              outputTo: "summary",
            },
          ],
          on: { ADVANCE: { target: "publish" } },
        },
        publish: {
          entry: [{ type: "agent", agentId: "publisher" }],
          on: { ADVANCE: { target: "completed" } },
        },
        completed: { type: "final" },
      },
    });

    expect(extractPlannedSteps(def)).toEqual([
      { agentName: "fetcher", stateId: "fetch", actionType: "agent" },
      { agentName: "summary", stateId: "summarize", actionType: "llm" },
      { agentName: "publisher", stateId: "publish", actionType: "agent" },
    ]);
  });

  test("handles FSM with only a final state", () => {
    const def = makeDef({ initial: "done", states: { done: { type: "final" } } });

    expect(extractPlannedSteps(def)).toEqual([]);
  });

  test("handles missing state gracefully", () => {
    const def = makeDef({ states: { idle: { on: { ADVANCE: { target: "nonexistent" } } } } });

    // Should not throw, just stop
    expect(extractPlannedSteps(def)).toEqual([]);
  });
});

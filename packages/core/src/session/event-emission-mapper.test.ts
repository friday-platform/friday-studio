import type { FSMActionExecutionEvent } from "@atlas/fsm-engine";
import { describe, expect, test } from "vitest";
import {
  type AgentResultData,
  isAgentAction,
  mapActionToStepComplete,
  mapActionToStepStart,
} from "./event-emission-mapper.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function agentExecutionEvent(
  overrides: Partial<FSMActionExecutionEvent["data"]> = {},
): FSMActionExecutionEvent {
  return {
    type: "data-fsm-action-execution",
    data: {
      sessionId: "sess-1",
      workspaceId: "ws-1",
      jobName: "my-job",
      actionType: "agent",
      actionId: "researcher",
      state: "research",
      status: "started",
      timestamp: 1707820800000,
      inputSnapshot: { task: "research the thing" },
      ...overrides,
    },
  };
}

function agentResultData(overrides: Partial<AgentResultData> = {}): AgentResultData {
  return {
    toolCalls: [{ toolName: "search", args: { q: "test" } }],
    reasoning: "I decided to search because...",
    output: { answer: 42 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isAgentAction
// ---------------------------------------------------------------------------

describe("isAgentAction", () => {
  test("returns true for actionType 'agent'", () => {
    expect(isAgentAction(agentExecutionEvent())).toBe(true);
  });

  test("returns true for actionType 'llm'", () => {
    expect(isAgentAction(agentExecutionEvent({ actionType: "llm" }))).toBe(true);
  });

  const nonStepTypes = [
    { name: "code", actionType: "code" },
    { name: "emit", actionType: "emit" },
  ] as const;

  test.each(nonStepTypes)("returns false for actionType '$name'", ({ actionType }) => {
    expect(isAgentAction(agentExecutionEvent({ actionType }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mapActionToStepStart
// ---------------------------------------------------------------------------

describe("mapActionToStepStart", () => {
  test("maps agent execution started event to step:start", () => {
    const event = agentExecutionEvent({ status: "started" });
    const result = mapActionToStepStart(event, 1);

    expect(result).toMatchObject({
      type: "step:start",
      sessionId: "sess-1",
      stepNumber: 1,
      agentName: "researcher",
      actionType: "agent",
      task: "research the thing",
    });
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("uses actionId as agentName", () => {
    const event = agentExecutionEvent({ actionId: "writer" });
    const result = mapActionToStepStart(event, 3);

    expect(result.agentName).toBe("writer");
    expect(result.stepNumber).toBe(3);
  });

  test("populates task from inputSnapshot.task", () => {
    const event = agentExecutionEvent({ inputSnapshot: { task: "write the report" } });
    const result = mapActionToStepStart(event, 1);

    expect(result.task).toBe("write the report");
  });

  test("defaults task to empty string when inputSnapshot.task missing", () => {
    const event = agentExecutionEvent({ inputSnapshot: undefined });
    const result = mapActionToStepStart(event, 1);

    expect(result.task).toBe("");
  });

  test("defaults agentName to 'unknown' when actionId missing", () => {
    const event = agentExecutionEvent({ actionId: undefined });
    const result = mapActionToStepStart(event, 1);

    expect(result.agentName).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// mapActionToStepComplete
// ---------------------------------------------------------------------------

describe("mapActionToStepComplete", () => {
  test("maps completed agent execution with agent result", () => {
    const event = agentExecutionEvent({ status: "completed", durationMs: 1500 });
    const result = mapActionToStepComplete(event, agentResultData(), 1);

    expect(result).toMatchObject({
      type: "step:complete",
      sessionId: "sess-1",
      stepNumber: 1,
      status: "completed",
      durationMs: 1500,
      toolCalls: [{ toolName: "search", args: { q: "test" } }],
      reasoning: "I decided to search because...",
      output: { answer: 42 },
    });
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("maps failed status from FSM event", () => {
    const event = agentExecutionEvent({
      status: "failed",
      durationMs: 500,
      error: "agent crashed",
    });
    const result = mapActionToStepComplete(event, agentResultData(), 1);

    expect(result.status).toBe("failed");
    expect(result.error).toBe("agent crashed");
  });

  test("handles missing agent result gracefully (side-channel miss)", () => {
    const event = agentExecutionEvent({ status: "completed", durationMs: 1000 });
    const result = mapActionToStepComplete(event, undefined, 2);

    expect(result).toMatchObject({
      type: "step:complete",
      sessionId: "sess-1",
      stepNumber: 2,
      status: "completed",
      durationMs: 1000,
      toolCalls: [],
    });
    expect(result.reasoning).toBeUndefined();
    expect(result.output).toBeUndefined();
  });

  test("maps toolCalls from agent result to ToolCallSummary array", () => {
    const event = agentExecutionEvent({ status: "completed", durationMs: 200 });
    const ar = agentResultData({
      toolCalls: [
        { toolName: "search", args: { q: "foo" } },
        { toolName: "write", args: { path: "/out" }, result: "ok", durationMs: 100 },
      ],
    });
    const result = mapActionToStepComplete(event, ar, 1);

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]).toMatchObject({ toolName: "search", args: { q: "foo" } });
    expect(result.toolCalls[1]).toMatchObject({ toolName: "write", args: { path: "/out" } });
  });

  test("defaults durationMs to 0 when not present on FSM event", () => {
    const event = agentExecutionEvent({ status: "completed", durationMs: undefined });
    const result = mapActionToStepComplete(event, agentResultData(), 1);

    expect(result.durationMs).toBe(0);
  });

  test("omits reasoning when not present in agent result", () => {
    const ar = agentResultData({ reasoning: undefined });
    const event = agentExecutionEvent({ status: "completed", durationMs: 100 });
    const result = mapActionToStepComplete(event, ar, 1);

    expect(result.reasoning).toBeUndefined();
  });
});

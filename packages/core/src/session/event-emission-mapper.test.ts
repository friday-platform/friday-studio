import type {
  FSMActionExecutionEvent,
  FSMStateSkippedEvent,
  FSMValidationAttemptEvent,
} from "@atlas/fsm-engine";
import type { ValidationVerdict } from "@atlas/hallucination";
import { describe, expect, test } from "vitest";
import {
  type AgentResultData,
  isAgentAction,
  mapActionToStepComplete,
  mapActionToStepStart,
  mapStateSkippedToStepSkipped,
  mapValidationAttemptToStepValidation,
} from "./event-emission-mapper.ts";
import { SessionStreamEventSchema } from "./session-events.ts";

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

  const nonStepTypes = [{ name: "emit", actionType: "emit" }] as const;

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
      stateId: "research",
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

  test("passes artifactRefs from agent result to step:complete", () => {
    const refs = [{ id: "art-1", type: "code", summary: "divide function" }];
    const ar = agentResultData({ artifactRefs: refs });
    const event = agentExecutionEvent({ status: "completed", durationMs: 300 });
    const result = mapActionToStepComplete(event, ar, 1);

    expect(result.artifactRefs).toEqual(refs);
  });

  test("omits artifactRefs when not present in agent result", () => {
    const ar = agentResultData();
    const event = agentExecutionEvent({ status: "completed", durationMs: 100 });
    const result = mapActionToStepComplete(event, ar, 1);

    expect(result.artifactRefs).toBeUndefined();
  });

  test("omits artifactRefs when agent result is undefined (side-channel miss)", () => {
    const event = agentExecutionEvent({ status: "completed", durationMs: 100 });
    const result = mapActionToStepComplete(event, undefined, 1);

    expect(result.artifactRefs).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mapStateSkippedToStepSkipped
// ---------------------------------------------------------------------------

function stateSkippedEvent(
  overrides: Partial<FSMStateSkippedEvent["data"]> = {},
): FSMStateSkippedEvent {
  return {
    type: "data-fsm-state-skipped",
    data: {
      sessionId: "sess-1",
      workspaceId: "ws-1",
      jobName: "my-job",
      stateId: "review",
      timestamp: 1707820800000,
      ...overrides,
    },
  };
}

describe("mapStateSkippedToStepSkipped", () => {
  test("maps FSMStateSkippedEvent to step:skipped", () => {
    const event = stateSkippedEvent();
    const result = mapStateSkippedToStepSkipped(event);

    expect(result).toMatchObject({ type: "step:skipped", sessionId: "sess-1", stateId: "review" });
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("preserves stateId from event data", () => {
    const event = stateSkippedEvent({ stateId: "deploy" });
    const result = mapStateSkippedToStepSkipped(event);

    expect(result.stateId).toBe("deploy");
  });
});

// ---------------------------------------------------------------------------
// mapValidationAttemptToStepValidation
// ---------------------------------------------------------------------------

function passVerdict(): ValidationVerdict {
  return { status: "pass", confidence: 0.85, threshold: 0.45, issues: [], retryGuidance: "" };
}

function uncertainVerdict(): ValidationVerdict {
  return {
    status: "uncertain",
    confidence: 0.4,
    threshold: 0.45,
    issues: [
      {
        category: "judge-uncertain",
        severity: "info",
        claim: "could not determine sourcing",
        reasoning: "tool result was truncated",
        citation: null,
      },
    ],
    retryGuidance: "",
  };
}

function failVerdict(): ValidationVerdict {
  return {
    status: "fail",
    confidence: 0.2,
    threshold: 0.45,
    issues: [
      {
        category: "sourcing",
        severity: "error",
        claim: "company has 500 employees",
        reasoning: "no tool was called",
        citation: null,
      },
    ],
    retryGuidance: "call a search tool before stating employee counts",
  };
}

function validationAttemptEvent(
  overrides: Partial<FSMValidationAttemptEvent["data"]> = {},
): FSMValidationAttemptEvent {
  return {
    type: "data-fsm-validation-attempt",
    data: {
      sessionId: "sess-1",
      workspaceId: "ws-1",
      jobName: "my-job",
      actionId: "researcher",
      state: "research",
      attempt: 1,
      status: "running",
      timestamp: 1707820800000,
      ...overrides,
    },
  };
}

describe("mapValidationAttemptToStepValidation", () => {
  test("maps running attempt to step:validation without verdict or terminal", () => {
    const event = validationAttemptEvent({ status: "running", attempt: 1 });
    const result = mapValidationAttemptToStepValidation(event);

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      type: "step:validation",
      sessionId: "sess-1",
      actionId: "researcher",
      attempt: 1,
      status: "running",
    });
    expect(result?.terminal).toBeUndefined();
    expect(result?.verdict).toBeUndefined();
    expect(result?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("maps passed attempt with pass verdict", () => {
    const verdict = passVerdict();
    const event = validationAttemptEvent({ status: "passed", attempt: 1, verdict });
    const result = mapValidationAttemptToStepValidation(event);

    expect(result?.status).toBe("passed");
    expect(result?.verdict).toEqual(verdict);
    expect(result?.terminal).toBeUndefined();
  });

  test("maps passed attempt with uncertain verdict (still passes downstream)", () => {
    const verdict = uncertainVerdict();
    const event = validationAttemptEvent({ status: "passed", attempt: 1, verdict });
    const result = mapValidationAttemptToStepValidation(event);

    expect(result?.status).toBe("passed");
    expect(result?.verdict?.status).toBe("uncertain");
  });

  test("maps failed-non-terminal attempt (retry follows)", () => {
    const verdict = failVerdict();
    const event = validationAttemptEvent({
      status: "failed",
      attempt: 1,
      terminal: false,
      verdict,
    });
    const result = mapValidationAttemptToStepValidation(event);

    expect(result?.status).toBe("failed");
    expect(result?.terminal).toBe(false);
    expect(result?.verdict).toEqual(verdict);
  });

  test("maps failed-terminal attempt (action throws)", () => {
    const verdict = failVerdict();
    const event = validationAttemptEvent({ status: "failed", attempt: 2, terminal: true, verdict });
    const result = mapValidationAttemptToStepValidation(event);

    expect(result?.status).toBe("failed");
    expect(result?.terminal).toBe(true);
    expect(result?.attempt).toBe(2);
  });

  test("returns null when actionId is missing (cannot correlate)", () => {
    const event = validationAttemptEvent({ actionId: undefined });
    const result = mapValidationAttemptToStepValidation(event);

    expect(result).toBeNull();
  });

  // Round-trip: emitter output must parse cleanly through SessionStreamEventSchema
  // (the wire schema consumed by the playground). Covers all 5 lifecycle states
  // per Task #24 acceptance criteria.
  describe("round-trip through SessionStreamEventSchema", () => {
    const lifecycleCases = [
      { name: "running", event: validationAttemptEvent({ status: "running", attempt: 1 }) },
      {
        name: "passed-from-pass",
        event: validationAttemptEvent({ status: "passed", attempt: 1, verdict: passVerdict() }),
      },
      {
        name: "passed-from-uncertain",
        event: validationAttemptEvent({
          status: "passed",
          attempt: 1,
          verdict: uncertainVerdict(),
        }),
      },
      {
        name: "failed-with-terminal-false",
        event: validationAttemptEvent({
          status: "failed",
          attempt: 1,
          terminal: false,
          verdict: failVerdict(),
        }),
      },
      {
        name: "failed-with-terminal-true",
        event: validationAttemptEvent({
          status: "failed",
          attempt: 2,
          terminal: true,
          verdict: failVerdict(),
        }),
      },
    ] as const;

    test.each(lifecycleCases)("$name parses through SessionStreamEventSchema", ({ event }) => {
      const mapped = mapValidationAttemptToStepValidation(event);
      expect(mapped).not.toBeNull();
      if (!mapped) return;

      const parsed = SessionStreamEventSchema.parse(mapped);
      expect(parsed).toEqual(mapped);
    });
  });
});

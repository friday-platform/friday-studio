import assert from "node:assert/strict";
import { describe, expect, test } from "vitest";

import {
  AgentBlockSchema,
  EphemeralChunkSchema,
  SessionActionTypeSchema,
  SessionCompleteEventSchema,
  SessionStartEventSchema,
  SessionStatusSchema,
  SessionStreamEventSchema,
  SessionSummarySchema,
  SessionViewSchema,
  StepCompleteEventSchema,
  StepStartEventSchema,
  ToolCallSummarySchema,
} from "./session-events.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = "2026-02-13T10:00:00.000Z";

function validSessionStart() {
  return {
    type: "session:start" as const,
    sessionId: "sess-1",
    workspaceId: "ws-1",
    jobName: "my-job",
    task: "do the thing",
    timestamp: NOW,
  };
}

function validStepStart() {
  return {
    type: "step:start" as const,
    sessionId: "sess-1",
    stepNumber: 1,
    agentName: "researcher",
    actionType: "agent",
    task: "research the thing",
    timestamp: NOW,
  };
}

function validStepComplete() {
  return {
    type: "step:complete" as const,
    sessionId: "sess-1",
    stepNumber: 1,
    status: "completed" as const,
    durationMs: 1234,
    toolCalls: [{ toolName: "search", args: { q: "test" } }],
    output: { answer: 42 },
    timestamp: NOW,
  };
}

function validSessionComplete() {
  return {
    type: "session:complete" as const,
    sessionId: "sess-1",
    status: "completed" as const,
    durationMs: 5000,
    timestamp: NOW,
  };
}

// ---------------------------------------------------------------------------
// SessionStatus
// ---------------------------------------------------------------------------

describe("SessionStatusSchema", () => {
  const validStatuses = ["active", "completed", "failed", "skipped"] as const;

  test.each(validStatuses)("accepts '%s'", (status) => {
    expect(SessionStatusSchema.parse(status)).toBe(status);
  });

  test("rejects invalid status", () => {
    expect(() => SessionStatusSchema.parse("pending")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// SessionActionType
// ---------------------------------------------------------------------------

describe("SessionActionTypeSchema", () => {
  test.each(["agent", "llm"] as const)("accepts '%s'", (type) => {
    expect(SessionActionTypeSchema.parse(type)).toBe(type);
  });

  test("rejects invalid action type", () => {
    expect(() => SessionActionTypeSchema.parse("code")).toThrow();
    expect(() => SessionActionTypeSchema.parse("unknown")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ToolCallSummary
// ---------------------------------------------------------------------------

describe("ToolCallSummarySchema", () => {
  test("parses minimal tool call", () => {
    const result = ToolCallSummarySchema.parse({ toolName: "search", args: { q: "test" } });
    expect(result).toMatchObject({ toolName: "search", args: { q: "test" } });
  });

  test("parses tool call with optional fields", () => {
    const result = ToolCallSummarySchema.parse({
      toolName: "search",
      args: { q: "test" },
      result: { hits: 5 },
      durationMs: 200,
    });
    expect(result.result).toEqual({ hits: 5 });
    expect(result.durationMs).toBe(200);
  });

  test("rejects missing toolName", () => {
    expect(() => ToolCallSummarySchema.parse({ args: {} })).toThrow();
  });

  test("accepts missing args as undefined", () => {
    // z.unknown() accepts undefined — args is typed as unknown
    const result = ToolCallSummarySchema.parse({ toolName: "x" });
    expect(result.toolName).toBe("x");
  });
});

// ---------------------------------------------------------------------------
// SessionStartEvent
// ---------------------------------------------------------------------------

describe("SessionStartEventSchema", () => {
  test("parses valid event", () => {
    const result = SessionStartEventSchema.parse(validSessionStart());
    expect(result.type).toBe("session:start");
    expect(result.sessionId).toBe("sess-1");
  });

  test("rejects missing sessionId", () => {
    const { sessionId: _, ...rest } = validSessionStart();
    expect(() => SessionStartEventSchema.parse(rest)).toThrow();
  });

  test("rejects wrong type discriminator", () => {
    expect(() =>
      SessionStartEventSchema.parse({ ...validSessionStart(), type: "step:start" }),
    ).toThrow();
  });

  test("accepts optional plannedSteps", () => {
    const result = SessionStartEventSchema.parse({
      ...validSessionStart(),
      plannedSteps: [
        { agentName: "researcher", task: "research", actionType: "agent" },
        { agentName: "writer", task: "write report", actionType: "llm" },
      ],
    });
    assert(result.plannedSteps, "expected plannedSteps to exist");
    expect(result.plannedSteps).toHaveLength(2);
    const firstStep = result.plannedSteps[0];
    assert(firstStep, "expected first planned step to exist");
    expect(firstStep.agentName).toBe("researcher");
  });

  test("parses without plannedSteps", () => {
    const result = SessionStartEventSchema.parse(validSessionStart());
    expect(result.plannedSteps).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// StepStartEvent
// ---------------------------------------------------------------------------

describe("StepStartEventSchema", () => {
  test("parses valid event", () => {
    const result = StepStartEventSchema.parse(validStepStart());
    expect(result.type).toBe("step:start");
    expect(result.stepNumber).toBe(1);
    expect(result.agentName).toBe("researcher");
  });

  test("rejects missing agentName", () => {
    const { agentName: _, ...rest } = validStepStart();
    expect(() => StepStartEventSchema.parse(rest)).toThrow();
  });

  test("rejects non-number stepNumber", () => {
    expect(() => StepStartEventSchema.parse({ ...validStepStart(), stepNumber: "one" })).toThrow();
  });

  test("rejects invalid actionType", () => {
    expect(() => StepStartEventSchema.parse({ ...validStepStart(), actionType: "code" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// StepCompleteEvent
// ---------------------------------------------------------------------------

describe("StepCompleteEventSchema", () => {
  test("parses valid event with toolCalls", () => {
    const result = StepCompleteEventSchema.parse(validStepComplete());
    expect(result.type).toBe("step:complete");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.status).toBe("completed");
  });

  test("parses with optional reasoning and error", () => {
    const result = StepCompleteEventSchema.parse({
      ...validStepComplete(),
      reasoning: "I chose to search because...",
      error: "timeout",
      status: "failed",
    });
    expect(result.reasoning).toBe("I chose to search because...");
    expect(result.error).toBe("timeout");
  });

  test("accepts empty toolCalls array", () => {
    const result = StepCompleteEventSchema.parse({ ...validStepComplete(), toolCalls: [] });
    expect(result.toolCalls).toHaveLength(0);
  });

  test("rejects invalid status value", () => {
    expect(() =>
      StepCompleteEventSchema.parse({ ...validStepComplete(), status: "running" }),
    ).toThrow();
  });

  test("accepts missing output as undefined", () => {
    // z.unknown() accepts undefined — output is typed as unknown
    const { output: _, ...rest } = validStepComplete();
    const result = StepCompleteEventSchema.parse(rest);
    expect(result.output).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SessionCompleteEvent
// ---------------------------------------------------------------------------

describe("SessionCompleteEventSchema", () => {
  test("parses valid event", () => {
    const result = SessionCompleteEventSchema.parse(validSessionComplete());
    expect(result.type).toBe("session:complete");
    expect(result.durationMs).toBe(5000);
  });

  test("parses with optional error", () => {
    const result = SessionCompleteEventSchema.parse({
      ...validSessionComplete(),
      status: "failed",
      error: "agent crashed",
    });
    expect(result.error).toBe("agent crashed");
  });

  test("accepts all SessionStatus values", () => {
    for (const status of ["active", "completed", "failed", "skipped"] as const) {
      const result = SessionCompleteEventSchema.parse({ ...validSessionComplete(), status });
      expect(result.status).toBe(status);
    }
  });

  test("rejects invalid status", () => {
    expect(() =>
      SessionCompleteEventSchema.parse({ ...validSessionComplete(), status: "pending" }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// SessionStreamEvent (discriminated union)
// ---------------------------------------------------------------------------

describe("SessionStreamEventSchema", () => {
  test("parses session:start", () => {
    const result = SessionStreamEventSchema.parse(validSessionStart());
    expect(result.type).toBe("session:start");
  });

  test("parses step:start", () => {
    const result = SessionStreamEventSchema.parse(validStepStart());
    expect(result.type).toBe("step:start");
  });

  test("parses step:complete", () => {
    const result = SessionStreamEventSchema.parse(validStepComplete());
    expect(result.type).toBe("step:complete");
  });

  test("parses step:skipped", () => {
    const result = SessionStreamEventSchema.parse({
      type: "step:skipped",
      sessionId: "sess-1",
      stateId: "review",
      timestamp: NOW,
    });
    expect(result.type).toBe("step:skipped");
  });

  test("parses step:validation (running, no verdict)", () => {
    const result = SessionStreamEventSchema.parse({
      type: "step:validation",
      sessionId: "sess-1",
      actionId: "researcher",
      attempt: 1,
      status: "running",
      timestamp: NOW,
    });
    expect(result.type).toBe("step:validation");
  });

  test("parses step:validation (failed, with terminal flag and verdict)", () => {
    const result = SessionStreamEventSchema.parse({
      type: "step:validation",
      sessionId: "sess-1",
      actionId: "researcher",
      attempt: 2,
      status: "failed",
      terminal: true,
      verdict: {
        status: "fail",
        confidence: 0.2,
        threshold: 0.45,
        issues: [
          {
            category: "sourcing",
            severity: "error",
            claim: "fabricated number",
            reasoning: "no tool called",
            citation: null,
          },
        ],
        retryGuidance: "call a tool first",
      },
      timestamp: NOW,
    });
    if (result.type === "step:validation") {
      expect(result.terminal).toBe(true);
      expect(result.verdict?.status).toBe("fail");
    }
  });

  test("parses session:complete", () => {
    const result = SessionStreamEventSchema.parse(validSessionComplete());
    expect(result.type).toBe("session:complete");
  });

  test("rejects unknown event type", () => {
    expect(() =>
      SessionStreamEventSchema.parse({ type: "unknown:event", sessionId: "sess-1" }),
    ).toThrow();
  });

  test("inferred type is a discriminated union", () => {
    const event = SessionStreamEventSchema.parse(validStepComplete());
    if (event.type === "step:complete") {
      // TypeScript narrows: stepNumber, toolCalls, output exist
      expect(event.stepNumber).toBeTypeOf("number");
      expect(event.toolCalls).toBeInstanceOf(Array);
    }
  });
});

// ---------------------------------------------------------------------------
// EphemeralChunk
// ---------------------------------------------------------------------------

describe("EphemeralChunkSchema", () => {
  test("parses valid chunk", () => {
    const chunk = { type: "text", text: "thinking..." };
    const result = EphemeralChunkSchema.parse({ stepNumber: 1, chunk });
    expect(result.stepNumber).toBe(1);
    expect(result.chunk).toEqual(chunk);
  });

  test("rejects missing stepNumber", () => {
    expect(() => EphemeralChunkSchema.parse({ chunk: { type: "text", text: "hi" } })).toThrow();
  });

  test("rejects missing chunk", () => {
    expect(() => EphemeralChunkSchema.parse({ stepNumber: 1 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// AgentBlock
// ---------------------------------------------------------------------------

describe("AgentBlockSchema", () => {
  function validAgentBlock() {
    return {
      stepNumber: 1,
      agentName: "researcher",
      actionType: "agent",
      task: "research the thing",
      status: "completed" as const,
      durationMs: 1234,
      toolCalls: [{ toolName: "search", args: { q: "test" } }],
      output: { answer: 42 },
    };
  }

  test("parses valid block", () => {
    const result = AgentBlockSchema.parse(validAgentBlock());
    expect(result.agentName).toBe("researcher");
    expect(result.status).toBe("completed");
  });

  test("accepts running status", () => {
    const result = AgentBlockSchema.parse({ ...validAgentBlock(), status: "running" });
    expect(result.status).toBe("running");
  });

  test("accepts failed status", () => {
    const result = AgentBlockSchema.parse({
      ...validAgentBlock(),
      status: "failed",
      error: "boom",
    });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("boom");
  });

  test("accepts pending status", () => {
    const result = AgentBlockSchema.parse({ ...validAgentBlock(), status: "pending" });
    expect(result.status).toBe("pending");
  });

  test("accepts skipped status", () => {
    const result = AgentBlockSchema.parse({ ...validAgentBlock(), status: "skipped" });
    expect(result.status).toBe("skipped");
  });

  test("accepts optional stepNumber", () => {
    const { stepNumber: _, ...rest } = validAgentBlock();
    const result = AgentBlockSchema.parse(rest);
    expect(result.stepNumber).toBeUndefined();
  });

  test("rejects invalid actionType", () => {
    expect(() => AgentBlockSchema.parse({ ...validAgentBlock(), actionType: "unknown" })).toThrow();
  });

  test("rejects invalid status", () => {
    expect(() => AgentBlockSchema.parse({ ...validAgentBlock(), status: "active" })).toThrow();
  });

  test("accepts optional fields", () => {
    const result = AgentBlockSchema.parse({
      ...validAgentBlock(),
      reasoning: "because reasons",
      ephemeral: [{ type: "text", text: "thinking..." }],
    });
    expect(result.reasoning).toBe("because reasons");
    expect(result.ephemeral).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// SessionView
// ---------------------------------------------------------------------------

describe("SessionViewSchema", () => {
  function validSessionView() {
    return {
      sessionId: "sess-1",
      workspaceId: "ws-1",
      jobName: "my-job",
      task: "do the thing",
      status: "completed" as const,
      startedAt: NOW,
      agentBlocks: [
        {
          stepNumber: 1,
          agentName: "researcher",
          actionType: "agent",
          task: "research",
          status: "completed" as const,
          toolCalls: [],
          output: null,
        },
      ],
    };
  }

  test("parses valid view", () => {
    const result = SessionViewSchema.parse(validSessionView());
    expect(result.sessionId).toBe("sess-1");
    expect(result.agentBlocks).toHaveLength(1);
  });

  test("parses with optional fields", () => {
    const result = SessionViewSchema.parse({
      ...validSessionView(),
      completedAt: NOW,
      durationMs: 5000,
      error: "something went wrong",
    });
    expect(result.completedAt).toBe(NOW);
    expect(result.durationMs).toBe(5000);
  });

  test("rejects missing agentBlocks", () => {
    const { agentBlocks: _, ...rest } = validSessionView();
    expect(() => SessionViewSchema.parse(rest)).toThrow();
  });

  test("rejects invalid status", () => {
    expect(() => SessionViewSchema.parse({ ...validSessionView(), status: "running" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// SessionSummary
// ---------------------------------------------------------------------------

describe("SessionSummarySchema", () => {
  function validSummary() {
    return {
      sessionId: "sess-1",
      workspaceId: "ws-1",
      jobName: "my-job",
      task: "do the thing",
      status: "completed" as const,
      startedAt: NOW,
      stepCount: 3,
      agentNames: ["researcher", "writer"],
    };
  }

  test("parses valid summary", () => {
    const result = SessionSummarySchema.parse(validSummary());
    expect(result.stepCount).toBe(3);
    expect(result.agentNames).toEqual(["researcher", "writer"]);
  });

  test("parses with optional fields", () => {
    const result = SessionSummarySchema.parse({
      ...validSummary(),
      completedAt: NOW,
      durationMs: 5000,
      error: "oops",
    });
    expect(result.completedAt).toBe(NOW);
  });

  test("rejects missing stepCount", () => {
    const { stepCount: _, ...rest } = validSummary();
    expect(() => SessionSummarySchema.parse(rest)).toThrow();
  });

  test("rejects missing agentNames", () => {
    const { agentNames: _, ...rest } = validSummary();
    expect(() => SessionSummarySchema.parse(rest)).toThrow();
  });
});

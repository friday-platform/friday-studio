import type { SessionStreamEvent } from "@atlas/core/session/session-events";
import type { ValidationVerdict } from "@atlas/hallucination";
import { describe, expect, it, vi } from "vitest";
import { accumulateValidationAttempts } from "./validation-accumulator.ts";

// ---------------------------------------------------------------------------
// Builders — minimal SessionStreamEvent shapes that match the discriminated
// union at runtime. Helpers cover only the fields the accumulator inspects.
// ---------------------------------------------------------------------------

function sessionStart(): SessionStreamEvent {
  return {
    type: "session:start",
    sessionId: "s1",
    workspaceId: "w1",
    jobName: "j1",
    task: "do thing",
    timestamp: "2026-04-28T12:00:00Z",
  };
}

function stepStart(actionId: string, stepNumber = 1): SessionStreamEvent {
  return {
    type: "step:start",
    sessionId: "s1",
    stepNumber,
    agentName: actionId,
    actionType: "llm",
    task: "",
    timestamp: "2026-04-28T12:00:01Z",
  };
}

function stepComplete(stepNumber = 1): SessionStreamEvent {
  return {
    type: "step:complete",
    sessionId: "s1",
    stepNumber,
    status: "completed",
    durationMs: 100,
    toolCalls: [],
    output: undefined,
    timestamp: "2026-04-28T12:00:02Z",
  };
}

function passVerdict(): ValidationVerdict {
  return { status: "pass", confidence: 0.8, threshold: 0.45, issues: [], retryGuidance: "" };
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
        claim: "fabricated link",
        reasoning: "no tool call",
        citation: null,
      },
    ],
    retryGuidance: "cite sources",
  };
}

function validationRunning(actionId: string, attempt: number): SessionStreamEvent {
  return {
    type: "step:validation",
    sessionId: "s1",
    actionId,
    attempt,
    status: "running",
    timestamp: `2026-04-28T12:00:${10 + attempt}Z`,
  };
}

function validationPassed(actionId: string, attempt: number): SessionStreamEvent {
  return {
    type: "step:validation",
    sessionId: "s1",
    actionId,
    attempt,
    status: "passed",
    verdict: passVerdict(),
    timestamp: `2026-04-28T12:00:${20 + attempt}Z`,
  };
}

function validationFailed(
  actionId: string,
  attempt: number,
  terminal: boolean,
): SessionStreamEvent {
  return {
    type: "step:validation",
    sessionId: "s1",
    actionId,
    attempt,
    status: "failed",
    terminal,
    verdict: failVerdict(),
    timestamp: `2026-04-28T12:00:${30 + attempt}Z`,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("accumulateValidationAttempts", () => {
  it("returns an empty map for an empty event stream", () => {
    const result = accumulateValidationAttempts([]);
    expect(result.size).toBe(0);
  });

  it("ignores non-validation session events", () => {
    const events: SessionStreamEvent[] = [sessionStart(), stepStart("act1"), stepComplete()];
    const result = accumulateValidationAttempts(events);
    expect(result.size).toBe(0);
  });

  it("AC scenario: action with two attempts, fail-then-pass, in order", () => {
    // [action-start, tool-call, tool-result, validation-running,
    //  validation-failed{terminal:false}, validation-running, validation-passed]
    // tool-call/tool-result are out-of-scope for this accumulator (the chunk
    // accumulator handles those) — here we use step:start as the action-start
    // surrogate and then feed the validation events.
    const events: SessionStreamEvent[] = [
      stepStart("act1"),
      validationRunning("act1", 1),
      validationFailed("act1", 1, false),
      validationRunning("act1", 2),
      validationPassed("act1", 2),
    ];

    const result = accumulateValidationAttempts(events);
    const attempts = result.get("act1");
    expect(attempts).toBeDefined();
    expect(attempts).toHaveLength(2);

    expect(attempts?.[0]?.attempt).toBe(1);
    expect(attempts?.[0]?.status).toBe("failed");
    expect(attempts?.[0]?.terminal).toBe(false);
    expect(attempts?.[0]?.verdict?.status).toBe("fail");

    expect(attempts?.[1]?.attempt).toBe(2);
    expect(attempts?.[1]?.status).toBe("passed");
    expect(attempts?.[1]?.terminal).toBeUndefined();
    expect(attempts?.[1]?.verdict?.status).toBe("pass");
  });

  it("running event creates a non-terminal entry, then is updated to terminal", () => {
    const result = accumulateValidationAttempts([validationRunning("act1", 1)]);
    const attempts = result.get("act1");
    expect(attempts).toHaveLength(1);
    expect(attempts?.[0]?.status).toBe("running");
    expect(attempts?.[0]?.verdict).toBeUndefined();
    expect(attempts?.[0]?.terminal).toBeUndefined();

    const updated = accumulateValidationAttempts([
      validationRunning("act1", 1),
      validationPassed("act1", 1),
    ]);
    const finalAttempts = updated.get("act1");
    expect(finalAttempts).toHaveLength(1);
    expect(finalAttempts?.[0]?.status).toBe("passed");
    expect(finalAttempts?.[0]?.verdict?.status).toBe("pass");
  });

  it("preserves attempt order even when events arrive out of order", () => {
    // attempt 2's running arrives before attempt 1's running (theoretical
    // replay edge case); the resulting array is sorted by attempt index.
    const result = accumulateValidationAttempts([
      validationRunning("act1", 2),
      validationRunning("act1", 1),
      validationPassed("act1", 2),
      validationFailed("act1", 1, false),
    ]);
    const attempts = result.get("act1");
    expect(attempts?.map((a) => a.attempt)).toEqual([1, 2]);
  });

  it("correlates validation events to multiple distinct actions independently", () => {
    const result = accumulateValidationAttempts([
      validationRunning("act1", 1),
      validationRunning("act2", 1),
      validationPassed("act1", 1),
      validationFailed("act2", 1, true),
    ]);
    expect(result.get("act1")?.[0]?.status).toBe("passed");
    expect(result.get("act2")?.[0]?.status).toBe("failed");
    expect(result.get("act2")?.[0]?.terminal).toBe(true);
  });

  it("warns and drops validation events with no actionId rather than silently skipping", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const orphan = {
        type: "step:validation",
        sessionId: "s1",
        // actionId omitted to simulate schema drift / orphaned event
        attempt: 1,
        status: "running",
        timestamp: "2026-04-28T12:00:00Z",
      } as unknown as SessionStreamEvent;
      const result = accumulateValidationAttempts([orphan]);
      expect(result.size).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("warns on unknown validation status values rather than silently dropping", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const unknownStatus = {
        type: "step:validation",
        sessionId: "s1",
        actionId: "act1",
        attempt: 1,
        status: "uncertain",
        timestamp: "2026-04-28T12:00:00Z",
      } as unknown as SessionStreamEvent;
      const result = accumulateValidationAttempts([unknownStatus]);
      expect(result.size).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

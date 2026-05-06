/**
 * Phase 11 (provenance for crystallization) — schema-level tests for
 * the parent-linkage and LLM-token-usage additions on session events.
 *
 * These guard:
 *   - `SessionSummary` accepts/rejects `parentSessionId` and
 *     `parentEventId` shapes correctly, and tolerates absence (existing
 *     `SESSION_METADATA` entries are unaffected).
 *   - `step:complete` events accept the new `usage` field with the four
 *     token kinds + model, reject malformed shapes, and round-trip
 *     through the discriminated-union session-stream parser.
 *   - `successSignal` reserved field accepts the discriminated union
 *     and rejects unknown `kind` values.
 *   - A simple parent → child SessionSummary chain reproduces the
 *     intended walk-the-tree behavior end to end.
 *
 * @module
 */

import { describe, expect, test } from "vitest";
import {
  SessionStreamEventSchema,
  SessionSummarySchema,
  StepCompleteEventSchema,
  StepUsageSchema,
  SuccessSignalSchema,
} from "./session-events.ts";

const NOW = "2026-05-05T10:00:00.000Z";

function baseSummary() {
  return {
    sessionId: "sess-child",
    workspaceId: "ws-1",
    jobName: "spawned-job",
    task: "do the thing",
    status: "completed" as const,
    startedAt: NOW,
    completedAt: NOW,
    durationMs: 1234,
    stepCount: 2,
    agentNames: ["a", "b"],
  };
}

function baseStepComplete() {
  return {
    type: "step:complete" as const,
    sessionId: "sess-1",
    stepNumber: 1,
    status: "completed" as const,
    durationMs: 1234,
    toolCalls: [],
    output: { ok: true },
    timestamp: NOW,
  };
}

// ---------------------------------------------------------------------------
// SessionSummary parent linkage
// ---------------------------------------------------------------------------

describe("SessionSummary parent-linkage", () => {
  test("accepts both parentSessionId and parentEventId", () => {
    const parsed = SessionSummarySchema.parse({
      ...baseSummary(),
      parentSessionId: "sess-parent",
      parentEventId: "evt-42",
    });
    expect(parsed.parentSessionId).toBe("sess-parent");
    expect(parsed.parentEventId).toBe("evt-42");
  });

  test("accepts parentSessionId without parentEventId", () => {
    const parsed = SessionSummarySchema.parse({ ...baseSummary(), parentSessionId: "sess-parent" });
    expect(parsed.parentSessionId).toBe("sess-parent");
    expect(parsed.parentEventId).toBeUndefined();
  });

  test("tolerates absence of both (existing SESSION_METADATA entries unaffected)", () => {
    const parsed = SessionSummarySchema.parse(baseSummary());
    expect(parsed.parentSessionId).toBeUndefined();
    expect(parsed.parentEventId).toBeUndefined();
  });

  test("rejects non-string parentSessionId", () => {
    expect(() => SessionSummarySchema.parse({ ...baseSummary(), parentSessionId: 42 })).toThrow();
  });

  test("rejects non-string parentEventId", () => {
    expect(() =>
      SessionSummarySchema.parse({ ...baseSummary(), parentEventId: { not: "a string" } }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// SessionSummary successSignal (reserved)
// ---------------------------------------------------------------------------

describe("SessionSummary.successSignal", () => {
  test("accepts implicit kind with finalState", () => {
    const parsed = SessionSummarySchema.parse({
      ...baseSummary(),
      successSignal: { kind: "implicit", finalState: "done" },
    });
    expect(parsed.successSignal).toEqual({ kind: "implicit", finalState: "done" });
  });

  test("accepts implicit kind without finalState", () => {
    const parsed = SessionSummarySchema.parse({
      ...baseSummary(),
      successSignal: { kind: "implicit" },
    });
    expect(parsed.successSignal?.kind).toBe("implicit");
  });

  test("accepts explicit thumbs_up with note", () => {
    const parsed = SessionSummarySchema.parse({
      ...baseSummary(),
      successSignal: { kind: "explicit", rating: "thumbs_up", note: "nice" },
    });
    expect(parsed.successSignal).toEqual({ kind: "explicit", rating: "thumbs_up", note: "nice" });
  });

  test("accepts explicit thumbs_down without note", () => {
    const parsed = SessionSummarySchema.parse({
      ...baseSummary(),
      successSignal: { kind: "explicit", rating: "thumbs_down" },
    });
    expect(parsed.successSignal?.kind).toBe("explicit");
  });

  test("rejects unknown kind", () => {
    expect(() =>
      SessionSummarySchema.parse({
        ...baseSummary(),
        successSignal: { kind: "neither", rating: "thumbs_up" },
      }),
    ).toThrow();
  });

  test("rejects explicit with invalid rating", () => {
    expect(() => SuccessSignalSchema.parse({ kind: "explicit", rating: "neutral" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// StepUsage / step:complete usage field
// ---------------------------------------------------------------------------

describe("StepUsageSchema", () => {
  test("accepts all four token fields + model", () => {
    const parsed = StepUsageSchema.parse({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 200,
      cacheWriteTokens: 80,
      model: "anthropic:claude-opus-4-7",
    });
    expect(parsed).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 200,
      cacheWriteTokens: 80,
      model: "anthropic:claude-opus-4-7",
    });
  });

  test("accepts empty object (every field optional)", () => {
    expect(StepUsageSchema.parse({})).toEqual({});
  });

  test("accepts partial (cache fields missing)", () => {
    const parsed = StepUsageSchema.parse({ inputTokens: 10, outputTokens: 5 });
    expect(parsed.inputTokens).toBe(10);
    expect(parsed.cacheReadTokens).toBeUndefined();
  });

  test("rejects non-numeric token fields", () => {
    expect(() => StepUsageSchema.parse({ inputTokens: "100" })).toThrow();
  });

  test("rejects non-string model", () => {
    expect(() => StepUsageSchema.parse({ model: 42 })).toThrow();
  });
});

describe("StepCompleteEvent.usage", () => {
  test("accepts step:complete with full usage", () => {
    const parsed = StepCompleteEventSchema.parse({
      ...baseStepComplete(),
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        model: "anthropic:claude-opus-4-7",
      },
    });
    expect(parsed.usage?.inputTokens).toBe(100);
    expect(parsed.usage?.model).toBe("anthropic:claude-opus-4-7");
  });

  test("accepts step:complete without usage (legacy events)", () => {
    const parsed = StepCompleteEventSchema.parse(baseStepComplete());
    expect(parsed.usage).toBeUndefined();
  });

  test("rejects malformed usage shape", () => {
    expect(() =>
      StepCompleteEventSchema.parse({ ...baseStepComplete(), usage: { inputTokens: "lots" } }),
    ).toThrow();
  });

  test("round-trips through SessionStreamEventSchema discriminated union", () => {
    const parsed = SessionStreamEventSchema.parse({
      ...baseStepComplete(),
      usage: { inputTokens: 1, outputTokens: 2, model: "openai:gpt-4o" },
    });
    if (parsed.type !== "step:complete") {
      throw new Error("expected step:complete branch");
    }
    expect(parsed.usage?.model).toBe("openai:gpt-4o");
  });
});

// ---------------------------------------------------------------------------
// Parent → child chain reachability
// ---------------------------------------------------------------------------

describe("parent → child session chain", () => {
  test("walking parentSessionId recovers the lineage from a child", () => {
    const root = SessionSummarySchema.parse({
      ...baseSummary(),
      sessionId: "sess-root",
      jobName: "chat",
    });

    const intermediate = SessionSummarySchema.parse({
      ...baseSummary(),
      sessionId: "sess-job",
      jobName: "spawned-job",
      parentSessionId: root.sessionId,
    });

    const leaf = SessionSummarySchema.parse({
      ...baseSummary(),
      sessionId: "sess-grand",
      jobName: "grand-child",
      parentSessionId: intermediate.sessionId,
      parentEventId: "evt-step-3",
    });

    // Build an in-memory store mirroring SESSION_METADATA semantics.
    const byId = new Map([root, intermediate, leaf].map((s) => [s.sessionId, s] as const));

    // Walk parent chain from the leaf.
    const lineage: string[] = [];
    let cursor: string | undefined = leaf.sessionId;
    while (cursor) {
      lineage.push(cursor);
      cursor = byId.get(cursor)?.parentSessionId;
    }

    expect(lineage).toEqual(["sess-grand", "sess-job", "sess-root"]);
    expect(byId.get(leaf.sessionId)?.parentEventId).toBe("evt-step-3");
  });
});

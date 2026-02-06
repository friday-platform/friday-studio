import { describe, expect, it } from "vitest";
import { extractArtifactsFromOutput, sanitizeAgentOutput } from "./extract-artifacts.ts";

/**
 * Test fixtures representing real agent output shapes.
 * Kept as documentation even if not all are used in tests.
 *
 * Two shapes exist (until FSM stores full envelope):
 * - Envelope: { ok, data: { response }, artifactRefs, agentId, timestamp, durationMs }
 * - Flattened (FSM storage): { response, ...fields, artifactRefs }
 *
 * @see docs/plans/2026-02-03-unified-agent-envelope-design.md
 */
const fixtures = {
  /** Full envelope with artifact */
  envelope: {
    agentId: "claude-code",
    timestamp: "2026-02-03T12:00:00.000Z",
    input: "create divide function",
    ok: true,
    data: { response: "Created divide.ts" },
    artifactRefs: [{ id: "abc-123", type: "code", summary: "divide function" }],
    durationMs: 1234,
  },
  /** Envelope with error */
  envelopeError: {
    agentId: "test",
    timestamp: "2026-02-03T12:00:00.000Z",
    input: "test",
    ok: false,
    error: { reason: "API rate limit exceeded" },
    durationMs: 100,
  },
  /** Flattened FSM output (no envelope metadata) */
  flattened: {
    response: "Found ticket TEM-123",
    ticket_id: "TEM-123",
    artifactRefs: [{ id: "ticket-1", type: "linear", summary: "TEM-123" }],
  },
  /** Flattened with error */
  flattenedError: { response: "Failed to process", error: { reason: "Invalid input" } },
  /** Summary agent: only artifactRefs, no text fields */
  summaryAgent: {
    ok: true,
    artifactRefs: [{ id: "sum-1", type: "summary", summary: "Weekly summary" }],
  },
  /** Real Google Sheets FSM output shape */
  googleSheetsFSM: {
    response: "Found 2 spreadsheets: Project Tracker and Q4 Budget",
    spreadsheets: [
      { id: "sheet-1", name: "Project Tracker", url: "https://docs.google.com/..." },
      { id: "sheet-2", name: "Q4 Budget", url: "https://docs.google.com/..." },
    ],
  },
};

describe("extractArtifactsFromOutput", () => {
  it("returns [] for invalid input (null, undefined, non-object)", () => {
    expect(extractArtifactsFromOutput(null)).toEqual([]);
    expect(extractArtifactsFromOutput(undefined)).toEqual([]);
    expect(extractArtifactsFromOutput("string")).toEqual([]);
    expect(extractArtifactsFromOutput(123)).toEqual([]);
  });

  it("returns [] when no artifactRefs present", () => {
    expect(extractArtifactsFromOutput({ ok: true, data: {} })).toEqual([]);
    expect(extractArtifactsFromOutput({ response: "text" })).toEqual([]);
  });

  it("deduplicates artifacts by ID, preserving first occurrence", () => {
    const input = {
      ok: true,
      data: {},
      artifactRefs: [
        { id: "dup", type: "code", summary: "first" },
        { id: "dup", type: "code", summary: "second (should be dropped)" },
        { id: "unique", type: "code", summary: "kept" },
      ],
    };
    const result = extractArtifactsFromOutput(input);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id)).toEqual(["dup", "unique"]);
    expect(result[0]?.summary).toBe("first");
  });
});

describe("sanitizeAgentOutput", () => {
  it("returns undefined for invalid input", () => {
    expect(sanitizeAgentOutput(null)).toBeUndefined();
    expect(sanitizeAgentOutput("string")).toBeUndefined();
    expect(sanitizeAgentOutput(123)).toBeUndefined();
  });

  it("extracts response from envelope shape", () => {
    const result = sanitizeAgentOutput(fixtures.envelope);
    expect(result?.ok).toBe(true);
    expect(result?.data?.response).toBe("Created divide.ts");
  });

  it("extracts response from flattened shape", () => {
    const result = sanitizeAgentOutput(fixtures.flattened);
    expect(result?.ok).toBe(true);
    expect(result?.data?.response).toBe("Found ticket TEM-123");
  });

  it("preserves error from envelope", () => {
    const result = sanitizeAgentOutput(fixtures.envelopeError);
    expect(result?.ok).toBe(false);
    expect(result?.error).toEqual({ reason: "API rate limit exceeded" });
  });

  it("preserves error from flattened shape", () => {
    const result = sanitizeAgentOutput(fixtures.flattenedError);
    expect(result?.ok).toBe(false);
    expect(result?.error).toEqual({ reason: "Invalid input" });
  });

  it("prioritizes response field over fallback serialization", () => {
    const input = {
      ok: true,
      data: { response: "Summary text", spreadsheets: [{ name: "Budget" }] },
    };
    const result = sanitizeAgentOutput(input);
    // response takes priority, spreadsheets not serialized
    expect(result?.data?.response).toBe("Summary text");
  });

  it("returns undefined data when no text fields and only artifact keys", () => {
    const result = sanitizeAgentOutput(fixtures.summaryAgent);
    expect(result?.ok).toEqual(true);
    expect(result?.data).toEqual(undefined);
  });

  it("fallback-serializes direct structured data with no text fields", () => {
    const input = { spreadsheets: [{ name: "Budget" }, { name: "Expenses" }] };
    const result = sanitizeAgentOutput(input);
    expect(result).toMatchObject({ ok: true });
    const response = result?.data?.response ?? "";
    expect(response).toContain("Budget");
    expect(response).toContain("Expenses");
    expect(JSON.parse(response)).toEqual({ spreadsheets: input.spreadsheets });
  });

  it("fallback-serializes wrapper structured data with no text fields", () => {
    const input = { ok: true, data: { events: [{ title: "Standup" }] } };
    const result = sanitizeAgentOutput(input);
    expect(result).toMatchObject({ ok: true });
    const response = result?.data?.response ?? "";
    expect(response).toContain("Standup");
    expect(JSON.parse(response)).toEqual({ events: [{ title: "Standup" }] });
  });

  it("fallback respects 12K char cap", () => {
    const input = { bigData: "x".repeat(20_000) };
    const result = sanitizeAgentOutput(input);
    expect(result).toMatchObject({ ok: true });
    const response = result?.data?.response ?? "";
    expect(response).toContain("[Content truncated");
    expect(response.length).toBeLessThan(20_000);
  });

  it("truncates response at 12K characters", () => {
    const longText = "x".repeat(20_000);
    const result = sanitizeAgentOutput({ ok: true, data: { response: longText } });
    const response = result?.data?.response ?? "";
    expect(response.length).toBeLessThan(longText.length);
    expect(response).toContain("[Content truncated");
  });

  it("handles circular references gracefully in fallback", () => {
    const circular: Record<string, unknown> = { key: "value" };
    circular.self = circular;
    const result = sanitizeAgentOutput({ ok: true, data: circular });
    expect(result?.ok).toBe(true);
    // Can't serialize circular, so no response
    expect(result?.data).toBeUndefined();
  });

  it("integration: sanitized results stay bounded for do_task flow", () => {
    // Simulates the sanitization loop from do-task/index.ts
    const hugeAgentOutput = {
      agentId: "claude-code",
      timestamp: "2026-02-03T12:00:00.000Z",
      input: "generate report",
      ok: true,
      data: { response: "x".repeat(200_000) },
      artifactRefs: [{ id: "pr-1", type: "code", summary: "PR data" }],
      durationMs: 5000,
    };

    const execResults = [{ step: 0, agent: "claude-code", success: true, output: hugeAgentOutput }];
    const sanitizedResults = execResults.map((r) => ({
      step: r.step,
      agent: r.agent,
      success: r.success,
      output: sanitizeAgentOutput(r.output),
    }));

    const serialized = JSON.stringify({ success: true, results: sanitizedResults });
    // Should be well under 50K (12K cap + overhead), not 200K+
    expect(serialized.length).toBeLessThan(50_000);
    expect(serialized).toContain("[Content truncated");
  });

  it("real Google Sheets FSM output: uses response field, preserves structured data in text", () => {
    const result = sanitizeAgentOutput(fixtures.googleSheetsFSM);
    expect(result?.ok).toEqual(true);
    expect(result?.data?.response).toEqual(fixtures.googleSheetsFSM.response);
    // spreadsheets key is not in the sanitized output — only response text
    expect(result?.data).toEqual({ response: fixtures.googleSheetsFSM.response });
  });

  it("real Google Sheets FSM output without response field: falls back to serialization", () => {
    // Simulates pre-fix behavior or LLM not populating optional response field
    const { response: _, ...withoutResponse } = fixtures.googleSheetsFSM;
    const result = sanitizeAgentOutput(withoutResponse);
    expect(result).toMatchObject({ ok: true });
    const response = result?.data?.response ?? "";
    // Fallback should serialize the spreadsheets array
    expect(response).toContain("Project Tracker");
    expect(response).toContain("Q4 Budget");
    const parsed: unknown = JSON.parse(response);
    expect(parsed).toEqual(
      expect.objectContaining({ spreadsheets: fixtures.googleSheetsFSM.spreadsheets }),
    );
  });

  it("does not affect existing small outputs from real agent patterns", () => {
    // Verify all original fixtures pass through unchanged
    for (const [, fixture] of Object.entries(fixtures)) {
      const result = sanitizeAgentOutput(fixture);
      if (result?.data?.response) {
        expect(result.data.response).not.toContain("[Content truncated");
      }
    }
  });
});

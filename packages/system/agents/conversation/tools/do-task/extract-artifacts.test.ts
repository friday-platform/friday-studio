import { describe, expect, it } from "vitest";
import { extractArtifactsFromOutput, sanitizeAgentOutput } from "./extract-artifacts.ts";

const fixtures = {
  claudeCode: {
    ok: true,
    data: {
      response: "Created divide.ts",
      artifactRef: { id: "abc-123", type: "code", summary: "divide function" },
    },
  },
  googleCalendar: {
    response: "Created 3 events",
    artifactRefs: [
      { id: "evt-1", type: "calendar", summary: "Meeting 1" },
      { id: "evt-2", type: "calendar", summary: "Meeting 2" },
    ],
  },
  llmAction: { content: "Here is the analysis...", toolCalls: [], toolResults: [] },
  webSearch: {
    ok: true,
    data: {
      summary: "Found 5 articles",
      artifactRef: { id: "s-1", type: "research", summary: "results" },
    },
  },
  summaryAgent: { artifactRefs: [{ id: "sum-1", type: "summary", summary: "Executive summary" }] },
  emailAgent: { response: "Email sent", message_id: "msg-123" },
  /** Shape observed from Google Sheets FSM agent in production.
   *  outputKeys: ["success", "spreadsheets", "response"], path: "direct", textField: "response" */
  googleSheetsFSM: {
    success: true,
    response:
      "Successfully listed 3 spreadsheets including project tracker, Q4 budget, and team roster.",
    spreadsheets: [
      { id: "sp-1", name: "Project Tracker", modified: "2026-01-20" },
      { id: "sp-2", name: "Q4 Budget", modified: "2026-01-15" },
      { id: "sp-3", name: "Team Roster", modified: "2026-01-10" },
    ],
  },
};

describe("extractArtifactsFromOutput", () => {
  it("returns [] for null/undefined/non-object", () => {
    expect(extractArtifactsFromOutput(null)).toEqual([]);
    expect(extractArtifactsFromOutput(undefined)).toEqual([]);
    expect(extractArtifactsFromOutput("string")).toEqual([]);
  });

  it("extracts artifactRef from Result wrapper", () => {
    const result = extractArtifactsFromOutput(fixtures.claudeCode);
    expect(result.length).toEqual(1);
    expect(result[0]?.id).toEqual("abc-123");
  });

  it("extracts artifactRefs from direct object", () => {
    const result = extractArtifactsFromOutput(fixtures.googleCalendar);
    expect(result.length).toEqual(2);
    expect(result[0]?.id).toEqual("evt-1");
  });

  it("returns [] when no artifacts", () => {
    expect(extractArtifactsFromOutput(fixtures.llmAction)).toEqual([]);
    expect(extractArtifactsFromOutput(fixtures.emailAgent)).toEqual([]);
  });

  it("deduplicates by id", () => {
    const input = {
      artifactRef: { id: "dup", type: "code", summary: "a" },
      artifactRefs: [{ id: "dup", type: "code", summary: "b" }],
    };
    expect(extractArtifactsFromOutput(input).length).toEqual(1);
  });
});

describe("sanitizeAgentOutput", () => {
  it("returns undefined for null/non-object", () => {
    expect(sanitizeAgentOutput(null)).toEqual(undefined);
    expect(sanitizeAgentOutput("string")).toEqual(undefined);
  });

  it("extracts response, strips artifactRef (Result wrapper)", () => {
    const result = sanitizeAgentOutput(fixtures.claudeCode);
    expect(result?.ok).toEqual(true);
    expect(result?.data?.response).toEqual("Created divide.ts");
    expect("artifactRef" in (result?.data ?? {})).toEqual(false);
  });

  it("extracts summary as response (Result wrapper)", () => {
    const result = sanitizeAgentOutput(fixtures.webSearch);
    expect(result?.data?.response).toEqual("Found 5 articles");
  });

  it("extracts response, strips artifactRefs (direct object)", () => {
    const result = sanitizeAgentOutput(fixtures.googleCalendar);
    expect(result?.data?.response).toEqual("Created 3 events");
    expect("artifactRefs" in (result ?? {})).toEqual(false);
  });

  it("extracts content as response (LLM output)", () => {
    const result = sanitizeAgentOutput(fixtures.llmAction);
    expect(result?.data?.response).toEqual("Here is the analysis...");
  });

  it("preserves error from failed Result", () => {
    const input = { ok: false, error: { reason: "limit" } };
    const result = sanitizeAgentOutput(input);
    expect(result?.ok).toEqual(false);
    expect(result?.error).toEqual({ reason: "limit" });
  });

  it("returns undefined data when no text fields and only artifact keys", () => {
    const result = sanitizeAgentOutput(fixtures.summaryAgent);
    expect(result?.ok).toEqual(true);
    expect(result?.data).toEqual(undefined);
  });

  it("fallback-serializes direct structured data with no text fields", () => {
    const input = { spreadsheets: [{ name: "Budget" }, { name: "Expenses" }] };
    const result = sanitizeAgentOutput(input);
    expect(result?.ok).toEqual(true);
    expect(result?.data?.response).toContain("Budget");
    expect(result?.data?.response).toContain("Expenses");
    expect(JSON.parse(result!.data!.response!)).toEqual({ spreadsheets: input.spreadsheets });
  });

  it("fallback-serializes wrapper structured data with no text fields", () => {
    const input = { ok: true, data: { events: [{ title: "Standup" }] } };
    const result = sanitizeAgentOutput(input);
    expect(result?.ok).toEqual(true);
    expect(result?.data?.response).toContain("Standup");
    expect(JSON.parse(result!.data!.response!)).toEqual({ events: [{ title: "Standup" }] });
  });

  it("fallback respects 12K char cap", () => {
    const input = { bigData: "x".repeat(20_000) };
    const result = sanitizeAgentOutput(input);
    expect(result?.ok).toEqual(true);
    expect(result?.data?.response).toContain("[Content truncated");
    expect(result!.data!.response!.length).toBeLessThan(20_000);
  });

  it("uses response field over fallback when both present", () => {
    const input = { response: "Summary text", spreadsheets: [{ name: "Budget" }] };
    const result = sanitizeAgentOutput(input);
    expect(result?.data?.response).toEqual("Summary text");
  });

  it("returns undefined for non-serializable data (circular reference)", () => {
    const circular: Record<string, unknown> = { key: "value" };
    circular.self = circular;
    const result = sanitizeAgentOutput(circular);
    expect(result?.ok).toEqual(true);
    expect(result?.data).toEqual(undefined);
  });

  it("passes through response under 12K chars unchanged", () => {
    const text = "x".repeat(12_000);
    const result = sanitizeAgentOutput({ ok: true, data: { response: text } });
    expect(result?.data?.response).toEqual(text);
  });

  it("truncates response over 12K chars (Result wrapper)", () => {
    const text = "x".repeat(20_000);
    const result = sanitizeAgentOutput({ ok: true, data: { response: text } });
    const response = result?.data?.response ?? "";
    expect(response.length).toBeLessThan(text.length);
    expect(response.startsWith("x".repeat(12_000))).toEqual(true);
    expect(response).toContain("[Content truncated");
  });

  it("truncates response over 12K chars (direct object)", () => {
    const text = "y".repeat(20_000);
    const result = sanitizeAgentOutput({ response: text });
    const response = result?.data?.response ?? "";
    expect(response.length).toBeLessThan(text.length);
    expect(response.startsWith("y".repeat(12_000))).toEqual(true);
    expect(response).toContain("[Content truncated");
  });

  it("truncates content field over 12K chars", () => {
    const text = "z".repeat(15_000);
    const result = sanitizeAgentOutput({ content: text });
    const response = result?.data?.response ?? "";
    expect(response.startsWith("z".repeat(12_000))).toEqual(true);
    expect(response).toContain("[Content truncated");
  });

  it("simulated do_task flow: sanitized results stay bounded even with massive agent output", () => {
    // Simulates the sanitization loop from do-task/index.ts lines 257-263
    const hugeAgentOutput = {
      ok: true,
      data: {
        response: "x".repeat(200_000), // 200K chars — a full GitHub PR listing
        artifactRef: { id: "pr-1", type: "code", summary: "PR data" },
      },
    };

    const execResults = [{ step: 0, agent: "claude-code", success: true, output: hugeAgentOutput }];

    const sanitizedResults = execResults.map((r) => ({
      step: r.step,
      agent: r.agent,
      success: r.success,
      output: sanitizeAgentOutput(r.output),
    }));

    // The tool result that gets appended to messages for step 2
    const toolResult = { success: true, summary: "Executed 1 step(s)", results: sanitizedResults };

    const serialized = JSON.stringify(toolResult);
    // Should be well under 50K chars total (12K cap + overhead)
    expect(serialized.length).toBeLessThan(50_000);
    // Original would have been 200K+
    expect(serialized.length).toBeLessThan(200_000);
    // Verify truncation marker is present
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
    expect(result?.ok).toEqual(true);
    // Fallback should serialize the spreadsheets array
    expect(result?.data?.response).toContain("Project Tracker");
    expect(result?.data?.response).toContain("Q4 Budget");
    const parsed: unknown = JSON.parse(result!.data!.response!);
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

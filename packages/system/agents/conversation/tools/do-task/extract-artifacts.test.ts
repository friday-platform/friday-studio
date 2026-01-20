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

  it("returns undefined data when no text fields", () => {
    const result = sanitizeAgentOutput(fixtures.summaryAgent);
    expect(result?.ok).toEqual(true);
    expect(result?.data).toEqual(undefined);
  });
});

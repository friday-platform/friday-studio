import { assertEquals } from "@std/assert";
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

Deno.test("extractArtifactsFromOutput", async (t) => {
  await t.step("returns [] for null/undefined/non-object", () => {
    assertEquals(extractArtifactsFromOutput(null), []);
    assertEquals(extractArtifactsFromOutput(undefined), []);
    assertEquals(extractArtifactsFromOutput("string"), []);
  });

  await t.step("extracts artifactRef from Result wrapper", () => {
    const result = extractArtifactsFromOutput(fixtures.claudeCode);
    assertEquals(result.length, 1);
    assertEquals(result[0]?.id, "abc-123");
  });

  await t.step("extracts artifactRefs from direct object", () => {
    const result = extractArtifactsFromOutput(fixtures.googleCalendar);
    assertEquals(result.length, 2);
    assertEquals(result[0]?.id, "evt-1");
  });

  await t.step("returns [] when no artifacts", () => {
    assertEquals(extractArtifactsFromOutput(fixtures.llmAction), []);
    assertEquals(extractArtifactsFromOutput(fixtures.emailAgent), []);
  });

  await t.step("deduplicates by id", () => {
    const input = {
      artifactRef: { id: "dup", type: "code", summary: "a" },
      artifactRefs: [{ id: "dup", type: "code", summary: "b" }],
    };
    assertEquals(extractArtifactsFromOutput(input).length, 1);
  });
});

Deno.test("sanitizeAgentOutput", async (t) => {
  await t.step("returns undefined for null/non-object", () => {
    assertEquals(sanitizeAgentOutput(null), undefined);
    assertEquals(sanitizeAgentOutput("string"), undefined);
  });

  await t.step("extracts response, strips artifactRef (Result wrapper)", () => {
    const result = sanitizeAgentOutput(fixtures.claudeCode);
    assertEquals(result?.ok, true);
    assertEquals(result?.data?.response, "Created divide.ts");
    assertEquals("artifactRef" in (result?.data ?? {}), false);
  });

  await t.step("extracts summary as response (Result wrapper)", () => {
    const result = sanitizeAgentOutput(fixtures.webSearch);
    assertEquals(result?.data?.response, "Found 5 articles");
  });

  await t.step("extracts response, strips artifactRefs (direct object)", () => {
    const result = sanitizeAgentOutput(fixtures.googleCalendar);
    assertEquals(result?.data?.response, "Created 3 events");
    assertEquals("artifactRefs" in (result ?? {}), false);
  });

  await t.step("extracts content as response (LLM output)", () => {
    const result = sanitizeAgentOutput(fixtures.llmAction);
    assertEquals(result?.data?.response, "Here is the analysis...");
  });

  await t.step("preserves error from failed Result", () => {
    const input = { ok: false, error: { reason: "limit" } };
    const result = sanitizeAgentOutput(input);
    assertEquals(result?.ok, false);
    assertEquals(result?.error, { reason: "limit" });
  });

  await t.step("returns undefined data when no text fields", () => {
    const result = sanitizeAgentOutput(fixtures.summaryAgent);
    assertEquals(result?.ok, true);
    assertEquals(result?.data, undefined);
  });
});

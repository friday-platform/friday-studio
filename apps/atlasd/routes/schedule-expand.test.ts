import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

// ─── Module mocks ────────────────────────────────────────────────────────────

const { mockSmallLLM, stubPlatformModels } = vi.hoisted(() => {
  // Inline a minimal PlatformModels stub so the hoisted block has no runtime
  // imports — vi.mock factories cannot reference module-scope values.
  const stub = {
    get() {
      throw new Error("stub LanguageModelV3 should not be invoked in these tests");
    },
  };
  return {
    mockSmallLLM:
      vi.fn<
        (params: { system: string; prompt: string; maxOutputTokens?: number }) => Promise<string>
      >(),
    stubPlatformModels: stub,
  };
});

vi.mock("@atlas/llm", () => ({ smallLLM: mockSmallLLM }));

// Import after mocks so the module picks up the mocked smallLLM
const { scheduleExpandRoutes } = await import("./schedule-expand.ts");

// ─── Schemas for test assertion parsing ──────────────────────────────────────

const ProposalResponseSchema = z.object({
  taskId: z.string(),
  text: z.string(),
  taskBrief: z.string(),
  priority: z.number(),
  kind: z.string(),
});

const ErrorResponseSchema = z.object({ error: z.string() });

// ─── Test app setup ──────────────────────────────────────────────────────────

const mockContext = { platformModels: stubPlatformModels };

const testApp = new Hono<{ Variables: { app: typeof mockContext } }>();
testApp.use("*", async (c, next) => {
  c.set("app", mockContext);
  await next();
});
testApp.route("/", scheduleExpandRoutes);

function postExpand(body: unknown): Promise<Response> {
  const request = new Request("http://localhost/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return Promise.resolve(testApp.fetch(request));
}

describe("POST /api/schedule-expand", () => {
  it("returns a valid ScheduleProposal from LLM output", async () => {
    const llmOutput = JSON.stringify({
      task_id: "manual-fix-broken-widget-abc123",
      text: "Fix the broken foo widget",
      task_brief: "The foo widget throws errors on click. Debug and fix the root cause.",
      priority: 10,
      kind: "bugfix",
    });
    mockSmallLLM.mockResolvedValueOnce(llmOutput);

    const response = await postExpand({ input: "fix broken widget" });
    expect(response.status).toBe(200);

    const json = ProposalResponseSchema.parse(await response.json());
    expect(json).toEqual({
      taskId: "manual-fix-broken-widget-abc123",
      text: "Fix the broken foo widget",
      taskBrief: "The foo widget throws errors on click. Debug and fix the root cause.",
      priority: 10,
      kind: "bugfix",
    });
  });

  it("handles LLM response wrapped in markdown code fences", async () => {
    const llmOutput =
      "```json\n" +
      JSON.stringify({
        task_id: "manual-add-logging-xyz",
        text: "Add structured logging",
        task_brief: "Add logging to the auth module for debugging.",
        priority: 15,
        kind: "improvement",
      }) +
      "\n```";
    mockSmallLLM.mockResolvedValueOnce(llmOutput);

    const response = await postExpand({ input: "add logging to auth" });
    expect(response.status).toBe(200);

    const json = ProposalResponseSchema.parse(await response.json());
    expect(json.taskId).toBe("manual-add-logging-xyz");
    expect(json.kind).toBe("improvement");
  });

  it("returns 400 for empty input", async () => {
    const response = await postExpand({ input: "" });
    expect(response.status).toBe(400);
  });

  it("returns 400 for missing input field", async () => {
    const response = await postExpand({});
    expect(response.status).toBe(400);
  });

  it("returns 502 when LLM returns invalid JSON", async () => {
    mockSmallLLM.mockResolvedValueOnce("This is not JSON at all");

    const response = await postExpand({ input: "fix something" });
    expect(response.status).toBe(502);

    const json = ErrorResponseSchema.parse(await response.json());
    expect(json.error).toContain("invalid JSON");
  });

  it("returns 502 when LLM output fails schema validation", async () => {
    mockSmallLLM.mockResolvedValueOnce(JSON.stringify({ task_id: "manual-bad", text: "Bad task" }));

    const response = await postExpand({ input: "bad input" });
    expect(response.status).toBe(502);

    const json = ErrorResponseSchema.parse(await response.json());
    expect(json.error).toContain("does not match expected shape");
  });

  it("returns 500 when LLM call throws", async () => {
    mockSmallLLM.mockRejectedValueOnce(new Error("LLM service unavailable"));

    const response = await postExpand({ input: "fix something" });
    expect(response.status).toBe(500);

    const json = ErrorResponseSchema.parse(await response.json());
    expect(json.error).toContain("LLM service unavailable");
  });
});

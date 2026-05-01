import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must come before module imports
// ---------------------------------------------------------------------------

const mockGenerateObject = vi.hoisted(() => vi.fn());

vi.mock("ai", () => ({ generateObject: mockGenerateObject }));

vi.mock("@atlas/agent-sdk", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, repairJson: vi.fn((text: string) => text) };
});

vi.mock("@atlas/llm", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getDefaultProviderOpts: vi.fn(() => ({})) };
});

vi.mock("@atlas/logger", () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

const mockRegistry = vi.hoisted(() => vi.fn(() => ({})));
vi.mock("@atlas/bundled-agents/registry", () => ({
  get bundledAgentsRegistry() {
    return mockRegistry();
  },
}));

import { createStubPlatformModels } from "@atlas/llm";
import type { ClassifiedDAGStep } from "../types.ts";
import { generateOutputSchemas } from "./schemas.ts";

const platformModels = createStubPlatformModels();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a ClassifiedDAGStep with sensible defaults. */
function makeStep(
  overrides: Partial<ClassifiedDAGStep> & { id: string; agentId: string },
): ClassifiedDAGStep {
  return {
    description: "step description",
    depends_on: [],
    executionType: "llm",
    executionRef: overrides.agentId,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateOutputSchemas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("bundled agent resolution", () => {
    it("uses executionRef for registry lookup when agentId is planner ID", async () => {
      // Agent keeps planner ID — step.executionRef points to bundled registry key
      const agents = [
        {
          id: "csv-data-analyst",
          name: "CSV Data Analyst",
          description: "Analyzes CSV data",
          capabilities: ["data-analysis"],
          bundledId: "data-analyst",
        },
      ];

      // Post-stamp: agentId preserved as planner ID, executionRef = bundled key
      const steps = [
        makeStep({
          id: "s1",
          agentId: "csv-data-analyst",
          executionType: "bundled",
          executionRef: "data-analyst",
          description: "Analyze data",
        }),
      ];

      const bundledSchema = {
        type: "object",
        properties: { result: { type: "string" } },
        required: ["result"],
      };

      mockRegistry.mockReturnValue({ "data-analyst": { outputJsonSchema: bundledSchema } });

      const result = await generateOutputSchemas(steps, agents, { platformModels });

      expect(result.get("s1")).toEqual(bundledSchema);
      expect(mockGenerateObject).not.toHaveBeenCalled();
    });

    it("resolves LLM agent by agentId directly", async () => {
      const agents = [
        { id: "reporter", name: "Reporter", description: "Reports findings", capabilities: [] },
      ];
      const steps = [
        makeStep({
          id: "s1",
          agentId: "reporter",
          executionType: "llm",
          executionRef: "reporter",
          description: "Write report",
        }),
      ];

      mockRegistry.mockReturnValue({});

      mockGenerateObject.mockResolvedValueOnce({
        object: {
          structure: "single_object",
          fields: [{ name: "summary", type: "string", description: "Report summary" }],
        },
      });

      const result = await generateOutputSchemas(steps, agents, { platformModels });

      expect(result.has("s1")).toBe(true);
      expect(mockGenerateObject).toHaveBeenCalledTimes(1);
      const call = mockGenerateObject.mock.calls[0];
      expect(call).toBeDefined();
      const callArgs = (call ?? [])[0] as { messages: Array<{ role: string; content: string }> };
      const userMessage = callArgs.messages.find((m) => m.role === "user");
      expect(userMessage?.content).toContain("Reporter");
      expect(userMessage?.content).toContain("Reports findings");
    });

    it("does not overwrite primary id when bundledId collides", async () => {
      // Two agents: one has id "data-analyst", the other has bundledId "data-analyst"
      const agents = [
        { id: "data-analyst", name: "Primary Analyst", description: "Primary", capabilities: [] },
        {
          id: "csv-analyst",
          name: "CSV Analyst",
          description: "CSV",
          capabilities: [],
          bundledId: "data-analyst",
        },
      ];
      const steps = [makeStep({ id: "s1", agentId: "data-analyst", description: "Analyze" })];

      mockRegistry.mockReturnValue({});
      mockGenerateObject.mockResolvedValueOnce({
        object: {
          structure: "single_object",
          fields: [{ name: "output", type: "string", description: "Output" }],
        },
      });

      const result = await generateOutputSchemas(steps, agents, { platformModels });

      expect(result.has("s1")).toBe(true);
      // Should resolve to "Primary Analyst" (primary key wins), not "CSV Analyst"
      expect(mockGenerateObject).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({ content: expect.stringContaining("Primary Analyst") }),
          ]),
        }),
      );
    });

    it("skips steps with no matching agent", async () => {
      const agents = [
        { id: "reporter", name: "Reporter", description: "Reports findings", capabilities: [] },
      ];
      const steps = [
        makeStep({
          id: "s1",
          agentId: "unknown-agent",
          executionRef: "unknown-agent",
          description: "Mystery",
        }),
      ];

      mockRegistry.mockReturnValue({});

      const result = await generateOutputSchemas(steps, agents, { platformModels });

      expect(result.size).toBe(0);
      expect(mockGenerateObject).not.toHaveBeenCalled();
    });
  });

  describe("LLM schema generation", () => {
    it("generates single_object schema via LLM", async () => {
      const agents = [
        { id: "writer", name: "Writer", description: "Writes content", capabilities: [] },
      ];
      const steps = [
        makeStep({
          id: "s1",
          agentId: "writer",
          executionRef: "writer",
          description: "Write article",
        }),
      ];

      mockRegistry.mockReturnValue({});
      mockGenerateObject.mockResolvedValueOnce({
        object: {
          structure: "single_object",
          fields: [
            { name: "title", type: "string", description: "Article title" },
            { name: "body", type: "string", description: "Article body" },
          ],
        },
      });

      const result = await generateOutputSchemas(steps, agents, { platformModels });

      const schema = result.get("s1");
      expect(schema).toBeDefined();
      expect(schema).toMatchObject({
        type: "object",
        properties: {
          title: { type: "string", description: "Article title" },
          body: { type: "string", description: "Article body" },
        },
      });
    });

    it("generates array_of_objects schema via LLM", async () => {
      const agents = [
        {
          id: "searcher",
          name: "Searcher",
          description: "Searches things",
          capabilities: ["research"],
        },
      ];
      const steps = [
        makeStep({
          id: "s1",
          agentId: "searcher",
          executionRef: "searcher",
          description: "Search news",
        }),
      ];

      mockRegistry.mockReturnValue({});
      mockGenerateObject.mockResolvedValueOnce({
        object: {
          structure: "array_of_objects",
          collectionKey: "results",
          fields: [
            { name: "title", type: "string", description: "Result title" },
            { name: "url", type: "string", description: "Result URL" },
          ],
        },
      });

      const result = await generateOutputSchemas(steps, agents, { platformModels });

      const schema = result.get("s1");
      expect(schema).toMatchObject({
        type: "object",
        properties: {
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string", description: "Result title" },
                url: { type: "string", description: "Result URL" },
              },
            },
          },
        },
        required: ["results"],
      });
    });

    // Assumes MAX_RETRIES = 3 (unexported const in schemas.ts)
    it("retries on failure up to MAX_RETRIES", async () => {
      const agents = [
        { id: "writer", name: "Writer", description: "Writes content", capabilities: [] },
      ];
      const steps = [
        makeStep({ id: "s1", agentId: "writer", executionRef: "writer", description: "Write" }),
      ];

      mockRegistry.mockReturnValue({});
      mockGenerateObject
        .mockRejectedValueOnce(new Error("API error"))
        .mockRejectedValueOnce(new Error("API error"))
        .mockResolvedValueOnce({
          object: {
            structure: "single_object",
            fields: [{ name: "output", type: "string", description: "Output" }],
          },
        });

      const result = await generateOutputSchemas(steps, agents, { platformModels });

      expect(result.has("s1")).toBe(true);
      expect(mockGenerateObject).toHaveBeenCalledTimes(3);
    });

    // Assumes MAX_RETRIES = 3 (unexported const in schemas.ts)
    it("throws after exhausting retries", async () => {
      const agents = [
        { id: "writer", name: "Writer", description: "Writes content", capabilities: [] },
      ];
      const steps = [
        makeStep({ id: "s1", agentId: "writer", executionRef: "writer", description: "Write" }),
      ];

      mockRegistry.mockReturnValue({});
      mockGenerateObject
        .mockRejectedValueOnce(new Error("fail 1"))
        .mockRejectedValueOnce(new Error("fail 2"))
        .mockRejectedValueOnce(new Error("fail 3"));

      await expect(generateOutputSchemas(steps, agents, { platformModels })).rejects.toThrow(
        "fail 3",
      );
    });
  });
});

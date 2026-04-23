import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockGenerateText = vi.fn();
const mockExecuteSearch = vi.fn();

vi.mock("ai", () => ({
  generateText: mockGenerateText,
  tool: vi.fn((opts: Record<string, unknown>) => opts),
}));

vi.mock("@atlas/llm", () => ({
  registry: { languageModel: vi.fn(() => "mock-model") },
  traceModel: vi.fn((m: unknown) => m),
  temporalGroundingMessage: vi.fn(() => ({ role: "system", content: "Today is 2026-03-11" })),
}));

vi.mock("@atlas/agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@atlas/agent-sdk")>();
  return { ...actual, repairToolCall: vi.fn() };
});

vi.mock("parallel-web", () => ({
  Parallel: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    return this;
  }),
}));

vi.mock("./search-execution.ts", () => ({
  executeSearch: mockExecuteSearch,
  resolveDefaultRecencyDays: vi.fn(() => undefined),
  QueryAnalysisSchema: z.object({
    complexity: z.enum(["simple", "complex"]),
    searchQueries: z.array(z.string()).min(2).max(10),
    includeDomains: z.array(z.string()).optional(),
    excludeDomains: z.array(z.string()).optional(),
    recencyDays: z.number().int().min(1).max(365).optional(),
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockLogger() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger;
}

function makeCtx(overrides?: Record<string, unknown>) {
  return {
    session: { sessionId: "s1", workspaceId: "w1", streamId: "c1" },
    stream: { emit: vi.fn(), end: vi.fn(), error: vi.fn() },
    logger: mockLogger(),
    config: undefined,
    abortSignal: undefined,
    ...overrides,
  };
}

/** Helper: extract the execute function with a type assertion to avoid AI SDK's optional execute type. */
async function executeSearch(
  ctx: ReturnType<typeof makeCtx>,
  input: { objective: string },
): Promise<string> {
  const { createSearchTool } = await import("./search.ts");
  const searchTool = createSearchTool(ctx);
  const execute = (
    searchTool as unknown as { execute: (input: { objective: string }) => Promise<string> }
  ).execute;
  return await execute(input);
}

/**
 * Sets up the mocks for a successful pipeline:
 * generateText (query analysis) → executeSearch → generateText (synthesis)
 */
function setupSuccessPipeline() {
  let generateTextCallCount = 0;
  // Query analysis: first generateText call has tools
  // Synthesis: second generateText call has no tools
  mockGenerateText.mockImplementation(
    async (opts: { tools?: { analyzeQuery: { execute: (input: unknown) => unknown } } }) => {
      generateTextCallCount++;
      if (generateTextCallCount === 1 && opts.tools) {
        await opts.tools.analyzeQuery.execute({
          complexity: "simple",
          searchQueries: ["test query 1", "test query 2"],
        });
        return { finishReason: "tool-calls", toolCalls: [], text: "" };
      }
      // Synthesis call
      return { finishReason: "stop", text: "Synthesized answer", toolCalls: [] };
    },
  );

  // Search execution
  mockExecuteSearch.mockResolvedValue({
    search_id: "search-1",
    results: [
      { url: "https://example.com/a", title: "Result A", excerpts: ["Content A"], publish_date: "2026-04-20" },
      { url: "https://example.com/b", title: "Result B", excerpts: ["Content B"] },
    ],
    usage: { totalTokens: 100 },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSearchTool", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PARALLEL_API_KEY = "test-key";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns error string when API keys are missing", async () => {
    delete process.env.PARALLEL_API_KEY;
    delete process.env.FRIDAY_GATEWAY_URL;

    const result = await executeSearch(makeCtx(), { objective: "test" });

    expect(result).toBe("Search unavailable: FRIDAY_GATEWAY_URL or PARALLEL_API_KEY is required");
  });

  it("returns error when gateway URL set but ATLAS_KEY missing", async () => {
    delete process.env.PARALLEL_API_KEY;
    process.env.FRIDAY_GATEWAY_URL = "https://gateway.test";
    delete process.env.ATLAS_KEY;

    const result = await executeSearch(makeCtx(), { objective: "test" });

    expect(result).toBe("Search unavailable: ATLAS_KEY is required when using FRIDAY_GATEWAY_URL");
  });

  it("runs full pipeline and returns summary + sources as JSON", async () => {
    setupSuccessPipeline();

    const result = await executeSearch(makeCtx(), { objective: "test topic" });
    const parsed = JSON.parse(result);

    expect(parsed.searchId).toBe("search-1");
    expect(parsed.summary).toBe("Synthesized answer");
    expect(parsed.sources).toHaveLength(2);
    expect(parsed.sources[0]).toMatchObject({
      title: "Result A",
      url: "https://example.com/a",
      publishDate: "2026-04-20",
    });
    expect(parsed.sources[1]).toMatchObject({
      title: "Result B",
      url: "https://example.com/b",
    });
    expect(parsed.usage).toEqual({ totalTokens: 100 });
  });

  it("returns error string when search returns no results", async () => {
    mockGenerateText.mockImplementation(
      async (opts: { tools?: { analyzeQuery: { execute: (input: unknown) => unknown } } }) => {
        if (opts.tools) {
          await opts.tools.analyzeQuery.execute({
            complexity: "simple",
            searchQueries: ["empty query", "another empty"],
          });
        }
        return { finishReason: "tool-calls", text: "", toolCalls: [] };
      },
    );
    mockExecuteSearch.mockResolvedValue({ search_id: "s-empty", results: [] });

    const result = await executeSearch(makeCtx(), { objective: "nothing exists" });

    expect(result).toBe("No relevant results found for your query");
  });

  it("emits progress events through all phases including synthesis", async () => {
    setupSuccessPipeline();

    const ctx = makeCtx();
    await executeSearch(ctx, { objective: "test" });

    const emitCalls = (ctx.stream.emit as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: Array<{ data: { content: string } }>) => {
        const event = c[0];
        if (!event) throw new Error("Missing emit event");
        return event.data.content;
      },
    );

    expect(emitCalls).toContain("Analyzing query...");
    expect(emitCalls).toContain("Searching 2 queries...");
    expect(emitCalls).toContain("Synthesizing results...");
  });
});

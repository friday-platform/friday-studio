import process from "node:process";
import type { ArtifactRef, OutlineRef } from "@atlas/agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockGenerateText = vi.fn();
const mockGenerateObject = vi.fn();
const mockArtifactPost = vi.fn();
const mockExecuteSearch = vi.fn();

vi.mock("ai", () => ({
  generateText: mockGenerateText,
  generateObject: mockGenerateObject,
  tool: vi.fn((opts: Record<string, unknown>) => opts),
}));

vi.mock("@atlas/llm", () => ({
  registry: { languageModel: vi.fn(() => "mock-model") },
  traceModel: vi.fn((m: unknown) => m),
  temporalGroundingMessage: vi.fn(() => ({ role: "system", content: "Today is 2026-03-11" })),
}));

vi.mock("@atlas/agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@atlas/agent-sdk")>();
  return { ...actual, repairJson: vi.fn(), repairToolCall: vi.fn() };
});

vi.mock("@atlas/client/v2", () => ({
  client: { artifactsStorage: { index: { $post: mockArtifactPost } } },
  parseResult: (p: Promise<unknown>) => p,
}));

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

function makeRefs(): { artifactRefs: ArtifactRef[]; outlineRefs: OutlineRef[] } {
  return { artifactRefs: [], outlineRefs: [] };
}

/** Helper: extract the execute function with a type assertion to avoid AI SDK's optional execute type. */
async function executeSearch(
  ctx: ReturnType<typeof makeCtx>,
  refs: ReturnType<typeof makeRefs>,
  input: { objective: string },
): Promise<string> {
  const { createSearchTool } = await import("./search.ts");
  const searchTool = createSearchTool(ctx, refs);
  const execute = (
    searchTool as unknown as { execute: (input: { objective: string }) => Promise<string> }
  ).execute;
  return await execute(input);
}

/**
 * Sets up the mocks for a successful full pipeline:
 * generateText (query analysis) → executeSearch → generateObject (synthesis) → artifact post
 */
function setupSuccessPipeline() {
  // Query analysis: generateText calls the analyzeQuery tool
  mockGenerateText.mockImplementation(
    async (opts: { tools: { analyzeQuery: { execute: (input: unknown) => unknown } } }) => {
      await opts.tools.analyzeQuery.execute({
        complexity: "simple",
        searchQueries: ["test query 1", "test query 2"],
      });
      return { finishReason: "tool-calls", toolCalls: [] };
    },
  );

  // Search execution
  mockExecuteSearch.mockResolvedValue({
    search_id: "search-1",
    results: [
      { url: "https://example.com/a", title: "Result A", excerpts: ["Content A"] },
      { url: "https://example.com/b", title: "Result B", excerpts: ["Content B"] },
    ],
  });

  // Synthesis
  mockGenerateObject.mockResolvedValue({
    object: {
      title: "Test Report",
      response: "# Full Report\n\nDetailed analysis...",
      sources: [
        { siteName: "Example", pageTitle: "Result A", url: "https://example.com/a" },
        { siteName: "Example", pageTitle: "Result B", url: "https://example.com/b" },
      ],
      summary: "Two results were found about the test topic.",
    },
  });

  // Artifact creation
  mockArtifactPost.mockResolvedValue({
    ok: true,
    data: { artifact: { id: "art-1", type: "web-search", summary: "Test Report summary" } },
  });
}

/** Zod schema for parsing the tool's JSON output */
const SearchOutputSchema = z.object({
  summary: z.string(),
  sources: z.array(z.object({ url: z.string(), title: z.string() })),
});

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

    const result = await executeSearch(makeCtx(), makeRefs(), { objective: "test" });

    expect(result).toBe("Search unavailable: FRIDAY_GATEWAY_URL or PARALLEL_API_KEY is required");
  });

  it("returns error when gateway URL set but ATLAS_KEY missing", async () => {
    delete process.env.PARALLEL_API_KEY;
    process.env.FRIDAY_GATEWAY_URL = "https://gateway.test";
    delete process.env.ATLAS_KEY;

    const result = await executeSearch(makeCtx(), makeRefs(), { objective: "test" });

    expect(result).toBe("Search unavailable: ATLAS_KEY is required when using FRIDAY_GATEWAY_URL");
  });

  it("runs full pipeline and returns structured JSON with summary and sources", async () => {
    setupSuccessPipeline();

    const result = await executeSearch(makeCtx(), makeRefs(), { objective: "test topic" });
    const parsed = SearchOutputSchema.parse(JSON.parse(result));

    expect(parsed.summary).toBe("Two results were found about the test topic.");
    expect(parsed.sources).toEqual([
      { url: "https://example.com/a", title: "Result A" },
      { url: "https://example.com/b", title: "Result B" },
    ]);
  });

  it("pushes artifact and outline refs on success", async () => {
    setupSuccessPipeline();

    const refs = makeRefs();
    await executeSearch(makeCtx(), refs, { objective: "test topic" });

    expect(refs.artifactRefs).toHaveLength(1);
    expect(refs.artifactRefs[0]).toEqual({
      id: "art-1",
      type: "web-search",
      summary: "Test Report summary",
    });

    expect(refs.outlineRefs).toHaveLength(1);
    expect(refs.outlineRefs[0]).toEqual({
      service: "internal",
      title: "Search Result",
      content: "Test Report",
      artifactId: "art-1",
      artifactLabel: "View Report",
      type: "web-search",
    });
  });

  it("returns error string when search returns no results", async () => {
    mockGenerateText.mockImplementation(
      async (opts: { tools: { analyzeQuery: { execute: (input: unknown) => unknown } } }) => {
        await opts.tools.analyzeQuery.execute({
          complexity: "simple",
          searchQueries: ["empty query", "another empty"],
        });
        return { finishReason: "tool-calls", toolCalls: [] };
      },
    );
    mockExecuteSearch.mockResolvedValue({ search_id: "s-empty", results: [] });

    const refs = makeRefs();
    const result = await executeSearch(makeCtx(), refs, { objective: "nothing exists" });

    expect(result).toBe("No relevant results found for your query");
    expect(refs.artifactRefs).toHaveLength(0);
  });

  it("emits progress events through all phases", async () => {
    setupSuccessPipeline();

    const ctx = makeCtx();
    await executeSearch(ctx, makeRefs(), { objective: "test" });

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

  it("returns synthesis even when artifact creation fails", async () => {
    setupSuccessPipeline();
    mockArtifactPost.mockResolvedValue({ ok: false, error: { message: "storage unavailable" } });

    const refs = makeRefs();
    const result = await executeSearch(makeCtx(), refs, { objective: "test" });

    // Still returns structured output — artifact is a side effect
    const parsed = SearchOutputSchema.parse(JSON.parse(result));
    expect(parsed.summary).toBeDefined();
    // No refs pushed
    expect(refs.artifactRefs).toHaveLength(0);
    expect(refs.outlineRefs).toHaveLength(0);
  });
});

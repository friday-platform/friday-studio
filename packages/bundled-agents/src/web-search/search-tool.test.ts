import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeAfterDate,
  executeSearch,
  filterStaleResults,
  resolveDefaultRecencyDays,
} from "./search-tool.ts";
import type { QueryAnalysis, SearchResult } from "./types.ts";

vi.mock("@atlas/llm", () => ({ smallLLM: vi.fn().mockResolvedValue("condensed objective") }));

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

/**
 * Creates a mock Parallel client for executeSearch tests.
 * executeSearch only calls client.beta.search(), so we mock just that path.
 */
function createMockClient(searchResult: SearchResult) {
  const searchFn = vi.fn().mockResolvedValue(searchResult);
  return {
    searchFn,
    client: { beta: { search: searchFn } } as unknown as Parameters<typeof executeSearch>[0],
  };
}

// =============================================================================
// computeAfterDate tests
// =============================================================================

describe("computeAfterDate", () => {
  afterEach(() => vi.useRealTimers());

  it("computes 1 day ago", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-08T12:00:00Z"));
    expect(computeAfterDate(1)).toBe("2026-02-07");
  });

  it("computes 365 days ago", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-08T12:00:00Z"));
    expect(computeAfterDate(365)).toBe("2025-02-08");
  });

  it("crosses month boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-03T12:00:00Z"));
    expect(computeAfterDate(5)).toBe("2026-02-26");
  });

  it("crosses year boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T12:00:00Z"));
    expect(computeAfterDate(5)).toBe("2025-12-28");
  });
});

// =============================================================================
// filterStaleResults tests
// =============================================================================

describe("filterStaleResults", () => {
  function makeResult(results: Array<{ url: string; publish_date?: string | null }>): SearchResult {
    return {
      search_id: "test-search",
      results: results.map((r) => ({ url: r.url, publish_date: r.publish_date })),
    };
  }

  it("keeps results newer than cutoff", () => {
    const result = makeResult([
      { url: "https://a.com", publish_date: "2026-02-07" },
      { url: "https://b.com", publish_date: "2026-02-08" },
    ]);

    const filtered = filterStaleResults(result, "2026-02-06", mockLogger());
    expect(filtered.results).toHaveLength(2);
  });

  it("removes results older than cutoff", () => {
    const result = makeResult([
      { url: "https://old.com", publish_date: "2024-03-19" },
      { url: "https://new.com", publish_date: "2026-02-07" },
    ]);

    const filtered = filterStaleResults(result, "2026-02-01", mockLogger());
    expect(filtered.results).toHaveLength(1);
    expect(filtered.results[0]?.url).toBe("https://new.com");
  });

  it("keeps results without publish_date", () => {
    const result = makeResult([
      { url: "https://no-date.com" },
      { url: "https://null-date.com", publish_date: null },
      { url: "https://new.com", publish_date: "2026-02-07" },
    ]);

    const filtered = filterStaleResults(result, "2026-02-01", mockLogger());
    expect(filtered.results).toHaveLength(3);
  });

  it("keeps results exactly at cutoff (>= boundary)", () => {
    const result = makeResult([{ url: "https://exact.com", publish_date: "2026-02-01" }]);

    const filtered = filterStaleResults(result, "2026-02-01", mockLogger());
    expect(filtered.results).toHaveLength(1);
  });

  it("returns empty results when all are stale", () => {
    const result = makeResult([
      { url: "https://old1.com", publish_date: "2023-01-01" },
      { url: "https://old2.com", publish_date: "2024-06-15" },
    ]);

    const filtered = filterStaleResults(result, "2026-02-01", mockLogger());
    expect(filtered.results).toHaveLength(0);
  });

  it("handles empty results array", () => {
    const result = makeResult([]);

    const filtered = filterStaleResults(result, "2026-02-01", mockLogger());
    expect(filtered.results).toHaveLength(0);
  });

  it("does not log when empty results are passed", () => {
    const logger = mockLogger();
    const result = makeResult([]);

    filterStaleResults(result, "2026-02-01", logger);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("logs when results are removed", () => {
    const logger = mockLogger();
    const result = makeResult([
      { url: "https://old.com", publish_date: "2024-01-01" },
      { url: "https://new.com", publish_date: "2026-02-07" },
    ]);

    filterStaleResults(result, "2026-02-01", logger);
    expect(logger.info).toHaveBeenCalledWith("Filtered stale results", {
      before: 2,
      after: 1,
      cutoff: "2026-02-01",
      removed: 1,
    });
  });

  it("does not log when no results are removed", () => {
    const logger = mockLogger();
    const result = makeResult([{ url: "https://new.com", publish_date: "2026-02-07" }]);

    filterStaleResults(result, "2026-02-01", logger);
    expect(logger.info).not.toHaveBeenCalled();
  });
});

// =============================================================================
// executeSearch integration tests
// =============================================================================

describe("executeSearch", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("passes after_date in source_policy when recencyDays is set", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-08T12:00:00Z"));

    const searchResult: SearchResult = {
      search_id: "s1",
      results: [{ url: "https://new.com", publish_date: "2026-02-07" }],
    };
    const { searchFn, client } = createMockClient(searchResult);

    const analysis: QueryAnalysis = {
      complexity: "simple",
      searchQueries: ["test query", "another query"],
      recencyDays: 7,
    };

    await executeSearch(client, "test objective", analysis, mockLogger());

    expect(searchFn).toHaveBeenCalledWith(
      expect.objectContaining({
        source_policy: expect.objectContaining({ after_date: "2026-02-01" }),
      }),
    );
  });

  it("filters stale results when recencyDays is set", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-08T12:00:00Z"));

    const searchResult: SearchResult = {
      search_id: "s2",
      results: [
        { url: "https://old.com", publish_date: "2024-01-01" },
        { url: "https://new.com", publish_date: "2026-02-07" },
      ],
    };
    const { client } = createMockClient(searchResult);

    const analysis: QueryAnalysis = {
      complexity: "simple",
      searchQueries: ["test query", "another query"],
      recencyDays: 7,
    };

    const result = await executeSearch(client, "test objective", analysis, mockLogger());

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.url).toBe("https://new.com");
  });

  it("does not set after_date when recencyDays is absent", async () => {
    const searchResult: SearchResult = { search_id: "s3", results: [{ url: "https://a.com" }] };
    const { searchFn, client } = createMockClient(searchResult);

    const analysis: QueryAnalysis = {
      complexity: "simple",
      searchQueries: ["test query", "another query"],
    };

    await executeSearch(client, "test objective", analysis, mockLogger());

    expect(searchFn).toHaveBeenCalledWith(expect.objectContaining({ source_policy: undefined }));
  });

  it("passes includeDomains in source_policy", async () => {
    const searchResult: SearchResult = {
      search_id: "s4",
      results: [{ url: "https://techcrunch.com/article" }],
    };
    const { searchFn, client } = createMockClient(searchResult);

    const analysis: QueryAnalysis = {
      complexity: "simple",
      searchQueries: ["openai news", "openai funding"],
      includeDomains: ["techcrunch.com"],
    };

    await executeSearch(client, "test objective", analysis, mockLogger());

    expect(searchFn).toHaveBeenCalledWith(
      expect.objectContaining({
        source_policy: expect.objectContaining({ include_domains: ["techcrunch.com"] }),
      }),
    );
  });

  it("passes excludeDomains in source_policy", async () => {
    const searchResult: SearchResult = {
      search_id: "s6",
      results: [{ url: "https://example.com/article" }],
    };
    const { searchFn, client } = createMockClient(searchResult);

    const analysis: QueryAnalysis = {
      complexity: "simple",
      searchQueries: ["AI news"],
      excludeDomains: ["reddit.com", "twitter.com"],
    };

    await executeSearch(client, "test objective", analysis, mockLogger());

    expect(searchFn).toHaveBeenCalledWith(
      expect.objectContaining({
        source_policy: expect.objectContaining({ exclude_domains: ["reddit.com", "twitter.com"] }),
      }),
    );
  });

  it("condenses long objectives via smallLLM", async () => {
    const { smallLLM } = await import("@atlas/llm");

    const searchResult: SearchResult = { search_id: "s7", results: [] };
    const { searchFn, client } = createMockClient(searchResult);
    const longObjective = "a".repeat(5000);

    await executeSearch(
      client,
      longObjective,
      { complexity: "simple", searchQueries: ["q1", "q2"] },
      mockLogger(),
    );

    expect(smallLLM).toHaveBeenCalledWith(expect.objectContaining({ prompt: longObjective }));
    expect(searchFn).toHaveBeenCalledWith(
      expect.objectContaining({ objective: "condensed objective" }),
    );
  });

  it("uses max_results 8 for simple queries and 15 for complex", async () => {
    const searchResult: SearchResult = { search_id: "s5", results: [] };
    const { searchFn: simpleFn, client: simpleClient } = createMockClient(searchResult);
    const { searchFn: complexFn, client: complexClient } = createMockClient(searchResult);

    await executeSearch(
      simpleClient,
      "test",
      { complexity: "simple", searchQueries: ["q1", "q2"] },
      mockLogger(),
    );
    await executeSearch(
      complexClient,
      "test",
      { complexity: "complex", searchQueries: ["q1", "q2"] },
      mockLogger(),
    );

    expect(simpleFn).toHaveBeenCalledWith(expect.objectContaining({ max_results: 8 }));
    expect(complexFn).toHaveBeenCalledWith(expect.objectContaining({ max_results: 15 }));
  });
});

// =============================================================================
// resolveDefaultRecencyDays tests
// =============================================================================

describe("resolveDefaultRecencyDays", () => {
  it("returns valid integer within range", () => {
    expect(resolveDefaultRecencyDays({ defaultRecencyDays: 7 })).toBe(7);
    expect(resolveDefaultRecencyDays({ defaultRecencyDays: 1 })).toBe(1);
    expect(resolveDefaultRecencyDays({ defaultRecencyDays: 365 })).toBe(365);
  });

  it("returns undefined for undefined config", () => {
    expect(resolveDefaultRecencyDays(undefined)).toBeUndefined();
  });

  it("returns undefined when key is missing", () => {
    expect(resolveDefaultRecencyDays({})).toBeUndefined();
    expect(resolveDefaultRecencyDays({ otherKey: 42 })).toBeUndefined();
  });

  it("rejects non-number values", () => {
    expect(resolveDefaultRecencyDays({ defaultRecencyDays: "7" })).toBeUndefined();
    expect(resolveDefaultRecencyDays({ defaultRecencyDays: true })).toBeUndefined();
    expect(resolveDefaultRecencyDays({ defaultRecencyDays: null })).toBeUndefined();
  });

  it("rejects out-of-range values", () => {
    expect(resolveDefaultRecencyDays({ defaultRecencyDays: 0 })).toBeUndefined();
    expect(resolveDefaultRecencyDays({ defaultRecencyDays: -5 })).toBeUndefined();
    expect(resolveDefaultRecencyDays({ defaultRecencyDays: 366 })).toBeUndefined();
    expect(resolveDefaultRecencyDays({ defaultRecencyDays: 1000 })).toBeUndefined();
  });

  it("rejects non-integer values", () => {
    expect(resolveDefaultRecencyDays({ defaultRecencyDays: 3.7 })).toBeUndefined();
    expect(resolveDefaultRecencyDays({ defaultRecencyDays: 7.5 })).toBeUndefined();
  });
});

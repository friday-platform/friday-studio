import { describe, expect, test } from "vitest";
import type { SearchResult } from "./search.ts";
import { reciprocalRankFusion, sanitizeFtsQuery } from "./search.ts";

// Helper to create a SearchResult for testing
function makeResult(id: number, sourceType: string, score = 0): SearchResult {
  return {
    id,
    title: `Result ${id}`,
    content: `Content for ${id}`,
    response: null,
    url: null,
    sourceType,
    score,
  };
}

describe("sanitizeFtsQuery", () => {
  test("joins tokens with OR", () => {
    expect(sanitizeFtsQuery("reset password")).toBe("reset OR password");
  });

  test("strips special characters", () => {
    expect(sanitizeFtsQuery("How to reset my password?")).toBe("How OR reset OR password");
  });

  test("strips FTS5 reserved words", () => {
    expect(sanitizeFtsQuery("login AND password NOT email")).toBe("login OR password OR email");
  });

  test("drops tokens shorter than 3 characters", () => {
    expect(sanitizeFtsQuery("I am on it")).toBe(null);
  });

  test("returns null for empty query", () => {
    expect(sanitizeFtsQuery("")).toBe(null);
  });

  test("returns null for query with only short words", () => {
    expect(sanitizeFtsQuery("a I do")).toBe(null);
  });

  test("strips parentheses, asterisks, slashes", () => {
    expect(sanitizeFtsQuery("(SSO) login*")).toBe("SSO OR login");
  });

  test("collapses multiple spaces", () => {
    expect(sanitizeFtsQuery("reset   my   password")).toBe("reset OR password");
  });

  test("handles curly quotes", () => {
    // Curly quotes " " are in the strip regex, result should have them removed
    const result = sanitizeFtsQuery("\u201Creset password\u201D");
    expect(result).toContain("reset");
    expect(result).toContain("password");
  });

  test("preserves 3-char tokens like SSO", () => {
    expect(sanitizeFtsQuery("SSO login issue")).toBe("SSO OR login OR issue");
  });
});

describe("reciprocalRankFusion", () => {
  test("merges BM25 and vector results by RRF score", () => {
    const bm25 = [makeResult(1, "ticket"), makeResult(2, "ticket")];
    const vec = [makeResult(2, "ticket"), makeResult(3, "ticket")];
    const merged = reciprocalRankFusion(bm25, vec, 60, 10);

    // Result 2 appears in both lists — should have highest RRF score
    expect(merged[0]?.id).toBe(2);
  });

  test("deduplicates results across lists", () => {
    const bm25 = [makeResult(1, "ticket"), makeResult(2, "ticket")];
    const vec = [makeResult(1, "ticket"), makeResult(2, "ticket")];
    const merged = reciprocalRankFusion(bm25, vec, 60, 10);

    const ids = merged.map((r) => r.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  test("respects limit parameter", () => {
    // Include KB articles so diversity doesn't over-reserve empty slots
    const bm25 = [
      ...Array.from({ length: 10 }, (_, i) => makeResult(i, "ticket")),
      ...Array.from({ length: 5 }, (_, i) => makeResult(i + 200, "knowledge_base")),
    ];
    const vec = Array.from({ length: 10 }, (_, i) => makeResult(i + 100, "ticket"));
    const merged = reciprocalRankFusion(bm25, vec, 60, 5);

    expect(merged.length).toBe(5);
  });

  test("applies KB diversity — backfills KB articles into results", () => {
    // 20 tickets ranked higher than KB articles
    const bm25 = Array.from({ length: 15 }, (_, i) => makeResult(i, "ticket"));
    const vec = [
      ...Array.from({ length: 5 }, (_, i) => makeResult(i, "ticket")),
      makeResult(100, "knowledge_base"),
      makeResult(101, "knowledge_base"),
      makeResult(102, "knowledge_base"),
    ];
    const merged = reciprocalRankFusion(bm25, vec, 60, 15);

    const kbCount = merged.filter((r) => r.sourceType === "knowledge_base").length;
    expect(kbCount).toBeGreaterThanOrEqual(3);
  });

  test("handles empty BM25 results", () => {
    const vec = [makeResult(1, "ticket"), makeResult(2, "knowledge_base")];
    const merged = reciprocalRankFusion([], vec, 60, 10);

    expect(merged.length).toBe(2);
  });

  test("handles empty vector results", () => {
    const bm25 = [makeResult(1, "ticket"), makeResult(2, "knowledge_base")];
    const merged = reciprocalRankFusion(bm25, [], 60, 10);

    expect(merged.length).toBe(2);
  });

  test("handles both empty", () => {
    const merged = reciprocalRankFusion([], [], 60, 10);
    expect(merged.length).toBe(0);
  });
});

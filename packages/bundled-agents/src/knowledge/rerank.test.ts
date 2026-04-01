import { describe, expect, test } from "vitest";
import { applyDiversity, escapeForPrompt } from "./rerank.ts";
import type { SearchResult } from "./search.ts";

function makeResult(id: number, sourceType: string, score: number): SearchResult {
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

describe("applyDiversity", () => {
  test("returns top N when enough KB articles already present", () => {
    const sorted = [
      makeResult(1, "knowledge_base", 0.9),
      makeResult(2, "knowledge_base", 0.8),
      makeResult(3, "ticket", 0.7),
      makeResult(4, "ticket", 0.6),
      makeResult(5, "ticket", 0.5),
    ];
    const result = applyDiversity(sorted, 5);
    expect(result.length).toBe(5);
    expect(result[0]?.id).toBe(1);
  });

  test("backfills KB articles when tickets dominate top N", () => {
    const sorted = [
      makeResult(1, "ticket", 0.9),
      makeResult(2, "ticket", 0.8),
      makeResult(3, "ticket", 0.7),
      makeResult(4, "ticket", 0.6),
      makeResult(5, "ticket", 0.5),
      makeResult(6, "knowledge_base", 0.4),
      makeResult(7, "knowledge_base", 0.3),
    ];
    const result = applyDiversity(sorted, 5);

    const kbCount = result.filter((r) => r.sourceType === "knowledge_base").length;
    expect(kbCount).toBe(2);
    expect(result.length).toBe(5);
  });

  test("handles fewer KB articles than minimum slots", () => {
    const sorted = [
      makeResult(1, "ticket", 0.9),
      makeResult(2, "ticket", 0.8),
      makeResult(3, "ticket", 0.7),
      makeResult(4, "knowledge_base", 0.6),
    ];
    // Only 1 KB article available, kbMinSlots=2
    const result = applyDiversity(sorted, 3);

    const kbCount = result.filter((r) => r.sourceType === "knowledge_base").length;
    expect(kbCount).toBe(1); // Can only fill 1, not 2
    expect(result.length).toBe(3);
  });

  test("handles all KB articles", () => {
    const sorted = [
      makeResult(1, "knowledge_base", 0.9),
      makeResult(2, "knowledge_base", 0.8),
      makeResult(3, "knowledge_base", 0.7),
    ];
    const result = applyDiversity(sorted, 3);
    expect(result.length).toBe(3);
    expect(result.every((r) => r.sourceType === "knowledge_base")).toBe(true);
  });

  test("maintains score-descending order after backfill", () => {
    const sorted = [
      makeResult(1, "ticket", 0.9),
      makeResult(2, "ticket", 0.8),
      makeResult(3, "ticket", 0.7),
      makeResult(4, "knowledge_base", 0.6),
      makeResult(5, "knowledge_base", 0.5),
    ];
    const result = applyDiversity(sorted, 5);

    for (let i = 1; i < result.length; i++) {
      const prev = result[i - 1];
      const curr = result[i];
      if (prev && curr) {
        expect(prev.score).toBeGreaterThanOrEqual(curr.score);
      }
    }
  });

  test("handles empty input", () => {
    const result = applyDiversity([], 5);
    expect(result.length).toBe(0);
  });

  test("treats confluence same as knowledge_base", () => {
    const sorted = [
      makeResult(1, "ticket", 0.9),
      makeResult(2, "ticket", 0.8),
      makeResult(3, "ticket", 0.7),
      makeResult(4, "confluence", 0.6),
      makeResult(5, "confluence", 0.5),
    ];
    const result = applyDiversity(sorted, 5);

    const nonTicket = result.filter((r) => r.sourceType !== "ticket").length;
    expect(nonTicket).toBe(2);
  });

  test("respects custom kbMinSlots", () => {
    const sorted = [
      makeResult(1, "ticket", 0.9),
      makeResult(2, "ticket", 0.8),
      makeResult(3, "ticket", 0.7),
      makeResult(4, "knowledge_base", 0.6),
      makeResult(5, "knowledge_base", 0.5),
      makeResult(6, "knowledge_base", 0.4),
    ];
    const result = applyDiversity(sorted, 5, 3);

    const kbCount = result.filter((r) => r.sourceType === "knowledge_base").length;
    expect(kbCount).toBe(3);
  });
});

describe("escapeForPrompt", () => {
  test("escapes ampersand", () => {
    expect(escapeForPrompt("A & B")).toBe("A &amp; B");
  });

  test("escapes angle brackets", () => {
    expect(escapeForPrompt("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  test("handles text without special chars", () => {
    expect(escapeForPrompt("hello world")).toBe("hello world");
  });

  test("handles empty string", () => {
    expect(escapeForPrompt("")).toBe("");
  });

  test("escapes multiple special chars", () => {
    expect(escapeForPrompt("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });
});

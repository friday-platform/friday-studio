import { describe, expect, it } from "vitest";
import {
  applyEditDelta,
  countMentionTokens,
  detectActiveMentionQuery,
  expandMentionSpans,
  type InsertedMentionRef,
  type InsertedMentionSpan,
  scoreTitleMatch,
  splitMentions,
} from "./mention-text.ts";

describe("splitMentions", () => {
  it("returns the original text as one segment when there are no mentions", () => {
    expect(splitMentions("just text")).toEqual([{ kind: "text", text: "just text" }]);
  });

  it("renders a resolved mention as a link segment with a workspace path", () => {
    const out = splitMentions("look at @ws-a/c1 here", [
      {
        workspaceId: "ws-a",
        chatId: "c1",
        title: "Demo chat",
        snapshot: "",
        messageCount: 0,
        generatedAt: "",
      },
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ kind: "text", text: "look at " });
    expect(out[1]).toMatchObject({
      kind: "mention",
      workspaceId: "ws-a",
      chatId: "c1",
      title: "Demo chat",
      href: "/platform/ws-a/chat/c1",
    });
    expect(out[2]).toEqual({ kind: "text", text: " here" });
  });

  it("keeps an unresolved mention as a text token (no broken link)", () => {
    const out = splitMentions("hi @ws-a/c1", []);
    expect(out).toEqual([
      { kind: "text", text: "hi " },
      { kind: "text", text: "@ws-a/c1" },
    ]);
  });
});

describe("countMentionTokens", () => {
  it("counts distinct mention pairs", () => {
    expect(countMentionTokens("hi @a/b and again @a/b plus @c/d")).toBe(2);
  });
});

describe("detectActiveMentionQuery", () => {
  it("returns null when there's no @ before the caret", () => {
    expect(detectActiveMentionQuery("hello", 5)).toBeNull();
  });

  it("captures the partial query when caret follows @", () => {
    const out = detectActiveMentionQuery("hi @dem", 7);
    expect(out).toEqual({ start: 3, end: 7, query: "dem" });
  });

  it("does not trigger inside an email-like sequence", () => {
    expect(detectActiveMentionQuery("ping user@host", 14)).toBeNull();
  });

  it("ends the query at whitespace", () => {
    expect(detectActiveMentionQuery("hi @demo and", 8)).toEqual({
      start: 3,
      end: 8,
      query: "demo",
    });
    // Caret past the space ends the active query
    expect(detectActiveMentionQuery("hi @demo and", 9)).toBeNull();
  });

  it("captures an empty query immediately after typing @", () => {
    const out = detectActiveMentionQuery("hello @", 7);
    expect(out).toEqual({ start: 6, end: 7, query: "" });
  });
});

describe("expandMentionSpans", () => {
  function span(start: number, length: number, ref: InsertedMentionRef): InsertedMentionSpan {
    return { start, length, ref };
  }
  const refA: InsertedMentionRef = { workspaceId: "ws-a", chatId: "c-1", title: "Demo" };
  const refB: InsertedMentionRef = { workspaceId: "ws-b", chatId: "c-2", title: "Demo" };

  it("substitutes each tracked span with its canonical token (trailing space preserved)", () => {
    // insertMention emits `@Title ` (with trailing space, length=title+2)
    const text = "see @Demo and @Demo done";
    const out = expandMentionSpans(text, [span(4, 6, refA), span(14, 6, refB)]);
    expect(out.text).toBe("see @ws-a/c-1 and @ws-b/c-2 done");
    expect(out.mentions).toEqual([refA, refB]);
  });

  it("disambiguates duplicate titles by offset (friday-studio-a0q)", () => {
    // The bug-codifying case: two distinct refs share a title. Spans
    // tag them by position, so the first `@Demo ` gets refA's
    // canonical and the second gets refB's. Title-keyed map would
    // have sent both to refB.
    const text = "@Demo and @Demo done";
    const out = expandMentionSpans(text, [span(0, 6, refA), span(10, 6, refB)]);
    expect(out.text).toBe("@ws-a/c-1 and @ws-b/c-2 done");
  });

  it("skips a span whose slice no longer matches the inserted display", () => {
    // User deleted the trailing space and typed `z` instead — the
    // slice is now `@Demoz`, not `@Demo `. applyEditDelta would
    // normally drop it; this is the second-line guard.
    const text = "@Demoz";
    const out = expandMentionSpans(text, [span(0, 6, refA)]);
    expect(out.text).toBe("@Demoz");
    expect(out.mentions).toEqual([]);
  });

  it("returns the original text when no spans are tracked", () => {
    expect(expandMentionSpans("hello", []).text).toBe("hello");
  });
});

describe("applyEditDelta", () => {
  const ref: InsertedMentionRef = { workspaceId: "w", chatId: "c", title: "Demo" };

  it("shifts spans that sit after the edit by the length delta", () => {
    // " @Demo" — span at offset 1, length 5. Prepend two chars.
    const spans = [{ start: 1, length: 5, ref }];
    const out = applyEditDelta(spans, "x @Demo", "xyz @Demo");
    expect(out).toEqual([{ start: 3, length: 5, ref }]);
  });

  it("leaves spans before the edit alone", () => {
    const spans = [{ start: 0, length: 5, ref }];
    const out = applyEditDelta(spans, "@Demo x", "@Demo xy");
    expect(out).toEqual([{ start: 0, length: 5, ref }]);
  });

  it("drops spans that overlap the edit", () => {
    // Delete the middle of the inserted display — span is mutilated.
    const spans = [{ start: 0, length: 5, ref }];
    const out = applyEditDelta(spans, "@Demo", "@Do");
    expect(out).toEqual([]);
  });

  it("returns the spans unchanged when prev === new", () => {
    const spans = [{ start: 3, length: 5, ref }];
    expect(applyEditDelta(spans, "abc@Demo", "abc@Demo")).toEqual(spans);
  });
});

describe("scoreTitleMatch", () => {
  it("ranks prefix > word-start > substring > miss", () => {
    const prefix = scoreTitleMatch("Demo notes", "dem");
    const wordStart = scoreTitleMatch("Notes demo", "dem");
    const substring = scoreTitleMatch("Sample demos", "emo");
    const miss = scoreTitleMatch("Unrelated", "dem");
    expect(prefix).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(substring);
    expect(miss).toBe(Number.NEGATIVE_INFINITY);
  });

  it("returns a neutral score for empty queries (all titles are eligible)", () => {
    expect(scoreTitleMatch("anything", "")).toBe(0);
  });
});

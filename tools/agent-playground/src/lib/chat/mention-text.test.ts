import { describe, expect, it } from "vitest";
import {
  countMentionTokens,
  detectActiveMentionQuery,
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
      href: "/workspaces/ws-a/chat/c1",
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

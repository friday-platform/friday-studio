import { describe, expect, it } from "vitest";
import {
  countMentionTokens,
  detectActiveMentionQuery,
  expandMentionDisplayText,
  type InsertedMentionRef,
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

describe("expandMentionDisplayText", () => {
  const refsByTitle = new Map<string, InsertedMentionRef>([
    ["Demo notes", { workspaceId: "ws-a", chatId: "c-1", title: "Demo notes" }],
    ["Plain", { workspaceId: "ws-b", chatId: "c-2", title: "Plain" }],
  ]);

  it("expands @<title> into the canonical @<wsId>/<chatId> token", () => {
    const out = expandMentionDisplayText("see @Demo notes please", refsByTitle);
    expect(out.text).toBe("see @ws-a/c-1 please");
    expect(out.mentions).toEqual([
      { workspaceId: "ws-a", chatId: "c-1", title: "Demo notes" },
    ]);
  });

  it("only reports each ref once even if the title appears twice", () => {
    const out = expandMentionDisplayText("@Plain and @Plain again", refsByTitle);
    expect(out.text).toBe("@ws-b/c-2 and @ws-b/c-2 again");
    expect(out.mentions).toHaveLength(1);
  });

  it("leaves an edited title alone (substitution fails the match)", () => {
    const out = expandMentionDisplayText("@Demo notez", refsByTitle);
    expect(out.text).toBe("@Demo notez");
    expect(out.mentions).toEqual([]);
  });

  it("matches longest title first so a prefix-title doesn't eat its own suffix", () => {
    const refs = new Map<string, InsertedMentionRef>([
      ["Foo", { workspaceId: "ws", chatId: "f", title: "Foo" }],
      ["Foo bar", { workspaceId: "ws", chatId: "fb", title: "Foo bar" }],
    ]);
    const out = expandMentionDisplayText("@Foo bar", refs);
    expect(out.text).toBe("@ws/fb");
  });

  it("returns the original text when no refs have been picked", () => {
    expect(expandMentionDisplayText("hello", new Map()).text).toBe("hello");
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

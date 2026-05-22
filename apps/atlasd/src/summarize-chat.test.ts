/**
 * Unit tests for the map-reduce summarizer (friday-studio-6dq).
 * Mocks `smallLLM` directly so the test never touches a real provider.
 */

import type { AtlasUIMessage } from "@atlas/agent-sdk";
import type { Chat } from "@atlas/core/chat/storage";
import { createStubPlatformModels } from "@atlas/llm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const smallLLMMock = vi.hoisted(() => vi.fn());

vi.mock("@atlas/llm", async () => {
  const actual = await vi.importActual<typeof import("@atlas/llm")>("@atlas/llm");
  return { ...actual, smallLLM: smallLLMMock };
});

import { chunkLedger, projectMessages, summarizeChat } from "./summarize-chat.ts";

function makeMessage(role: "user" | "assistant", text: string): AtlasUIMessage {
  return { id: crypto.randomUUID(), role, parts: [{ type: "text", text }] };
}

function makeChat(messages: AtlasUIMessage[]): Chat {
  return {
    id: "c-1",
    userId: "u-1",
    workspaceId: "ws-a",
    source: "atlas",
    createdAt: "2026-05-22T00:00:00.000Z",
    updatedAt: "2026-05-22T00:00:00.000Z",
    title: "Demo",
    messages,
  };
}

beforeEach(() => {
  smallLLMMock.mockReset();
});

describe("projectMessages", () => {
  it("flattens text parts into role-prefixed blocks and skips empty messages", () => {
    const chat = makeChat([
      makeMessage("user", "hello"),
      { id: crypto.randomUUID(), role: "assistant", parts: [] },
      makeMessage("assistant", "hi"),
    ]);
    const { ledger, usedCount } = projectMessages(chat);
    expect(ledger).toEqual(["[user] hello", "[assistant] hi"]);
    expect(usedCount).toBe(2);
  });

  it("returns an empty ledger when no message carries text", () => {
    const chat = makeChat([{ id: "1", role: "user", parts: [{ type: "text", text: "" }] }]);
    expect(projectMessages(chat).usedCount).toBe(0);
  });
});

describe("chunkLedger", () => {
  it("packs whole messages until the char budget is hit", () => {
    const ledger = ["aaaa", "bbbb", "cccc", "dddd"];
    const chunks = chunkLedger(ledger, 12); // fits 2 blocks + separator
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk's length stays within budget
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(12);
  });

  it("splits an oversized single message across chunks rather than dropping it", () => {
    const long = "x".repeat(50);
    const chunks = chunkLedger([long], 20);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(long);
  });

  it("returns a single chunk when everything fits", () => {
    expect(chunkLedger(["a", "b"], 100)).toEqual(["a\n\nb"]);
  });
});

describe("summarizeChat", () => {
  it("short-circuits and returns a sentinel summary for an empty chat", async () => {
    const chat = makeChat([]);
    const out = await summarizeChat({ chat, platformModels: createStubPlatformModels() });
    expect(out.messageCount).toBe(0);
    expect(out.summary).toContain("empty");
    expect(smallLLMMock).not.toHaveBeenCalled();
  });

  it("uses the map output directly when there's a single chunk (no reduce call)", async () => {
    smallLLMMock.mockResolvedValueOnce("- single-chunk summary");
    const chat = makeChat([makeMessage("user", "hello"), makeMessage("assistant", "hi")]);
    const out = await summarizeChat({ chat, platformModels: createStubPlatformModels() });
    expect(out.summary).toBe("- single-chunk summary");
    expect(out.messageCount).toBe(2);
    expect(smallLLMMock).toHaveBeenCalledTimes(1);
  });

  it("runs map-then-reduce when the ledger spans multiple chunks", async () => {
    // Two messages that each fit in one chunk, but together force a
    // second chunk — 2 map calls + 1 reduce call. Sizing below
    // CHUNK_MAX_CHARS (24_000) so a single message never splits.
    const big = "x".repeat(15_000);
    const chat = makeChat([makeMessage("user", big), makeMessage("assistant", big)]);
    smallLLMMock
      .mockResolvedValueOnce("- partial 1")
      .mockResolvedValueOnce("- partial 2")
      .mockResolvedValueOnce("Context: combined summary");

    const out = await summarizeChat({ chat, platformModels: createStubPlatformModels() });
    expect(out.summary).toBe("Context: combined summary");
    expect(smallLLMMock).toHaveBeenCalledTimes(3);
    // The reduce call's prompt should reference both partials.
    const reduceCall = smallLLMMock.mock.calls[2];
    expect(reduceCall?.[0].prompt).toContain("Partial 1");
    expect(reduceCall?.[0].prompt).toContain("Partial 2");
  });

  it("threads the focus parameter into the system prompt of every LLM call", async () => {
    smallLLMMock.mockResolvedValueOnce("- partial");
    const chat = makeChat([makeMessage("user", "anything")]);
    await summarizeChat({
      chat,
      platformModels: createStubPlatformModels(),
      focus: "decisions only",
    });
    const mapCall = smallLLMMock.mock.calls[0];
    expect(mapCall?.[0].system).toContain("decisions only");
  });
});

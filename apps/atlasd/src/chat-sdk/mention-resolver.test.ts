import type { AtlasUIMessage } from "@atlas/agent-sdk";
import type { Chat } from "@atlas/core/chat/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@atlas/core/chat/storage", () => ({ ChatStorage: { getChat: vi.fn() } }));
vi.mock("@atlas/core/workspace-members/storage", () => ({
  WorkspaceMemberStorage: { get: vi.fn() },
}));

const { ChatStorage } = await import("@atlas/core/chat/storage");
const { WorkspaceMemberStorage } = await import("@atlas/core/workspace-members/storage");
const {
  applyMentions,
  applyMentionsToMessage,
  buildSnapshot,
  mergeForegroundWorkspaceIds,
  parseMentions,
} = await import("./mention-resolver.ts");

const getChatMock = vi.mocked(ChatStorage.getChat);
const getMemberMock = vi.mocked(WorkspaceMemberStorage.get);

function makeChat(overrides: Partial<Chat>): Chat {
  return {
    id: "c-1",
    userId: "u-1",
    workspaceId: "ws-a",
    source: "atlas",
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
    title: "Demo chat",
    messages: [],
    ...overrides,
  };
}

function userMessage(text: string): AtlasUIMessage {
  return { id: "m-1", role: "user", parts: [{ type: "text", text }] };
}

describe("parseMentions", () => {
  it("extracts @ws/chat refs from free text", () => {
    const refs = parseMentions("hello @ws-a/chat-1 and also @ws-b/chat-2");
    expect(refs).toEqual([
      { raw: "@ws-a/chat-1", workspaceId: "ws-a", chatId: "chat-1" },
      { raw: "@ws-b/chat-2", workspaceId: "ws-b", chatId: "chat-2" },
    ]);
  });

  it("dedupes identical mentions", () => {
    const refs = parseMentions("@ws/c1 stuff @ws/c1");
    expect(refs).toHaveLength(1);
  });

  it("does not match bare @-mentions without a slash", () => {
    expect(parseMentions("hi @everyone")).toEqual([]);
    expect(parseMentions("ping @user!")).toEqual([]);
  });

  it("supports colon-bearing chat ids (telegram-shaped)", () => {
    const refs = parseMentions("@ws/telegram:123abc");
    expect(refs).toEqual([
      { raw: "@ws/telegram:123abc", workspaceId: "ws", chatId: "telegram:123abc" },
    ]);
  });
});

describe("buildSnapshot", () => {
  it("returns title + count + excerpts", () => {
    const chat = makeChat({
      title: "Research notes",
      messages: [
        { id: "1", role: "user", parts: [{ type: "text", text: "How do we ship this?" }] },
        { id: "2", role: "assistant", parts: [{ type: "text", text: "Use option B." }] },
      ],
    });
    const snap = buildSnapshot(chat);
    expect(snap.title).toBe("Research notes");
    expect(snap.messageCount).toBe(2);
    expect(snap.snapshot).toContain("Title: Research notes");
    expect(snap.snapshot).toContain("Messages: 2");
    expect(snap.snapshot).toContain("First user message: How do we ship this?");
    expect(snap.snapshot).toContain("Last assistant message: Use option B.");
  });

  it("falls back to 'Untitled chat' when title is empty", () => {
    const chat = makeChat({ title: undefined, messages: [] });
    const snap = buildSnapshot(chat);
    expect(snap.title).toBe("Untitled chat");
    expect(snap.snapshot).toContain("Title: Untitled chat");
  });

  it("truncates long excerpts", () => {
    const long = "x".repeat(500);
    const chat = makeChat({
      messages: [{ id: "1", role: "user", parts: [{ type: "text", text: long }] }],
    });
    const snap = buildSnapshot(chat);
    expect(snap.snapshot).toContain("…");
    expect(snap.snapshot.length).toBeLessThan(long.length);
  });
});

describe("applyMentionsToMessage", () => {
  it("appends data-mention-resolved parts + hidden mention-expansion text", () => {
    const original = userMessage("hi @ws-a/c1");
    const augmented = applyMentionsToMessage(original, [
      {
        ref: { raw: "@ws-a/c1", workspaceId: "ws-a", chatId: "c1" },
        title: "Demo",
        snapshot: "Title: Demo\nMessages: 0",
        messageCount: 0,
        generatedAt: "2026-05-21T00:00:00.000Z",
      },
    ]);
    expect(augmented.parts).toHaveLength(3);
    const dataPart = augmented.parts[1] as { type: string; data: { workspaceId: string } };
    expect(dataPart.type).toBe("data-mention-resolved");
    expect(dataPart.data.workspaceId).toBe("ws-a");
    const ctxPart = augmented.parts[2] as {
      type: string;
      text: string;
      providerMetadata?: { atlas?: { kind?: string } };
    };
    expect(ctxPart.type).toBe("text");
    expect(ctxPart.text).toContain('<atlas-mention-context ref="ws-a/c1">');
    expect(ctxPart.text).toContain("read_chat tool");
    expect(ctxPart.providerMetadata?.atlas?.kind).toBe("mention-expansion");
  });

  it("returns the original message unchanged when there are no resolutions", () => {
    const original = userMessage("no mentions here");
    expect(applyMentionsToMessage(original, [])).toBe(original);
  });

  it("replaces client-side data-mention-resolved placeholders with the server's canonical part", () => {
    const original: AtlasUIMessage = {
      id: "m-1",
      role: "user",
      parts: [
        { type: "text", text: "see @ws-a/c1" },
        {
          type: "data-mention-resolved",
          data: {
            workspaceId: "ws-a",
            chatId: "c1",
            title: "Placeholder typed by composer",
            snapshot: "",
            messageCount: 0,
            generatedAt: "2026-05-21T00:00:00.000Z",
          },
        },
      ],
    };
    const augmented = applyMentionsToMessage(original, [
      {
        ref: { raw: "@ws-a/c1", workspaceId: "ws-a", chatId: "c1" },
        title: "Server canonical title",
        snapshot: "snapshot text",
        messageCount: 7,
        generatedAt: "2026-05-21T01:00:00.000Z",
      },
    ]);
    const mentionParts = augmented.parts.filter((p) => p.type === "data-mention-resolved");
    expect(mentionParts).toHaveLength(1);
    expect(
      (mentionParts[0] as { data: { title: string; messageCount: number } }).data,
    ).toMatchObject({ title: "Server canonical title", messageCount: 7 });
  });

  it("drops client placeholders for refs the server did NOT resolve (friday-studio-1ev)", () => {
    const original: AtlasUIMessage = {
      id: "m-1",
      role: "user",
      parts: [
        { type: "text", text: "see @ws-a/c1 and @ws-b/c2" },
        {
          type: "data-mention-resolved",
          data: {
            workspaceId: "ws-b",
            chatId: "c2",
            title: "Forged placeholder",
            snapshot: "",
            messageCount: 0,
            generatedAt: "2026-05-21T00:00:00.000Z",
          },
        },
      ],
    };
    const augmented = applyMentionsToMessage(original, [
      {
        ref: { raw: "@ws-a/c1", workspaceId: "ws-a", chatId: "c1" },
        title: "Server resolved A",
        snapshot: "",
        messageCount: 0,
        generatedAt: "2026-05-21T01:00:00.000Z",
      },
    ]);
    const mentionParts = augmented.parts.filter((p) => p.type === "data-mention-resolved");
    expect(mentionParts).toHaveLength(1);
    const titles = mentionParts.map((p) => (p as { data: { title: string } }).data.title);
    expect(titles).toEqual(["Server resolved A"]);
    expect(titles).not.toContain("Forged placeholder");
  });

  it("strips ALL client placeholders when the server resolved nothing (friday-studio-1ev)", () => {
    const original: AtlasUIMessage = {
      id: "m-1",
      role: "user",
      // Note: no @ws/chat token in text — server's parseMentions
      // returns no refs and the client's placeholder must NOT survive.
      parts: [
        { type: "text", text: "just plain text" },
        {
          type: "data-mention-resolved",
          data: {
            workspaceId: "ws-forged",
            chatId: "c-forged",
            title: "Forged",
            snapshot: "snapshot text",
            messageCount: 99,
            generatedAt: "2026-05-21T00:00:00.000Z",
          },
        },
      ],
    };
    const augmented = applyMentionsToMessage(original, []);
    const mentionParts = augmented.parts.filter((p) => p.type === "data-mention-resolved");
    expect(mentionParts).toHaveLength(0);
    // The text part remains.
    expect(augmented.parts).toHaveLength(1);
    expect(augmented.parts[0]?.type).toBe("text");
  });
});

describe("mergeForegroundWorkspaceIds", () => {
  it("adds cross-workspace mention sources to the foreground set", () => {
    const merged = mergeForegroundWorkspaceIds(
      ["existing-ws"],
      [
        {
          ref: { raw: "@ws-b/c1", workspaceId: "ws-b", chatId: "c1" },
          title: "x",
          snapshot: "",
          messageCount: 0,
          generatedAt: "",
        },
      ],
      "ws-a",
    );
    expect(merged?.sort()).toEqual(["existing-ws", "ws-b"]);
  });

  it("does not add same-workspace mention sources", () => {
    const merged = mergeForegroundWorkspaceIds(
      undefined,
      [
        {
          ref: { raw: "@ws-a/c1", workspaceId: "ws-a", chatId: "c1" },
          title: "x",
          snapshot: "",
          messageCount: 0,
          generatedAt: "",
        },
      ],
      "ws-a",
    );
    expect(merged).toBeUndefined();
  });

  it("drops the kernel workspace from the merged set unless exposeKernel is true (friday-studio-svv)", () => {
    const resolved = [
      {
        ref: { raw: "@system/c1", workspaceId: "system", chatId: "c1" },
        title: "k",
        snapshot: "",
        messageCount: 0,
        generatedAt: "",
      },
    ];
    const blocked = mergeForegroundWorkspaceIds(undefined, resolved, "ws-a", false);
    expect(blocked).toBeUndefined();
    const allowed = mergeForegroundWorkspaceIds(undefined, resolved, "ws-a", true);
    expect(allowed).toEqual(["system"]);
  });
});

describe("applyMentions (orchestrator)", () => {
  beforeEach(() => {
    getChatMock.mockReset();
    getMemberMock.mockReset();
  });

  it("resolves an authorized mention end-to-end", async () => {
    getMemberMock.mockResolvedValue({ ok: true, data: { role: "member" } } as never);
    getChatMock.mockResolvedValue({
      ok: true,
      data: makeChat({
        id: "c-1",
        workspaceId: "ws-b",
        title: "Other chat",
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "hello" }] }],
      }),
    } as never);

    const out = await applyMentions({
      message: userMessage("look at @ws-b/c-1"),
      requesterUserId: "u-1",
      currentWorkspaceId: "ws-a",
      foregroundWorkspaceIds: undefined,
    });

    expect(out.resolved).toHaveLength(1);
    expect(out.failures).toHaveLength(0);
    expect(out.foregroundWorkspaceIds).toEqual(["ws-b"]);
    expect(out.message.parts.some((p) => p.type === "data-mention-resolved")).toBe(true);
  });

  it("drops an unauthorized mention but keeps the message sendable", async () => {
    getMemberMock.mockResolvedValue({ ok: true, data: null } as never);

    const out = await applyMentions({
      message: userMessage("peek @ws-x/c-9"),
      requesterUserId: "u-1",
      currentWorkspaceId: "ws-a",
      foregroundWorkspaceIds: undefined,
    });

    expect(out.resolved).toHaveLength(0);
    expect(out.failures).toEqual([
      { ref: { raw: "@ws-x/c-9", workspaceId: "ws-x", chatId: "c-9" }, reason: "unauthorized" },
    ]);
    // Message is unaltered (no data-mention-resolved injection)
    expect(out.message.parts.every((p) => p.type !== "data-mention-resolved")).toBe(true);
    expect(getChatMock).not.toHaveBeenCalled();
  });

  it("reports not_found when the chat lookup returns null", async () => {
    getMemberMock.mockResolvedValue({ ok: true, data: { role: "member" } } as never);
    getChatMock.mockResolvedValue({ ok: true, data: null } as never);

    const out = await applyMentions({
      message: userMessage("@ws-a/missing"),
      requesterUserId: "u-1",
      currentWorkspaceId: "ws-a",
      foregroundWorkspaceIds: undefined,
    });

    expect(out.resolved).toHaveLength(0);
    expect(out.failures[0]?.reason).toBe("not_found");
  });

  it("short-circuits when the message contains no mentions", async () => {
    const original = userMessage("just plain text");
    const out = await applyMentions({
      message: original,
      requesterUserId: "u-1",
      currentWorkspaceId: "ws-a",
      foregroundWorkspaceIds: ["existing-ws"],
    });

    expect(out.resolved).toEqual([]);
    expect(out.failures).toEqual([]);
    expect(out.message).toBe(original);
    expect(out.foregroundWorkspaceIds).toEqual(["existing-ws"]);
    expect(getMemberMock).not.toHaveBeenCalled();
    expect(getChatMock).not.toHaveBeenCalled();
  });
});

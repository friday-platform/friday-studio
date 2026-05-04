/**
 * Integration tests for top-level /api/chat routes (Phase 6 delegation shim).
 *
 * Verifies that POST /api/chat delegates to the user workspace Chat SDK instance,
 * GET/PATCH/DELETE endpoints fall back to legacy global chat paths, and the list
 * endpoint merges + deduplicates user workspace and legacy global chats.
 */

import { WorkspaceNotFoundError } from "@atlas/core/errors/workspace-not-found";
import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — vi.hoisted runs before vi.mock hoisting
// ---------------------------------------------------------------------------

const { mockChatStorage, mockValidateMessages } = vi.hoisted(() => ({
  mockChatStorage: {
    getChat: vi.fn<() => Promise<{ ok: boolean; data?: unknown; error?: string }>>(),
    listChats: vi.fn<() => Promise<{ ok: boolean; data?: unknown; error?: string }>>(),
    listChatsByWorkspace: vi.fn<() => Promise<{ ok: boolean; data?: unknown; error?: string }>>(),
    appendMessage: vi.fn<() => Promise<{ ok: boolean; error?: string }>>(),
    updateChatTitle: vi.fn<() => Promise<{ ok: boolean; data?: unknown; error?: string }>>(),
    deleteChat: vi.fn<() => Promise<{ ok: boolean; error?: string }>>(),
  },
  mockValidateMessages: vi
    .fn<(msgs: unknown[]) => Promise<unknown[]>>()
    .mockImplementation((msgs: unknown[]) => Promise.resolve(msgs)),
}));

vi.mock("@atlas/core/credentials", () => ({
  extractTempestUserId: vi.fn().mockReturnValue("user-123"),
}));

vi.mock("@atlas/core/chat/storage", () => ({ ChatStorage: mockChatStorage }));

vi.mock("@atlas/core/users/storage", () => ({
  UserStorage: { getCachedLocalUserId: () => "test-local-user" },
}));

vi.mock("@atlas/agent-sdk", () => ({ validateAtlasUIMessages: mockValidateMessages }));

import chatRoutes from "./chat.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type JsonBody = Record<string, unknown>;

function createTestApp(
  options: { streamRegistry?: Record<string, unknown>; chatSdkMissing?: boolean } = {},
) {
  const { chatSdkMissing = false } = options;

  const mockStreamRegistry = {
    createStream: vi.fn().mockReturnValue({ chatId: "test", events: [], active: true }),
    getStream: vi.fn().mockReturnValue(undefined),
    appendEvent: vi.fn(),
    subscribe: vi.fn().mockReturnValue(false),
    unsubscribe: vi.fn(),
    finishStream: vi.fn(),
    ...options.streamRegistry,
  };

  const mockWebhooksAtlas = vi
    .fn<(request: Request) => Promise<Response>>()
    .mockResolvedValue(
      new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } }),
    );

  const mockChatSdkInstance = {
    chat: { webhooks: { atlas: mockWebhooksAtlas } },
    teardown: vi.fn(),
  };

  const getOrCreateChatSdkInstance = chatSdkMissing
    ? vi.fn().mockRejectedValue(new WorkspaceNotFoundError("ws-missing"))
    : vi.fn().mockResolvedValue(mockChatSdkInstance);

  const mockWorkspaceManager = { find: vi.fn().mockResolvedValue({ id: "user", name: "User" }) };

  const mockContext = {
    runtimes: new Map(),
    startTime: Date.now(),
    getWorkspaceManager: vi.fn().mockReturnValue(mockWorkspaceManager),
    getOrCreateWorkspaceRuntime: vi.fn(),
    getOrCreateChatSdkInstance,
    evictChatSdkInstance: vi.fn(),
    resetIdleTimeout: vi.fn(),
    getWorkspaceRuntime: vi.fn(),
    destroyWorkspaceRuntime: vi.fn(),
    getAgentRegistry: vi.fn(),
    daemon: {},
    streamRegistry: mockStreamRegistry,
    chatTurnRegistry: { replace: vi.fn(), abort: vi.fn(), get: vi.fn() },
    sessionStreamRegistry: {},
    sessionHistoryAdapter: {},
  };

  const app = new Hono<{ Variables: { app: typeof mockContext } }>();
  app.use("*", async (c, next) => {
    c.set("app", mockContext);
    await next();
  });
  app.route("/api/chat", chatRoutes);

  return { app, mockContext, mockStreamRegistry, mockWebhooksAtlas, getOrCreateChatSdkInstance };
}

function post(app: ReturnType<typeof createTestApp>["app"], path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patch(app: ReturnType<typeof createTestApp>["app"], path: string, body: unknown) {
  return app.request(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function del(app: ReturnType<typeof createTestApp>["app"], path: string) {
  return app.request(path, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockChatStorage.getChat.mockReset();
  mockChatStorage.listChats.mockReset();
  mockChatStorage.listChatsByWorkspace.mockReset();
  mockChatStorage.appendMessage.mockReset();
  mockChatStorage.updateChatTitle.mockReset();
  mockChatStorage.deleteChat.mockReset();
  mockValidateMessages.mockReset();
  mockValidateMessages.mockImplementation((msgs: unknown[]) => Promise.resolve(msgs));
});

// ---- POST /api/chat — delegates to user workspace Chat SDK ----------

describe("POST /api/chat — delegates to user workspace Chat SDK", () => {
  test("returns SSE stream via Chat SDK delegation", async () => {
    const { app, mockWebhooksAtlas, getOrCreateChatSdkInstance } = createTestApp();

    const res = await post(app, "/api/chat", {
      id: "chat-1",
      message: { role: "user", parts: [{ type: "text", text: "hello" }] },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(getOrCreateChatSdkInstance).toHaveBeenCalledWith("user");
    expect(mockWebhooksAtlas).toHaveBeenCalledTimes(1);
  });

  test("returns 404 when user workspace not found", async () => {
    const { app } = createTestApp({ chatSdkMissing: true });

    const res = await post(app, "/api/chat", {
      id: "chat-1",
      message: { role: "user", parts: [{ type: "text", text: "hello" }] },
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as JsonBody;
    expect(body.error).toBe("Workspace not found");
  });
});

// ---- GET /api/chat/:chatId — resolveChat with legacy fallback -------

describe("GET /api/chat/:chatId — resolveChat with legacy fallback", () => {
  test("returns chat from user workspace path", async () => {
    const chatData = {
      id: "chat-new",
      workspaceId: "user",
      userId: "user-123",
      title: "New Chat",
      messages: [{ role: "user", content: "hi" }],
      createdAt: "2026-04-15T00:00:00Z",
      updatedAt: "2026-04-15T00:00:00Z",
    };
    mockChatStorage.getChat.mockResolvedValueOnce({ ok: true, data: chatData });
    const { app } = createTestApp();

    const res = await app.request("/api/chat/chat-new");

    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonBody;
    expect(body).toHaveProperty("chat");
    expect(body).toHaveProperty("messages");
    expect(mockChatStorage.getChat).toHaveBeenCalledWith("chat-new", "user");
  });

  test("falls back to global path for legacy chat", async () => {
    const legacyChat = {
      id: "chat-legacy",
      workspaceId: "friday-conversation",
      userId: "user-123",
      title: "Legacy Chat",
      messages: [{ role: "user", content: "old" }],
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    mockChatStorage.getChat
      .mockResolvedValueOnce({ ok: true, data: null })
      .mockResolvedValueOnce({ ok: true, data: legacyChat });
    const { app } = createTestApp();

    const res = await app.request("/api/chat/chat-legacy");

    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonBody;
    expect(body).toHaveProperty("chat");
    expect(mockChatStorage.getChat).toHaveBeenCalledTimes(2);
    expect(mockChatStorage.getChat).toHaveBeenNthCalledWith(1, "chat-legacy", "user");
    expect(mockChatStorage.getChat).toHaveBeenNthCalledWith(2, "chat-legacy");
  });

  test("returns 404 when chat not found in either path", async () => {
    mockChatStorage.getChat
      .mockResolvedValueOnce({ ok: true, data: null })
      .mockResolvedValueOnce({ ok: true, data: null });
    const { app } = createTestApp();

    const res = await app.request("/api/chat/nonexistent");

    expect(res.status).toBe(404);
    const body = (await res.json()) as JsonBody;
    expect(body.error).toBe("Chat not found");
  });
});

// ---- GET /api/chat — list merges and deduplicates -------------------

describe("GET /api/chat — list merges and deduplicates", () => {
  test("merges user workspace and legacy global chats, deduplicates by ID, sorts by updatedAt desc", async () => {
    const workspaceChats = {
      chats: [
        { id: "chat-1", updatedAt: "2026-04-15T10:00:00Z" },
        { id: "chat-2", updatedAt: "2026-04-15T08:00:00Z" },
      ],
      nextCursor: null,
      hasMore: false,
    };
    const globalChats = {
      chats: [
        { id: "chat-2", updatedAt: "2026-04-14T00:00:00Z" },
        { id: "chat-3", updatedAt: "2026-04-15T09:00:00Z" },
      ],
      nextCursor: null,
      hasMore: false,
    };

    mockChatStorage.listChatsByWorkspace.mockResolvedValue({ ok: true, data: workspaceChats });
    mockChatStorage.listChats.mockResolvedValue({ ok: true, data: globalChats });
    const { app } = createTestApp();

    const res = await app.request("/api/chat");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { chats: Array<{ id: string; updatedAt: string }> };
    expect(body.chats).toHaveLength(3);
    const ids = body.chats.map((c) => c.id);
    expect(ids).toEqual(["chat-1", "chat-3", "chat-2"]);
  });

  test("returns 500 when both sources fail", async () => {
    mockChatStorage.listChatsByWorkspace.mockResolvedValue({ ok: false, error: "disk error" });
    mockChatStorage.listChats.mockResolvedValue({ ok: false, error: "disk error" });
    const { app } = createTestApp();

    const res = await app.request("/api/chat");

    expect(res.status).toBe(500);
  });

  test("returns only workspace chats when global fails", async () => {
    mockChatStorage.listChatsByWorkspace.mockResolvedValue({
      ok: true,
      data: {
        chats: [{ id: "ws-only", updatedAt: "2026-04-15T00:00:00Z" }],
        nextCursor: null,
        hasMore: false,
      },
    });
    mockChatStorage.listChats.mockResolvedValue({ ok: false, error: "disk error" });
    const { app } = createTestApp();

    const res = await app.request("/api/chat");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { chats: Array<{ id: string }> };
    expect(body.chats).toHaveLength(1);
    const ids = body.chats.map((c) => c.id);
    expect(ids).toEqual(["ws-only"]);
  });
});

// ---- PATCH /api/chat/:chatId/title — legacy fallback ----------------

describe("PATCH /api/chat/:chatId/title — legacy fallback", () => {
  test("updates title in user workspace", async () => {
    mockChatStorage.updateChatTitle.mockResolvedValue({
      ok: true,
      data: { id: "chat-1", title: "New" },
    });
    const { app } = createTestApp();

    const res = await patch(app, "/api/chat/chat-1/title", { title: "New" });

    expect(res.status).toBe(200);
    expect(mockChatStorage.updateChatTitle).toHaveBeenCalledWith("chat-1", "New", "user");
  });

  test("falls back to global path for legacy chat", async () => {
    mockChatStorage.updateChatTitle
      .mockResolvedValueOnce({ ok: false, error: "Chat not found" })
      .mockResolvedValueOnce({ ok: true, data: { id: "chat-old", title: "Updated" } });
    const { app } = createTestApp();

    const res = await patch(app, "/api/chat/chat-old/title", { title: "Updated" });

    expect(res.status).toBe(200);
    expect(mockChatStorage.updateChatTitle).toHaveBeenCalledTimes(2);
    expect(mockChatStorage.updateChatTitle).toHaveBeenNthCalledWith(
      1,
      "chat-old",
      "Updated",
      "user",
    );
    expect(mockChatStorage.updateChatTitle).toHaveBeenNthCalledWith(2, "chat-old", "Updated");
  });

  test("returns 404 when not found in either path", async () => {
    mockChatStorage.updateChatTitle
      .mockResolvedValueOnce({ ok: false, error: "Chat not found" })
      .mockResolvedValueOnce({ ok: false, error: "Chat not found" });
    const { app } = createTestApp();

    const res = await patch(app, "/api/chat/nope/title", { title: "X" });

    expect(res.status).toBe(404);
  });
});

// ---- DELETE /api/chat/:chatId — legacy fallback ---------------------

describe("DELETE /api/chat/:chatId — legacy fallback", () => {
  test("deletes from user workspace", async () => {
    mockChatStorage.deleteChat.mockResolvedValue({ ok: true });
    const { app } = createTestApp();

    const res = await del(app, "/api/chat/chat-1");

    expect(res.status).toBe(200);
    expect(mockChatStorage.deleteChat).toHaveBeenCalledWith("chat-1", "user");
  });

  test("falls back to global path for legacy chat", async () => {
    mockChatStorage.deleteChat
      .mockResolvedValueOnce({ ok: false, error: "Chat not found" })
      .mockResolvedValueOnce({ ok: true });
    const { app } = createTestApp();

    const res = await del(app, "/api/chat/chat-legacy");

    expect(res.status).toBe(200);
    expect(mockChatStorage.deleteChat).toHaveBeenCalledTimes(2);
    expect(mockChatStorage.deleteChat).toHaveBeenNthCalledWith(1, "chat-legacy", "user");
    expect(mockChatStorage.deleteChat).toHaveBeenNthCalledWith(2, "chat-legacy");
  });

  test("returns 404 when not found in either path", async () => {
    mockChatStorage.deleteChat
      .mockResolvedValueOnce({ ok: false, error: "Chat not found" })
      .mockResolvedValueOnce({ ok: false, error: "Chat not found" });
    const { app } = createTestApp();

    const res = await del(app, "/api/chat/nope");

    expect(res.status).toBe(404);
  });
});

// ---- Grep audit: conversation-stream quarantine ---------------------

describe("conversation-stream quarantine audit", () => {
  test("conversation-stream does NOT appear in apps/atlasd/routes/chat.ts", async () => {
    const { readFile } = await import("node:fs/promises");
    const chatRouteSource = await readFile(new URL("./chat.ts", import.meta.url), "utf-8");
    expect(chatRouteSource).not.toContain("conversation-stream");
  });
});

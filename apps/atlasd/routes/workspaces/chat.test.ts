/**
 * Integration tests for workspace chat routes.
 *
 * Tests HTTP-level behavior: request validation, response shapes, status codes.
 * Mocks ChatStorage and StreamRegistry to isolate route logic from I/O.
 */

import { WorkspaceNotFoundError } from "@atlas/core/errors/workspace-not-found";
import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";

// No AppContext import needed — test mock uses typeof inference

// ---------------------------------------------------------------------------
// Module mocks — vi.hoisted runs before vi.mock hoisting
// ---------------------------------------------------------------------------

const { mockChatStorage, mockValidateMessages } = vi.hoisted(() => ({
  mockChatStorage: {
    createChat: vi.fn<() => Promise<{ ok: boolean; data?: unknown; error?: string }>>(),
    listChatsByWorkspace: vi.fn<() => Promise<{ ok: boolean; data?: unknown; error?: string }>>(),
    getChat: vi.fn<() => Promise<{ ok: boolean; data?: unknown; error?: string }>>(),
    appendMessage: vi.fn<() => Promise<{ ok: boolean; error?: string }>>(),
    updateChatTitle: vi.fn<() => Promise<{ ok: boolean; data?: unknown; error?: string }>>(),
  },
  mockValidateMessages: vi
    .fn<(msgs: unknown[]) => Promise<unknown[]>>()
    .mockImplementation((msgs: unknown[]) => Promise.resolve(msgs)),
}));

vi.mock("@atlas/analytics", () => ({
  createAnalyticsClient: () => ({ emit: vi.fn(), track: vi.fn(), flush: vi.fn() }),
  EventNames: { CONVERSATION_STARTED: "conversation.started" },
}));

vi.mock("@atlas/core/credentials", () => ({
  extractTempestUserId: vi.fn().mockReturnValue("user-123"),
}));

vi.mock("@atlas/core/chat/storage", () => ({ ChatStorage: mockChatStorage }));

vi.mock("@atlas/agent-sdk", () => ({ validateAtlasUIMessages: mockValidateMessages }));

// Import the routes after mocks are set up
import workspaceChatRoutes from "./chat.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type JsonBody = Record<string, unknown>;

function createTestApp(
  options: {
    streamRegistry?: Record<string, unknown>;
    runtimeError?: Error | null;
    runtimeMissing?: boolean;
    workspaceExists?: boolean;
  } = {},
) {
  const { runtimeError = null, runtimeMissing = false, workspaceExists = true } = options;

  const mockStreamRegistry = {
    createStream: vi.fn().mockReturnValue({ chatId: "test", events: [], active: true }),
    getStream: vi.fn().mockReturnValue(undefined),
    appendEvent: vi.fn(),
    subscribe: vi.fn().mockReturnValue(false),
    unsubscribe: vi.fn(),
    finishStream: vi.fn(),
    ...options.streamRegistry,
  };

  const mockRuntime = {
    triggerSignalWithSession: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };

  const getOrCreateWorkspaceRuntime = runtimeMissing
    ? vi.fn().mockRejectedValue(new WorkspaceNotFoundError("ws-missing"))
    : runtimeError
      ? vi.fn().mockRejectedValue(runtimeError)
      : vi.fn().mockResolvedValue(mockRuntime);

  const mockWorkspaceManager = {
    find: vi.fn().mockResolvedValue(workspaceExists ? { id: "ws-1", name: "Test" } : null),
  };

  // Build mock context without type annotation — cast once at c.set() boundary
  const mockContext = {
    runtimes: new Map(),
    startTime: Date.now(),
    sseClients: new Map(),
    sseStreams: new Map(),
    getWorkspaceManager: vi.fn().mockReturnValue(mockWorkspaceManager),
    getOrCreateWorkspaceRuntime,
    resetIdleTimeout: vi.fn(),
    getWorkspaceRuntime: vi.fn(),
    destroyWorkspaceRuntime: vi.fn(),
    getLibraryStorage: vi.fn(),
    getAgentRegistry: vi.fn(),
    getLedgerAdapter: vi.fn(),
    getActivityAdapter: vi.fn(),
    daemon: {},
    streamRegistry: mockStreamRegistry,
    sessionStreamRegistry: {},
    sessionHistoryAdapter: {},
  };

  // Use typeof mockContext as the variable type — routes read via their own
  // AppVariables type at compile time, but at runtime get our mock object.
  const app = new Hono<{ Variables: { app: typeof mockContext } }>();
  app.use("*", async (c, next) => {
    c.set("app", mockContext);
    await next();
  });
  // Mount at /:workspaceId/chat to match real mounting pattern
  app.route("/:workspaceId/chat", workspaceChatRoutes);

  return { app, mockContext, mockStreamRegistry, mockRuntime, getOrCreateWorkspaceRuntime };
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

describe("GET /:workspaceId/chat — list chats", () => {
  test("returns chats list on success", async () => {
    const chatList = {
      chats: [{ id: "chat-1", workspaceId: "ws-1", title: "Hello" }],
      nextCursor: null,
      hasMore: false,
    };
    mockChatStorage.listChatsByWorkspace.mockResolvedValue({ ok: true, data: chatList });
    const { app } = createTestApp();

    const res = await app.request("/ws-1/chat");

    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonBody;
    expect(body).toEqual(chatList);
  });

  test("passes limit and cursor query params", async () => {
    mockChatStorage.listChatsByWorkspace.mockResolvedValue({
      ok: true,
      data: { chats: [], nextCursor: null, hasMore: false },
    });
    const { app } = createTestApp();

    await app.request("/ws-1/chat?limit=10&cursor=1709500000000");

    expect(mockChatStorage.listChatsByWorkspace).toHaveBeenCalledWith("ws-1", {
      limit: 10,
      cursor: 1709500000000,
    });
  });

  test("returns 500 when storage fails", async () => {
    mockChatStorage.listChatsByWorkspace.mockResolvedValue({ ok: false, error: "disk error" });
    const { app } = createTestApp();

    const res = await app.request("/ws-1/chat");

    expect(res.status).toBe(500);
    const body = (await res.json()) as JsonBody;
    expect(body).toHaveProperty("error");
  });
});

describe("POST /:workspaceId/chat — create chat", () => {
  test("rejects missing id field", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/ws-1/chat", { message: { role: "user", content: "hi" } });
    expect(res.status).toBe(400);
  });

  test("rejects empty id field", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/ws-1/chat", { id: "", message: { role: "user", content: "hi" } });
    expect(res.status).toBe(400);
  });

  test("returns 400 for invalid message after validation", async () => {
    mockChatStorage.createChat.mockResolvedValue({ ok: true, data: { id: "chat-1" } });
    // validateAtlasUIMessages returns empty array for invalid/undefined message
    mockValidateMessages.mockResolvedValueOnce([]);
    const { app } = createTestApp();

    const res = await post(app, "/ws-1/chat", { id: "chat-1", message: undefined });

    expect(res.status).toBe(400);
    const body = (await res.json()) as JsonBody;
    expect(body.error).toBe("Invalid message format");
  });

  test("returns 500 when chat creation fails", async () => {
    mockChatStorage.createChat.mockResolvedValue({ ok: false, error: "storage failure" });
    const { app } = createTestApp();

    const res = await post(app, "/ws-1/chat", {
      id: "chat-1",
      message: { role: "user", content: "hello" },
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as JsonBody;
    expect(body.error).toBe("Failed to create chat");
  });

  test("returns 500 when message append fails", async () => {
    mockChatStorage.createChat.mockResolvedValue({ ok: true, data: { id: "chat-1" } });
    mockChatStorage.appendMessage.mockResolvedValue({ ok: false, error: "append error" });
    const { app } = createTestApp();

    const res = await post(app, "/ws-1/chat", {
      id: "chat-1",
      message: { role: "user", content: "hello" },
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as JsonBody;
    expect(body.error).toBe("Failed to store message");
  });

  test("returns 404 when workspace not found", async () => {
    mockChatStorage.createChat.mockResolvedValue({ ok: true, data: { id: "chat-1" } });
    mockChatStorage.appendMessage.mockResolvedValue({ ok: true });
    const { app } = createTestApp({ runtimeMissing: true });

    const res = await post(app, "/ws-1/chat", {
      id: "chat-1",
      message: { role: "user", content: "hello" },
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as JsonBody;
    expect(body.error).toBe("Workspace not found");
  });

  test("creates stream and returns SSE response on success", async () => {
    mockChatStorage.createChat.mockResolvedValue({ ok: true, data: { id: "chat-1" } });
    mockChatStorage.appendMessage.mockResolvedValue({ ok: true });
    const { app, mockStreamRegistry } = createTestApp();

    const res = await post(app, "/ws-1/chat", {
      id: "chat-1",
      message: { role: "user", content: "hello" },
    });

    // SSE stream returns 200 with streaming body
    expect(res.status).toBe(200);
    expect(mockStreamRegistry.createStream).toHaveBeenCalledWith("chat-1");
  });
});

describe("GET /:workspaceId/chat/:chatId — get chat", () => {
  test("returns chat data on success", async () => {
    const chatData = {
      id: "chat-1",
      workspaceId: "ws-1",
      userId: "user-123",
      title: "Test Chat",
      messages: [{ role: "user", content: "hello" }],
      systemPromptContext: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    mockChatStorage.getChat.mockResolvedValue({ ok: true, data: chatData });
    const { app } = createTestApp();

    const res = await app.request("/ws-1/chat/chat-1");

    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonBody;
    expect(body).toHaveProperty("chat");
    expect(body).toHaveProperty("messages");
    expect(body.systemPromptContext).toBeNull();
  });

  test("returns 404 for nonexistent chat", async () => {
    mockChatStorage.getChat.mockResolvedValue({ ok: true, data: null });
    const { app } = createTestApp();

    const res = await app.request("/ws-1/chat/nonexistent");

    expect(res.status).toBe(404);
    const body = (await res.json()) as JsonBody;
    expect(body.error).toBe("Chat not found");
  });

  test("returns 404 when storage result is not ok", async () => {
    mockChatStorage.getChat.mockResolvedValue({ ok: false, error: "corrupt data" });
    const { app } = createTestApp();

    const res = await app.request("/ws-1/chat/chat-1");

    expect(res.status).toBe(404);
  });

  test("limits messages to 100", async () => {
    const messages = Array.from({ length: 150 }, (_, i) => ({ role: "user", content: `msg-${i}` }));
    mockChatStorage.getChat.mockResolvedValue({
      ok: true,
      data: {
        id: "chat-1",
        workspaceId: "ws-1",
        userId: "user-123",
        messages,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
    const { app } = createTestApp();

    const res = await app.request("/ws-1/chat/chat-1");

    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonBody;
    const returnedMessages = body.messages as unknown[];
    expect(returnedMessages).toHaveLength(100);
  });
});

describe("GET /:workspaceId/chat/:chatId/stream — SSE stream reconnect", () => {
  test("returns 204 when no active stream", async () => {
    const { app } = createTestApp({
      streamRegistry: { getStream: vi.fn().mockReturnValue(undefined) },
    });

    const res = await app.request("/ws-1/chat/chat-1/stream");

    expect(res.status).toBe(204);
  });

  test("returns 204 when stream is inactive", async () => {
    const { app } = createTestApp({
      streamRegistry: {
        getStream: vi.fn().mockReturnValue({ active: false, createdAt: Date.now() }),
      },
    });

    const res = await app.request("/ws-1/chat/chat-1/stream");

    expect(res.status).toBe(204);
  });

  test("returns SSE response with correct headers when stream is active", async () => {
    const now = Date.now();
    const { app } = createTestApp({
      streamRegistry: {
        getStream: vi.fn().mockReturnValue({ active: true, createdAt: now }),
        subscribe: vi.fn().mockReturnValue(true),
        unsubscribe: vi.fn(),
      },
    });

    const res = await app.request("/ws-1/chat/chat-1/stream");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("X-Turn-Started-At")).toBe(String(now));
  });
});

describe("DELETE /:workspaceId/chat/:chatId/stream — cancel stream", () => {
  test("finishes stream and returns success", async () => {
    const { app, mockStreamRegistry } = createTestApp();

    const res = await del(app, "/ws-1/chat/chat-1/stream");

    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonBody;
    expect(body.success).toBe(true);
    expect(mockStreamRegistry.finishStream).toHaveBeenCalledWith("chat-1");
  });
});

describe("POST /:workspaceId/chat/:chatId/message — append message", () => {
  test("returns 404 for nonexistent chat", async () => {
    mockChatStorage.getChat.mockResolvedValue({ ok: true, data: null });
    const { app } = createTestApp();

    const res = await post(app, "/ws-1/chat/chat-1/message", {
      message: { role: "assistant", content: "hi" },
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as JsonBody;
    expect(body.error).toBe("Chat not found");
  });

  test("returns 400 for invalid message format", async () => {
    mockChatStorage.getChat.mockResolvedValue({ ok: true, data: { id: "chat-1", messages: [] } });

    // Make validateAtlasUIMessages return empty array for invalid message
    mockValidateMessages.mockResolvedValueOnce([]);

    const { app } = createTestApp();

    const res = await post(app, "/ws-1/chat/chat-1/message", { message: { invalid: true } });

    expect(res.status).toBe(400);
    const body = (await res.json()) as JsonBody;
    expect(body.error).toBe("Invalid message format");
  });

  test("appends message and returns success", async () => {
    mockChatStorage.getChat.mockResolvedValue({ ok: true, data: { id: "chat-1", messages: [] } });
    mockChatStorage.appendMessage.mockResolvedValue({ ok: true });
    const { app } = createTestApp();

    const res = await post(app, "/ws-1/chat/chat-1/message", {
      message: { role: "assistant", content: "response" },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonBody;
    expect(body.success).toBe(true);
  });

  test("returns 500 when append fails", async () => {
    mockChatStorage.getChat.mockResolvedValue({ ok: true, data: { id: "chat-1", messages: [] } });
    mockChatStorage.appendMessage.mockResolvedValue({ ok: false, error: "write error" });
    const { app } = createTestApp();

    const res = await post(app, "/ws-1/chat/chat-1/message", {
      message: { role: "assistant", content: "response" },
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as JsonBody;
    expect(body.error).toBe("Failed to append message");
  });

  test("rejects request without message field", async () => {
    const { app } = createTestApp();

    const res = await post(app, "/ws-1/chat/chat-1/message", {});

    expect(res.status).toBe(400);
  });
});

describe("PATCH /:workspaceId/chat/:chatId/title — update chat title", () => {
  test("updates title and returns chat", async () => {
    const updatedChat = { id: "chat-1", title: "New Title" };
    mockChatStorage.updateChatTitle.mockResolvedValue({ ok: true, data: updatedChat });
    const { app } = createTestApp();

    const res = await patch(app, "/ws-1/chat/chat-1/title", { title: "New Title" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonBody;
    expect(body).toEqual({ chat: updatedChat });
    expect(mockChatStorage.updateChatTitle).toHaveBeenCalledWith("chat-1", "New Title", "ws-1");
  });

  test("returns 404 when chat not found", async () => {
    mockChatStorage.updateChatTitle.mockResolvedValue({ ok: false, error: "Chat not found" });
    const { app } = createTestApp();

    const res = await patch(app, "/ws-1/chat/chat-1/title", { title: "New Title" });

    expect(res.status).toBe(404);
    const body = (await res.json()) as JsonBody;
    expect(body.error).toBe("Chat not found");
  });

  test("returns 500 for non-404 storage errors", async () => {
    mockChatStorage.updateChatTitle.mockResolvedValue({ ok: false, error: "disk failure" });
    const { app } = createTestApp();

    const res = await patch(app, "/ws-1/chat/chat-1/title", { title: "New Title" });

    expect(res.status).toBe(500);
    const body = (await res.json()) as JsonBody;
    expect(body.error).toBe("disk failure");
  });

  test("rejects request without title field", async () => {
    const { app } = createTestApp();

    const res = await patch(app, "/ws-1/chat/chat-1/title", {});

    expect(res.status).toBe(400);
  });

  test("rejects non-string title", async () => {
    const { app } = createTestApp();

    const res = await patch(app, "/ws-1/chat/chat-1/title", { title: 123 });

    expect(res.status).toBe(400);
  });
});

describe("workspace existence validation", () => {
  test("GET / returns 404 for non-existent workspace", async () => {
    const { app } = createTestApp({ workspaceExists: false });

    const res = await app.request("/ws-unknown/chat");

    expect(res.status).toBe(404);
    const body = (await res.json()) as JsonBody;
    expect(body.error).toBe("Workspace not found");
  });

  test("GET /:chatId returns 404 for non-existent workspace", async () => {
    const { app } = createTestApp({ workspaceExists: false });

    const res = await app.request("/ws-unknown/chat/chat-1");

    expect(res.status).toBe(404);
    const body = (await res.json()) as JsonBody;
    expect(body.error).toBe("Workspace not found");
  });

  test("GET /:chatId/stream returns 404 for non-existent workspace", async () => {
    const { app } = createTestApp({ workspaceExists: false });

    const res = await app.request("/ws-unknown/chat/chat-1/stream");

    expect(res.status).toBe(404);
    const body = (await res.json()) as JsonBody;
    expect(body.error).toBe("Workspace not found");
  });

  test("DELETE /:chatId/stream returns 404 for non-existent workspace", async () => {
    const { app } = createTestApp({ workspaceExists: false });

    const res = await del(app, "/ws-unknown/chat/chat-1/stream");

    expect(res.status).toBe(404);
    const body = (await res.json()) as JsonBody;
    expect(body.error).toBe("Workspace not found");
  });

  test("POST /:chatId/message returns 404 for non-existent workspace", async () => {
    const { app } = createTestApp({ workspaceExists: false });

    const res = await post(app, "/ws-unknown/chat/chat-1/message", {
      message: { role: "user", content: "hi" },
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as JsonBody;
    expect(body.error).toBe("Workspace not found");
  });

  test("PATCH /:chatId/title returns 404 for non-existent workspace", async () => {
    const { app } = createTestApp({ workspaceExists: false });

    const res = await patch(app, "/ws-unknown/chat/chat-1/title", { title: "New" });

    expect(res.status).toBe(404);
    const body = (await res.json()) as JsonBody;
    expect(body.error).toBe("Workspace not found");
  });
});

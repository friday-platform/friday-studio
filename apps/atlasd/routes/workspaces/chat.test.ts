/**
 * Integration tests for workspace chat routes.
 *
 * Tests HTTP-level behavior: request validation, response shapes, status codes.
 * Mocks ChatStorage and StreamRegistry to isolate route logic from I/O.
 */

import { WorkspaceNotFoundError } from "@atlas/core/errors/workspace-not-found";
import { Hono } from "hono";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// No AppContext import needed — test mock uses typeof inference

// ---------------------------------------------------------------------------
// Module mocks — vi.hoisted runs before vi.mock hoisting
// ---------------------------------------------------------------------------

const { mockChatStorage, mockArtifactStorage, mockValidateMessages } = vi.hoisted(() => ({
  mockChatStorage: {
    listChatsByWorkspace: vi.fn<() => Promise<{ ok: boolean; data?: unknown; error?: string }>>(),
    getChat: vi.fn<() => Promise<{ ok: boolean; data?: unknown; error?: string }>>(),
    appendMessage: vi.fn<() => Promise<{ ok: boolean; error?: string }>>(),
    updateChatTitle: vi.fn<() => Promise<{ ok: boolean; data?: unknown; error?: string }>>(),
  },
  mockArtifactStorage: {
    listByChat:
      vi.fn<
        (input: { chatId: string }) => Promise<{ ok: boolean; data?: unknown; error?: string }>
      >(),
    readBinaryContents:
      vi.fn<(input: { id: string }) => Promise<{ ok: boolean; data?: unknown; error?: string }>>(),
  },
  mockValidateMessages: vi
    .fn<(msgs: unknown[]) => Promise<unknown[]>>()
    .mockImplementation((msgs: unknown[]) => Promise.resolve(msgs)),
}));

vi.mock("@atlas/core/credentials", () => ({
  extractTempestUserId: vi.fn().mockReturnValue("user-123"),
}));

vi.mock("@atlas/core/chat/storage", () => ({ ChatStorage: mockChatStorage }));

vi.mock("@atlas/core/artifacts/server", () => ({ ArtifactStorage: mockArtifactStorage }));

vi.mock("@atlas/agent-sdk", () => ({
  validateAtlasUIMessages: mockValidateMessages,
  normalizeToUIMessages: (message: unknown) => [message],
}));

// Import the routes after mocks are set up
import workspaceChatRoutes from "./chat.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type JsonBody = Record<string, unknown>;

function createTestApp(
  options: {
    streamRegistry?: Record<string, unknown>;
    workspaceExists?: boolean;
    chatSdkMissing?: boolean;
  } = {},
) {
  const { workspaceExists = true, chatSdkMissing = false } = options;

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

  const mockWorkspaceManager = {
    find: vi.fn().mockResolvedValue(workspaceExists ? { id: "ws-1", name: "Test" } : null),
  };

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
  app.route("/:workspaceId/chat", workspaceChatRoutes);

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

// Hoisted mocks share state across tests — reset call history and any
// queued mockResolvedValueOnce values between cases.
beforeEach(() => {
  mockChatStorage.listChatsByWorkspace.mockReset();
  mockChatStorage.getChat.mockReset();
  mockChatStorage.appendMessage.mockReset();
  mockChatStorage.updateChatTitle.mockReset();
  mockArtifactStorage.listByChat.mockReset();
  mockArtifactStorage.readBinaryContents.mockReset();
  mockValidateMessages.mockReset();
  mockValidateMessages.mockImplementation((msgs: unknown[]) => Promise.resolve(msgs));
});

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
});

describe("POST /:workspaceId/chat — create chat (Chat SDK path)", () => {
  // Body validation (missing/empty id) is handled by the adapter's handleWebhook —
  // see atlas-web-adapter.test.ts for those tests.

  test("returns 404 when workspace not found (Chat SDK instance fails)", async () => {
    const { app } = createTestApp({ chatSdkMissing: true });

    const res = await post(app, "/ws-1/chat", {
      id: "chat-1",
      message: { role: "user", parts: [{ type: "text", text: "hello" }] },
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as JsonBody;
    expect(body.error).toBe("Workspace not found");
  });

  test("delegates to chat.webhooks.atlas and returns SSE response", async () => {
    const { app, mockWebhooksAtlas } = createTestApp();

    const res = await post(app, "/ws-1/chat", {
      id: "chat-1",
      message: { role: "user", parts: [{ type: "text", text: "hello" }] },
    });

    // Adapter returns 200 SSE stream
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(mockWebhooksAtlas).toHaveBeenCalledTimes(1);

    // Verify the forwarded Request carries the body and userId header
    const forwarded = mockWebhooksAtlas.mock.calls[0]?.[0] as Request;
    expect(forwarded.headers.get("X-Atlas-User-Id")).toBe("default-user");
    const body = JSON.parse(await forwarded.text()) as Record<string, unknown>;
    expect(body.id).toBe("chat-1");
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
});

describe("GET /:workspaceId/chat/:chatId/stream — SSE stream reconnect", () => {
  test.each([
    { name: "no buffer", buffer: undefined },
    { name: "inactive buffer", buffer: { active: false, createdAt: Date.now() } },
  ])("returns 204 when $name", async ({ buffer }) => {
    const { app } = createTestApp({
      streamRegistry: { getStream: vi.fn().mockReturnValue(buffer) },
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
  });

  test("returns 400 for invalid message format", async () => {
    mockChatStorage.getChat.mockResolvedValue({ ok: true, data: { id: "chat-1", messages: [] } });
    mockValidateMessages.mockResolvedValueOnce([]);
    const { app } = createTestApp();

    const res = await post(app, "/ws-1/chat/chat-1/message", { message: { invalid: true } });

    expect(res.status).toBe(400);
  });

  test("appends user message and returns success", async () => {
    mockChatStorage.getChat.mockResolvedValue({ ok: true, data: { id: "chat-1", messages: [] } });
    mockChatStorage.appendMessage.mockResolvedValue({ ok: true });
    const { app } = createTestApp();

    const res = await post(app, "/ws-1/chat/chat-1/message", {
      message: { role: "user", parts: [{ type: "text", text: "hi" }] },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonBody;
    expect(body.success).toBe(true);
    expect(mockChatStorage.appendMessage).toHaveBeenCalledOnce();
  });

  // Prompt-injection guard: a malicious client could otherwise smuggle a
  // forged "assistant" or "system" turn into chat history, poisoning the
  // next LLM context. Assistant persistence is in-process via ChatStorage.
  test.each(["assistant", "system"])("rejects %s-role messages with 403", async (role) => {
    mockChatStorage.getChat.mockResolvedValue({ ok: true, data: { id: "chat-1", messages: [] } });
    const { app } = createTestApp();

    const res = await post(app, "/ws-1/chat/chat-1/message", {
      message: { role, parts: [{ type: "text", text: "smuggled" }] },
    });

    expect(res.status).toBe(403);
    expect(mockChatStorage.appendMessage).not.toHaveBeenCalled();
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
});

describe("POST /:workspaceId/chat — foreground workspace validation", () => {
  test("passes through to webhook handler with valid foreground_workspace_ids", async () => {
    const { app, mockWebhooksAtlas } = createTestApp();

    const res = await post(app, "/ws-1/chat", {
      id: "chat-fg-1",
      message: { role: "user", parts: [{ type: "text", text: "hello" }] },
      foreground_workspace_ids: ["ws-1"],
    });

    expect(res.status).toBe(200);
    expect(mockWebhooksAtlas).toHaveBeenCalledTimes(1);
  });

  test("returns 400 for nonexistent foreground workspace ID", async () => {
    const { app, mockContext } = createTestApp();
    const manager = mockContext.getWorkspaceManager();
    manager.find.mockImplementation(({ id }: { id: string }) =>
      Promise.resolve(id === "ws-1" ? { id: "ws-1", name: "Test" } : null),
    );

    const res = await post(app, "/ws-1/chat", {
      id: "chat-fg-2",
      message: { role: "user", parts: [{ type: "text", text: "hello" }] },
      foreground_workspace_ids: ["ws-1", "nonexistent-ws"],
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as JsonBody;
    expect(body.error).toBe("Unknown foreground workspace: nonexistent-ws");
  });

  test("succeeds without foreground_workspace_ids (backward compatibility)", async () => {
    const { app, mockWebhooksAtlas } = createTestApp();

    const res = await post(app, "/ws-1/chat", {
      id: "chat-fg-3",
      message: { role: "user", parts: [{ type: "text", text: "hello" }] },
    });

    expect(res.status).toBe(200);
    expect(mockWebhooksAtlas).toHaveBeenCalledTimes(1);
  });
});

// Workspace-not-found middleware is applied at the route group level — one
// hit is enough to verify the 404 short-circuit.
test("workspace-not-found middleware short-circuits with 404", async () => {
  const { app } = createTestApp({ workspaceExists: false });

  const res = await app.request("/ws-unknown/chat");

  expect(res.status).toBe(404);
  const body = (await res.json()) as JsonBody;
  expect(body.error).toBe("Workspace not found");
});

// ---------------------------------------------------------------------------
// GET /:workspaceId/chat/:chatId/export — zip export
// ---------------------------------------------------------------------------

const EXPORT_CHAT_ID = "chat-export-1234567890";

function makeChat(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: EXPORT_CHAT_ID,
    workspaceId: "ws-1",
    userId: "user-123",
    source: "atlas",
    title: "Export Test Chat",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    messages: [{ id: "msg-1", role: "user", parts: [{ type: "text", text: "hello world" }] }],
    ...overrides,
  };
}

function makeArtifactSummary(
  id: string,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id,
    type: "file",
    revision: 1,
    title: `Artifact ${id}`,
    summary: "Test artifact",
    createdAt: "2026-01-01T00:00:00Z",
    workspaceId: "ws-1",
    chatId: EXPORT_CHAT_ID,
    mimeType: "text/plain",
    size: 16,
    originalName: `${id}.txt`,
    ...overrides,
  };
}

async function readZip(res: Response): Promise<JSZip> {
  const buf = new Uint8Array(await res.arrayBuffer());
  // Magic bytes: PK\x03\x04 — local file header for any non-empty zip.
  expect(buf[0]).toBe(0x50);
  expect(buf[1]).toBe(0x4b);
  expect(buf[2]).toBe(0x03);
  expect(buf[3]).toBe(0x04);
  return await JSZip.loadAsync(buf);
}

describe("GET /:workspaceId/chat/:chatId/export — zip export", () => {
  test("happy path: chat with no artifacts returns a zip with proper headers", async () => {
    mockChatStorage.getChat.mockResolvedValueOnce({ ok: true, data: makeChat() });
    mockArtifactStorage.listByChat.mockResolvedValueOnce({ ok: true, data: [] });
    const { app } = createTestApp();

    const res = await app.request(`/ws-1/chat/${EXPORT_CHAT_ID}/export`);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="friday-chat-${EXPORT_CHAT_ID.slice(0, 8)}.zip"`,
    );

    const zip = await readZip(res);
    expect(zip.file("index.html")).not.toBeNull();
    expect(zip.file("chat.json")).not.toBeNull();
    const html = await zip.file("index.html")?.async("string");
    expect(html).toContain("hello world");
  });

  test("with artifacts: zip contains assets/artifacts/<id>/<basename> for each", async () => {
    const a1 = makeArtifactSummary("art-aaaa", { mimeType: "text/plain", originalName: "a.txt" });
    const a2 = makeArtifactSummary("art-bbbb", { mimeType: "text/plain", originalName: "b.txt" });
    mockChatStorage.getChat.mockResolvedValueOnce({ ok: true, data: makeChat() });
    mockArtifactStorage.listByChat.mockResolvedValueOnce({ ok: true, data: [a1, a2] });
    mockArtifactStorage.readBinaryContents.mockImplementation(({ id }: { id: string }) =>
      Promise.resolve({ ok: true, data: new TextEncoder().encode(`bytes-for-${id}`) }),
    );
    const { app } = createTestApp();

    const res = await app.request(`/ws-1/chat/${EXPORT_CHAT_ID}/export`);

    expect(res.status).toBe(200);
    const zip = await readZip(res);
    expect(zip.file("assets/artifacts/art-aaaa/a.txt")).not.toBeNull();
    expect(zip.file("assets/artifacts/art-bbbb/b.txt")).not.toBeNull();
    const a1Bytes = await zip.file("assets/artifacts/art-aaaa/a.txt")?.async("string");
    expect(a1Bytes).toBe("bytes-for-art-aaaa");

    const html = await zip.file("index.html")?.async("string");
    expect(html).toContain("assets/artifacts/art-aaaa/a.txt");
    expect(html).toContain("assets/artifacts/art-bbbb/b.txt");
  });

  test("failed artifact read: missing file in zip, placeholder in HTML, still 200", async () => {
    const ok = makeArtifactSummary("art-ok", { originalName: "ok.txt" });
    const bad = makeArtifactSummary("art-bad", { originalName: "bad.txt" });
    mockChatStorage.getChat.mockResolvedValueOnce({ ok: true, data: makeChat() });
    mockArtifactStorage.listByChat.mockResolvedValueOnce({ ok: true, data: [ok, bad] });
    mockArtifactStorage.readBinaryContents.mockImplementation(({ id }: { id: string }) => {
      if (id === "art-bad") return Promise.resolve({ ok: false, error: "object missing" });
      return Promise.resolve({ ok: true, data: new TextEncoder().encode("good") });
    });
    const { app } = createTestApp();

    const res = await app.request(`/ws-1/chat/${EXPORT_CHAT_ID}/export`);

    expect(res.status).toBe(200);
    const zip = await readZip(res);
    expect(zip.file("assets/artifacts/art-ok/ok.txt")).not.toBeNull();
    expect(zip.file("assets/artifacts/art-bad/bad.txt")).toBeNull();
    const html = await zip.file("index.html")?.async("string");
    expect(html).toContain("[artifact file unavailable]");
  });

  test("missing chat: getChat returns null → 404 JSON error", async () => {
    mockChatStorage.getChat.mockResolvedValueOnce({ ok: true, data: null });
    const { app } = createTestApp();

    const res = await app.request(`/ws-1/chat/${EXPORT_CHAT_ID}/export`);

    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = (await res.json()) as JsonBody;
    expect(body.error).toBe("Chat not found");
  });

  test("storage error: getChat returns err → 500 JSON error", async () => {
    mockChatStorage.getChat.mockResolvedValueOnce({ ok: false, error: "kv unavailable" });
    const { app } = createTestApp();

    const res = await app.request(`/ws-1/chat/${EXPORT_CHAT_ID}/export`);

    expect(res.status).toBe(500);
    const body = (await res.json()) as JsonBody;
    expect(body.error).toBe("kv unavailable");
  });

  test("missing workspace: middleware short-circuits export with 404", async () => {
    const { app } = createTestApp({ workspaceExists: false });

    const res = await app.request(`/ws-missing/chat/${EXPORT_CHAT_ID}/export`);

    expect(res.status).toBe(404);
    const body = (await res.json()) as JsonBody;
    expect(body.error).toBe("Workspace not found");
    // Storage layer should not be touched when workspace is rejected upstream.
    expect(mockChatStorage.getChat).not.toHaveBeenCalled();
  });

  test("artifact migration in progress: list returns 'migrating' err → 503", async () => {
    mockChatStorage.getChat.mockResolvedValueOnce({ ok: true, data: makeChat() });
    mockArtifactStorage.listByChat.mockResolvedValueOnce({
      ok: false,
      error: "Artifacts are migrating, retry in a moment",
    });
    const { app } = createTestApp();

    const res = await app.request(`/ws-1/chat/${EXPORT_CHAT_ID}/export`);

    expect(res.status).toBe(503);
    const body = (await res.json()) as JsonBody;
    expect(body.error).toBe("Chat artifacts are being migrated; try again shortly");
  });

  describe("with fake timers", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    test("timeout: getChat hangs >10s → 503 'Chat too large to export'", async () => {
      // Promise that never resolves — the route's 10s race must fire first.
      mockChatStorage.getChat.mockReturnValueOnce(
        new Promise(() => {
          // intentionally never resolves
        }),
      );
      const { app } = createTestApp();

      const pending = app.request(`/ws-1/chat/${EXPORT_CHAT_ID}/export`);
      // Advance past the 10s export ceiling and let the timeout race resolve.
      await vi.advanceTimersByTimeAsync(10_001);
      const res = await pending;

      expect(res.status).toBe(503);
      const body = (await res.json()) as JsonBody;
      expect(body.error).toBe("Chat too large to export");
    });
  });
});

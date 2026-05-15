/**
 * Integration tests for workspace chat routes.
 *
 * Tests HTTP-level behavior: request validation, response shapes, status codes.
 * Mocks ChatStorage and StreamRegistry to isolate route logic from I/O.
 */

import { WorkspaceNotFoundError } from "@atlas/core/errors/workspace-not-found";
import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";

// No AppContext import needed — test mock uses typeof inference

// ---------------------------------------------------------------------------
// Module mocks — vi.hoisted runs before vi.mock hoisting
// ---------------------------------------------------------------------------

const { mockChatStorage, mockValidateMessages } = vi.hoisted(() => ({
  mockChatStorage: {
    listChatsByWorkspace: vi.fn<() => Promise<{ ok: boolean; data?: unknown; error?: string }>>(),
    getChat:
      vi.fn<
        (
          chatId: string,
          workspaceId?: string,
        ) => Promise<{ ok: boolean; data?: unknown; error?: string }>
      >(),
    appendMessage: vi.fn<() => Promise<{ ok: boolean; error?: string }>>(),
    updateChatTitle: vi.fn<() => Promise<{ ok: boolean; data?: unknown; error?: string }>>(),
  },
  mockValidateMessages: vi
    .fn<(msgs: unknown[]) => Promise<unknown[]>>()
    .mockImplementation((msgs: unknown[]) => Promise.resolve(msgs)),
}));

vi.mock("@atlas/core/chat/storage", () => ({ ChatStorage: mockChatStorage }));

vi.mock("@atlas/core/users/storage", () => ({
  UserStorage: { getCachedLocalUserId: () => "test-local-user" },
}));

vi.mock("@atlas/agent-sdk", () => ({
  validateAtlasUIMessages: mockValidateMessages,
  normalizeToUIMessages: (message: unknown) => [message],
}));

vi.mock("@atlas/core/workspace-members/storage", () => ({
  WorkspaceMemberStorage: {
    get: vi
      .fn()
      .mockImplementation((userId: string, wsId: string) =>
        Promise.resolve({
          ok: true,
          data: { userId, wsId, role: "owner", addedAt: "2026-05-11T00:00:00.000Z" },
        }),
      ),
    listByUser: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    listByWorkspace: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    put: vi.fn().mockResolvedValue({ ok: true, data: null }),
    putIfAbsent: vi.fn().mockResolvedValue({ ok: true, data: null }),
    delete: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
  },
  ensureWorkspaceMembersKVBucket: vi.fn(),
  initWorkspaceMemberStorage: vi.fn(),
  resetWorkspaceMemberStorageForTests: vi.fn(),
}));

// Shrink the byte cap so the cap branch is testable without allocating
// tens of megabytes per assertion. Hoisted so the `vi.mock` factory below
// can reference it. 1 MiB sits well above the ~300 KiB serialised size of
// the 5000-message boundary fixtures (so those tests still 200) but small
// enough that one explicit oversize message can blow past it cheaply.
const { TEST_MAX_FULL_EXPORT_BYTES } = vi.hoisted(() => ({
  TEST_MAX_FULL_EXPORT_BYTES: 1024 * 1024,
}));
vi.mock("./chat-limits.ts", () => ({
  MAX_FULL_EXPORT_MESSAGES: 5000,
  MAX_FULL_EXPORT_BYTES: TEST_MAX_FULL_EXPORT_BYTES,
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
    startTime: Date.now(),
    getWorkspaceManager: vi.fn().mockReturnValue(mockWorkspaceManager),
    getOrCreateChatSdkInstance,
    getAgentRegistry: vi.fn(),
    daemon: {},
    streamRegistry: mockStreamRegistry,
    chatTurnRegistry: { replace: vi.fn(), abort: vi.fn(), get: vi.fn() },
    sessionStreamRegistry: {},
    sessionHistoryAdapter: {},
  };

  const app = new Hono<{ Variables: { app: typeof mockContext; userId?: string } }>();
  app.use("*", async (c, next) => {
    c.set("app", mockContext);
    c.set("userId", "test-local-user");
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
beforeEach(async () => {
  mockChatStorage.listChatsByWorkspace.mockReset();
  mockChatStorage.getChat.mockReset();
  mockChatStorage.appendMessage.mockReset();
  mockChatStorage.updateChatTitle.mockReset();
  mockValidateMessages.mockReset();
  mockValidateMessages.mockImplementation((msgs: unknown[]) => Promise.resolve(msgs));
  // Default chat lookup — covers the routes that now consult
  // ChatStorage to prove a chatId belongs to the path workspace
  // (POST `/` with existing chatId, GET/DELETE `:chatId/stream`).
  // Tests that need a 404 / cross-workspace miss override this with
  // `mockResolvedValue` / `mockResolvedValueOnce`.
  mockChatStorage.getChat.mockResolvedValue({
    ok: true,
    data: { id: "chat-1", workspaceId: "ws-1", messages: [] },
  });
  // Reset the WorkspaceMemberStorage mock back to the permissive
  // default. Individual tests override per-case (see the
  // foreground-cross-tenant case below), and without this reset the
  // override would leak into subsequent tests and 403 routes that
  // were never meant to exercise the gate.
  const { WorkspaceMemberStorage } = await import("@atlas/core/workspace-members/storage");
  vi.mocked(WorkspaceMemberStorage.get).mockImplementation((userId, wsId) =>
    Promise.resolve({
      ok: true,
      data: { userId, wsId, role: "owner" as const, addedAt: "2026-05-11T00:00:00.000Z" },
    }),
  );
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
    expect(forwarded.headers.get("X-Atlas-User-Id")).toBe("test-local-user");
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

  // Regression: github thread ids contain `/` (e.g.
  // `github:org/repo:issue:1`). Hono's `:chatId` matcher only spans a single
  // path segment, so callers must `encodeURIComponent` the id; Hono's param()
  // decodes it back. If a future refactor breaks this round-trip, the
  // workspace-chat agent silently falls back to `messages = []` and posts an
  // empty body that GitHub rejects with 422.
  test.each([
    { name: "slash + colon (github)", chatId: "github:org/repo:issue:1" },
    { name: "multiple slashes", chatId: "ns:a/b/c/d" },
    { name: "URL-fishy chars", chatId: "weird id?with#stuff&more=1" },
  ])("decodes encoded chatId with $name", async ({ chatId }) => {
    mockChatStorage.getChat.mockResolvedValue({
      ok: true,
      data: { id: chatId, workspaceId: "ws-1", messages: [], systemPromptContext: null },
    });
    const { app } = createTestApp();

    const res = await app.request(`/ws-1/chat/${encodeURIComponent(chatId)}`);

    expect(res.status).toBe(200);
    expect(mockChatStorage.getChat).toHaveBeenCalledWith(chatId, "ws-1");
  });

  // ?full controls the route-layer trim. Default behavior keeps the
  // legacy last-100 slice for live UI rehydrate; ?full=true is the
  // export preview path that needs every message.
  describe("?full query parameter", () => {
    function makeMessages(count: number): Array<{ id: string; role: string; content: string }> {
      return Array.from({ length: count }, (_, i) => ({
        id: `msg-${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message ${i}`,
      }));
    }

    function makeChatData(messageCount: number): Record<string, unknown> {
      return {
        id: "chat-1",
        workspaceId: "ws-1",
        userId: "user-123",
        title: "Test Chat",
        messages: makeMessages(messageCount),
        systemPromptContext: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };
    }

    test("absent param trims to last 100 messages", async () => {
      mockChatStorage.getChat.mockResolvedValue({ ok: true, data: makeChatData(150) });
      const { app } = createTestApp();

      const res = await app.request("/ws-1/chat/chat-1");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { messages: Array<{ id: string }> };
      expect(body.messages).toHaveLength(100);
      // Slice keeps the tail — first returned message is index 50.
      expect(body.messages[0]?.id).toBe("msg-50");
      expect(body.messages.at(-1)?.id).toBe("msg-149");
    });

    test("?full=true returns every message without slicing", async () => {
      mockChatStorage.getChat.mockResolvedValue({ ok: true, data: makeChatData(150) });
      const { app } = createTestApp();

      const res = await app.request("/ws-1/chat/chat-1?full=true");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { messages: Array<{ id: string }> };
      expect(body.messages).toHaveLength(150);
      expect(body.messages[0]?.id).toBe("msg-0");
      expect(body.messages.at(-1)?.id).toBe("msg-149");
    });

    test("?full=false trims to last 100 (only literal 'true' opts in)", async () => {
      mockChatStorage.getChat.mockResolvedValue({ ok: true, data: makeChatData(150) });
      const { app } = createTestApp();

      const res = await app.request("/ws-1/chat/chat-1?full=false");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { messages: Array<{ id: string }> };
      expect(body.messages).toHaveLength(100);
    });

    test.each([
      "1",
      "yes",
      "TRUE",
      "",
    ])("?full=%s passes through cleanly and falls back to last-100 trim", async (value) => {
      mockChatStorage.getChat.mockResolvedValue({ ok: true, data: makeChatData(150) });
      const { app } = createTestApp();

      const res = await app.request(`/ws-1/chat/chat-1?full=${value}`);

      expect(res.status).toBe(200);
      const body = (await res.json()) as { messages: Array<{ id: string }> };
      expect(body.messages).toHaveLength(100);
    });

    // `validateAtlasUIMessages` walks every message and sanitises HTML, so
    // an unbounded array on `?full=true` lets a single pathological chat
    // pin the daemon. The cap rejects with 413 *before* we hand the array
    // to the validator. The trimmed view is bounded at 100 so it isn't
    // affected.
    test("?full=true with messages.length > 5000 returns 413 without invoking validator", async () => {
      mockChatStorage.getChat.mockResolvedValue({ ok: true, data: makeChatData(5001) });
      const { app } = createTestApp();

      const res = await app.request("/ws-1/chat/chat-1?full=true");

      expect(res.status).toBe(413);
      const body = (await res.json()) as JsonBody;
      expect(body.error).toBe("Chat too large to export");
      expect(body.messageCount).toBe(5001);
      expect(body.limit).toBe(5000);
      expect(mockValidateMessages).not.toHaveBeenCalled();
    });

    test("?full=true with messages.length === 5000 succeeds at the boundary", async () => {
      mockChatStorage.getChat.mockResolvedValue({ ok: true, data: makeChatData(5000) });
      const { app } = createTestApp();

      const res = await app.request("/ws-1/chat/chat-1?full=true");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { messages: Array<{ id: string }> };
      expect(body.messages).toHaveLength(5000);
      expect(mockValidateMessages).toHaveBeenCalledOnce();
    });

    // The message-count cap bounds validator walk time but not per-message
    // size. Without a byte cap, a 4-message chat with a 200 MB tool output
    // would be sanitised, JSON-stringified, and shipped — pinning RAM on
    // both the daemon and the orchestrator. The byte cap rejects the
    // serialised payload before it leaves the daemon.
    test("?full=true returns 413 when serialised payload exceeds MAX_FULL_EXPORT_BYTES", async () => {
      // Within the 5000-message ceiling, but one message carries a string
      // large enough that JSON-stringifying the whole response exceeds
      // the test-only 1 MiB cap.
      const fat = "x".repeat(TEST_MAX_FULL_EXPORT_BYTES + 1024);
      mockChatStorage.getChat.mockResolvedValue({
        ok: true,
        data: {
          id: "chat-1",
          workspaceId: "ws-1",
          userId: "user-123",
          title: "Test Chat",
          messages: [{ id: "msg-0", role: "user", content: fat }],
          systemPromptContext: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      });
      const { app } = createTestApp();

      const res = await app.request("/ws-1/chat/chat-1?full=true");

      expect(res.status).toBe(413);
      const body = (await res.json()) as JsonBody;
      expect(body.error).toBe("Chat too large to export");
      expect(typeof body.payloadBytes).toBe("number");
      expect(body.payloadBytes).toBeGreaterThan(TEST_MAX_FULL_EXPORT_BYTES);
      expect(body.limit).toBe(TEST_MAX_FULL_EXPORT_BYTES);
    });

    test("default (live UI) path is unaffected by the byte cap", async () => {
      // The trimmed view is bounded at 100 messages and uses `c.json` (not
      // the byte-capped path), so a chat that would be 413 under
      // `?full=true` still serves a normal 200 here.
      const fat = "y".repeat(TEST_MAX_FULL_EXPORT_BYTES + 1024);
      mockChatStorage.getChat.mockResolvedValue({
        ok: true,
        data: {
          id: "chat-1",
          workspaceId: "ws-1",
          userId: "user-123",
          title: "Test Chat",
          messages: [{ id: "msg-0", role: "user", content: fat }],
          systemPromptContext: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      });
      const { app } = createTestApp();

      const res = await app.request("/ws-1/chat/chat-1");

      expect(res.status).toBe(200);
    });
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

  test("returns 410 + X-Stream-Replay-Disabled when buffer is replay-disabled", async () => {
    // A buffer that overflowed MAX_EVENTS flips replayDisabled=true and
    // subscribe() refuses to attach. If we still committed 200 OK + an empty
    // ReadableStream the AI SDK would treat the empty body as a clean finish
    // and silently truncate the assistant message — the client can't tell
    // this apart from a successful resume. 410 + header forces a real error
    // path so the user gets a "reload chat" affordance instead.
    const subscribe = vi.fn().mockReturnValue(false);
    const { app } = createTestApp({
      streamRegistry: {
        getStream: vi
          .fn()
          .mockReturnValue({ active: true, replayDisabled: true, createdAt: Date.now() }),
        subscribe,
        unsubscribe: vi.fn(),
      },
    });

    const res = await app.request("/ws-1/chat/chat-1/stream");

    expect(res.status).toBe(410);
    expect(res.headers.get("X-Stream-Replay-Disabled")).toBe("true");
    expect(subscribe).not.toHaveBeenCalled();
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

  test("forwards Last-Event-ID header to streamRegistry.subscribe as cursor", async () => {
    const subscribe = vi.fn().mockReturnValue(true);
    const { app } = createTestApp({
      streamRegistry: {
        getStream: vi.fn().mockReturnValue({ active: true, createdAt: Date.now() }),
        subscribe,
        unsubscribe: vi.fn(),
      },
    });

    const res = await app.request("/ws-1/chat/chat-1/stream", {
      headers: { "Last-Event-ID": "42" },
    });

    expect(res.status).toBe(200);
    // 4th argument is the parsed integer cursor — anything else lets
    // resume fall back to full replay, which re-sends already-rendered
    // text-deltas and produces duplicate content in the UI. Registry
    // is now keyed by `(workspaceId, chatId)` so they're args 1 and 2.
    expect(subscribe).toHaveBeenCalledWith("ws-1", "chat-1", expect.anything(), 42);
  });

  test.each([
    { header: "abc", reason: "non-numeric" },
    { header: "-1", reason: "negative" },
    {
      header: "1.5",
      reason: "fractional (parseInt truncates so this passes — included as documentation)",
    },
  ])("ignores invalid Last-Event-ID ($reason) — undefined cursor", async ({ header }) => {
    const subscribe = vi.fn().mockReturnValue(true);
    const { app } = createTestApp({
      streamRegistry: {
        getStream: vi.fn().mockReturnValue({ active: true, createdAt: Date.now() }),
        subscribe,
        unsubscribe: vi.fn(),
      },
    });

    await app.request("/ws-1/chat/chat-1/stream", { headers: { "Last-Event-ID": header } });

    // Registry is keyed by `(workspaceId, chatId)`, so the cursor is
    // now the 4th positional argument (was 3rd before re-keying).
    const callArg = subscribe.mock.calls[0]?.[3];
    if (header === "1.5") {
      // parseInt("1.5", 10) === 1 — accepted as a valid non-negative int.
      // This is intentional: any prefix-numeric header is fine; the cursor
      // is clamped server-side and over-/under-shooting is harmless.
      expect(callArg).toBe(1);
    } else {
      expect(callArg).toBeUndefined();
    }
  });
});

describe("DELETE /:workspaceId/chat/:chatId/stream — cancel stream", () => {
  test("finishes stream and returns success", async () => {
    const { app, mockStreamRegistry } = createTestApp();

    const res = await del(app, "/ws-1/chat/chat-1/stream");

    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonBody;
    expect(body.success).toBe(true);
    expect(mockStreamRegistry.finishStream).toHaveBeenCalledWith("ws-1", "chat-1");
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

  // Regression for the foreground-context cross-tenant leak: the path
  // workspace's member check is no longer enough — every
  // `foreground_workspace_ids` entry has to pass requireWorkspaceMember
  // for the caller, otherwise a member of `ws-1` could read `ws-2`'s
  // config / chats by stuffing `ws-2` into the foreground list.
  test("returns 403 when caller is not a member of a foreground workspace", async () => {
    const { WorkspaceMemberStorage } = await import("@atlas/core/workspace-members/storage");
    const memberGet = vi.mocked(WorkspaceMemberStorage.get);
    memberGet.mockImplementation((userId, wsId) =>
      Promise.resolve({
        ok: true,
        data:
          wsId === "ws-1"
            ? { userId, wsId, role: "owner" as const, addedAt: "2026-05-11T00:00:00.000Z" }
            : null,
      }),
    );
    const { app, mockContext } = createTestApp();
    const manager = mockContext.getWorkspaceManager();
    manager.find.mockImplementation(({ id }: { id: string }) =>
      Promise.resolve({ id, name: `ws-${id}` }),
    );

    const res = await post(app, "/ws-1/chat", {
      id: "chat-fg-leak",
      message: { role: "user", parts: [{ type: "text", text: "hello" }] },
      foreground_workspace_ids: ["ws-2"],
    });

    expect(res.status).toBe(403);
  });
});

describe("stream routes — chatId must belong to path workspace", () => {
  // Two layers of defence: the route checks the chat is in the path
  // workspace (404 leak prevention), and the streamRegistry /
  // chatTurnRegistry themselves are keyed by `(workspaceId, chatId)`
  // so a misaddressed call still couldn't reach a foreign workspace's
  // buffer. These tests exercise the route-level gate; the registry
  // unit tests cover the keying.
  test("GET /:chatId/stream returns 404 when chat doesn't exist in this workspace", async () => {
    // Simulate the real storage: `getChat(chatId, "ws-1")` returns
    // null because the chat lives in `ws-OTHER`. The blanket default
    // in `beforeEach` would mask this — override per-test.
    mockChatStorage.getChat.mockImplementation((_chatId: string, workspaceId?: string) =>
      Promise.resolve(
        workspaceId === "ws-OTHER"
          ? { ok: true, data: { id: "chat-x", workspaceId: "ws-OTHER", messages: [] } }
          : { ok: true, data: null },
      ),
    );
    const { app } = createTestApp({
      streamRegistry: {
        getStream: vi.fn().mockReturnValue({ active: true, createdAt: Date.now() }),
      },
    });

    const res = await app.request("/ws-1/chat/chat-x/stream");

    expect(res.status).toBe(404);
  });

  test("DELETE /:chatId/stream returns 404 when chat doesn't exist in this workspace", async () => {
    mockChatStorage.getChat.mockImplementation((_chatId: string, workspaceId?: string) =>
      Promise.resolve(
        workspaceId === "ws-OTHER"
          ? { ok: true, data: { id: "chat-x", workspaceId: "ws-OTHER", messages: [] } }
          : { ok: true, data: null },
      ),
    );
    const { app, mockStreamRegistry } = createTestApp();

    const res = await del(app, "/ws-1/chat/chat-x/stream");

    expect(res.status).toBe(404);
    expect(mockStreamRegistry.finishStream).not.toHaveBeenCalled();
  });

  test("POST / routes the chatTurnRegistry call through the path workspace, not the chat's foreign workspace", async () => {
    // The registry is now keyed by `(workspaceId, chatId)`. Even if a
    // caller smuggles a chatId that exists in another workspace, the
    // call lands at `(ws-1, chatId)` — workspace B's controller at
    // `(ws-B, chatId)` is untouched. The test verifies the route
    // passes the *path* workspaceId to the registry, not anything
    // derived from the body.
    const { app, mockContext } = createTestApp();
    const chatTurnReplace = vi.mocked(mockContext.chatTurnRegistry.replace);

    const res = await post(app, "/ws-1/chat", {
      id: "chat-foreign",
      message: { role: "user", parts: [{ type: "text", text: "hi" }] },
    });

    expect(res.status).toBe(200);
    expect(chatTurnReplace).toHaveBeenCalledWith("ws-1", "chat-foreign");
    // Negative: a foreign workspaceId must never appear in the call.
    for (const call of chatTurnReplace.mock.calls) {
      expect(call[0]).toBe("ws-1");
    }
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

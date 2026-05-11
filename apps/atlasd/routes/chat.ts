import { validateAtlasUIMessages } from "@atlas/agent-sdk";
import { ChatStorage } from "@atlas/core/chat/storage";
import { WorkspaceNotFoundError } from "@atlas/core/errors/workspace-not-found";
import { UserStorage } from "@atlas/core/users/storage";
import { logger } from "@atlas/logger";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { daemonFactory, USER_WORKSPACE_ID } from "../src/factory.ts";
import { requireWorkspaceMember } from "../src/workspace-authz.ts";

const appendMessageSchema = z.object({ message: z.unknown() });
const updateTitleSchema = z.object({ title: z.string() });
const listChatsQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).optional(),
  cursor: z.coerce.number().optional(),
});

/**
 * Resolve a chat by trying the user workspace first, then the global (legacy) path.
 * Returns the chat data or null if not found in either location.
 */
async function resolveChat(chatId: string) {
  const userResult = await ChatStorage.getChat(chatId, USER_WORKSPACE_ID);
  if (userResult.ok && userResult.data) {
    return userResult.data;
  }
  const globalResult = await ChatStorage.getChat(chatId);
  if (globalResult.ok && globalResult.data) {
    return globalResult.data;
  }
  return null;
}

const chatRoutes = daemonFactory
  .createApp()
  // Gate every `/api/chat/*` route on membership of the shared
  // user-workspace (`USER_WORKSPACE_ID = "user"`). Local mode: the
  // first-run bootstrap stamps the local user as owner, so the check
  // is a no-op pass. Cloud mode: today the user-workspace is a single
  // shared "user" key — the gate gives every authenticated caller
  // access (still via membership rows), and the multi-user
  // personal-workspace refactor (per-user wsId) is tracked separately.
  // Either way, an unauthenticated request 401s here.
  .use("*", async (c, next) => {
    await requireWorkspaceMember(c, USER_WORKSPACE_ID);
    await next();
  })
  /**
   * GET /api/chat
   * List recent chats with cursor-based pagination.
   * Merges user workspace chats and legacy global chats.
   */
  .get("/", zValidator("query", listChatsQuerySchema), async (c) => {
    const { limit, cursor } = c.req.valid("query");

    const [workspaceResult, globalResult] = await Promise.all([
      ChatStorage.listChatsByWorkspace(USER_WORKSPACE_ID, { limit, cursor }),
      ChatStorage.listChats({ limit, cursor }),
    ]);

    if (!workspaceResult.ok && !globalResult.ok) {
      return c.json({ error: workspaceResult.error }, 500);
    }

    const workspaceChats = workspaceResult.ok ? workspaceResult.data.chats : [];
    const globalChats = globalResult.ok ? globalResult.data.chats : [];

    const seen = new Set<string>();
    const merged: typeof workspaceChats = [];

    for (const chat of workspaceChats) {
      seen.add(chat.id);
      merged.push(chat);
    }
    for (const chat of globalChats) {
      if (!seen.has(chat.id)) {
        merged.push(chat);
      }
    }

    merged.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    const effectiveLimit = limit ?? 50;
    const chats = merged.slice(0, effectiveLimit);

    return c.json({ chats, nextCursor: null, hasMore: merged.length > effectiveLimit }, 200);
  })

  /**
   * POST /api/chat
   * Delegate to the user workspace's Chat SDK instance.
   * The Chat SDK handles validation, persistence, signal trigger, and SSE streaming.
   */
  .post("/", async (c) => {
    const ctx = c.get("app");

    const instance = await ctx
      .getOrCreateChatSdkInstance(USER_WORKSPACE_ID)
      .catch((error: unknown) => {
        if (error instanceof WorkspaceNotFoundError) return null;
        throw error;
      });
    if (!instance) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const handler = instance.chat.webhooks.atlas;
    if (!handler) {
      return c.json({ error: "Atlas web adapter not configured" }, 500);
    }

    const headers = new Headers(c.req.raw.headers);
    headers.set("X-Atlas-User-Id", c.get("userId") ?? UserStorage.getCachedLocalUserId());
    const request = new Request(c.req.raw, { headers });
    return handler(request);
  })

  /**
   * DELETE /api/chat/:chatId/stream
   * Mark a stream as finished (cosmetic stop).
   *
   * The agent continues running in the background, but the client stops
   * receiving events and the UI shows the conversation as complete.
   * Idempotent - safe to call multiple times.
   */
  .delete("/:chatId/stream", (c) => {
    const ctx = c.get("app");
    const chatId = c.req.param("chatId");

    ctx.streamRegistry.finishStream(chatId);

    return c.json({ success: true }, 200);
  })

  /**
   * GET /api/chat/:chatId/stream
   * Reconnect to an active chat stream for resumption.
   *
   * Returns 200 with SSE stream if active, replaying buffered events.
   * Returns 204 if stream doesn't exist or is finished.
   */
  .get("/:chatId/stream", (c) => {
    const ctx = c.get("app");
    const chatId = c.req.param("chatId");

    const buffer = ctx.streamRegistry.getStream(chatId);

    // No active stream — return 204 so AI SDK's resumeStream() sets status to "ready".
    // We intentionally don't replay finished buffers here: the AI SDK creates a new
    // message on resumeStream(), so full replay causes duplicate messages in the UI.
    // Late reconnectors get eventual consistency via page reload (messages persisted to DB).
    // TODO: Add Last-Event-Id / offset-based replay to eliminate the data gap.
    if (!buffer?.active) {
      return c.body(null, 204);
    }

    // Set header for client-side timer synchronization
    c.header("X-Turn-Started-At", String(buffer.createdAt));

    // Return SSE stream with replay + live events
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const subscribed = ctx.streamRegistry.subscribe(chatId, controller);
        if (!subscribed) {
          controller.close();
          return;
        }

        c.req.raw.signal.addEventListener("abort", () => {
          ctx.streamRegistry.unsubscribe(chatId, controller);
        });
      },
    });

    return c.body(stream, 200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
  })

  /**
   * GET /api/chat/:chatId
   * Retrieve chat metadata and message history.
   * Falls back to global (legacy) path if not found in user workspace.
   */
  .get("/:chatId", async (c) => {
    const chatId = c.req.param("chatId");

    const chat = await resolveChat(chatId);
    if (!chat) {
      return c.json({ error: "Chat not found" }, 404);
    }
    // The middleware verified membership of USER_WORKSPACE_ID; gate
    // the actual chat workspace too, otherwise a legacy chat in a
    // different workspace is readable to anyone with USER_WORKSPACE_ID
    // membership.
    await requireWorkspaceMember(c, chat.workspaceId);

    const { messages, systemPromptContext, ...metadata } = chat;
    // Return last 100 messages in chronological order (oldest first)
    const limitedMessages = messages.slice(-100);

    return c.json(
      {
        chat: metadata,
        messages: limitedMessages,
        systemPromptContext: systemPromptContext ?? null,
      },
      200,
    );
  })

  /**
   * POST /api/chat/:chatId/message
   * Append a user message to chat history.
   *
   * Only user-role messages are accepted. Assistant and system messages are
   * produced server-side by agents, which persist them in-process via
   * ChatStorage. Allowing client-supplied roles here would let any caller
   * poison the next LLM turn (prompt injection).
   */
  .post("/:chatId/message", zValidator("json", appendMessageSchema), async (c) => {
    const chatId = c.req.param("chatId");
    const { message } = c.req.valid("json");

    const chat = await resolveChat(chatId);
    if (!chat) {
      return c.json({ error: "Chat not found" }, 404);
    }
    await requireWorkspaceMember(c, chat.workspaceId);

    // Validate the message format
    const [validatedMessage] = await validateAtlasUIMessages([message]);
    if (!validatedMessage) {
      return c.json({ error: "Invalid message format" }, 400);
    }
    if (validatedMessage.role !== "user") {
      return c.json({ error: "Only user-role messages may be appended" }, 403);
    }

    // Append the user message (use workspace ID from chat metadata for correct file path)
    const appendResult = await ChatStorage.appendMessage(
      chatId,
      validatedMessage,
      chat.workspaceId,
    );
    if (!appendResult.ok) {
      logger.error("Failed to append message", { chatId, error: appendResult.error });
      return c.json({ error: "Failed to append message" }, 500);
    }

    return c.json({ success: true }, 200);
  })

  /**
   * PATCH /api/chat/:chatId/title
   * Update chat title. Falls back to global path for legacy chats.
   */
  .patch("/:chatId/title", zValidator("json", updateTitleSchema), async (c) => {
    const chatId = c.req.param("chatId");
    const { title } = c.req.valid("json");

    // Resolve first so we can authz-check against the chat's actual
    // workspaceId; legacy global chats may belong to a workspace the
    // caller isn't a member of even when they're a member of
    // USER_WORKSPACE_ID.
    const chat = await resolveChat(chatId);
    if (!chat) {
      return c.json({ error: "Chat not found" }, 404);
    }
    await requireWorkspaceMember(c, chat.workspaceId);

    const result = await ChatStorage.updateChatTitle(chatId, title, chat.workspaceId);
    if (result.ok) {
      return c.json({ chat: result.data }, 200);
    }
    return c.json({ error: result.error }, result.error === "Chat not found" ? 404 : 500);
  })

  /**
   * DELETE /api/chat/:chatId
   * Delete a chat. Falls back to global path for legacy chats.
   */
  .delete("/:chatId", async (c) => {
    const chatId = c.req.param("chatId");

    const chat = await resolveChat(chatId);
    if (!chat) {
      return c.json({ error: "Chat not found" }, 404);
    }
    await requireWorkspaceMember(c, chat.workspaceId);

    const result = await ChatStorage.deleteChat(chatId, chat.workspaceId);
    if (result.ok) {
      return c.json({ success: true }, 200);
    }
    return c.json({ error: result.error }, result.error === "Chat not found" ? 404 : 500);
  });

export default chatRoutes;
export type ChatRoutes = typeof chatRoutes;

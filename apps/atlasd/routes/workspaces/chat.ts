/**
 * Workspace chat routes.
 *
 * POST /                 — Create chat, stream response via Chat SDK
 * GET  /                 — List workspace chats
 * GET  /:chatId          — Get workspace chat
 * GET  /:chatId/stream   — Resume SSE stream
 * DELETE /:chatId/stream — Stop stream (cosmetic)
 */

import process from "node:process";
import { normalizeToUIMessages, validateAtlasUIMessages } from "@atlas/agent-sdk";
import { ChatStorage } from "@atlas/core/chat/storage";
import { extractTempestUserId } from "@atlas/core/credentials";
import { WorkspaceNotFoundError } from "@atlas/core/errors/workspace-not-found";
import { UserStorage } from "@atlas/core/users/storage";
import { logger } from "@atlas/logger";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { daemonFactory } from "../../src/factory.ts";

const listChatsQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).optional(),
  cursor: z.coerce.number().optional(),
});

/**
 * Extract userId from FRIDAY_KEY JWT.
 * Falls back to the daemon's resolved local-tenant user id (a nanoid
 * generated on first daemon start, cached after `resolveLocalUserId()`
 * runs in atlas-daemon.ts startup).
 */
function getUserId(): string {
  const atlasKey = process.env.FRIDAY_KEY;
  return (atlasKey && extractTempestUserId(atlasKey)) || UserStorage.getCachedLocalUserId();
}

const workspaceChatRoutes = daemonFactory
  .createApp()
  .use("*", async (c, next) => {
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) {
      return c.json({ error: "Missing workspaceId" }, 400);
    }
    const ctx = c.get("app");
    const manager = ctx.getWorkspaceManager();
    const workspace = await manager.find({ id: workspaceId });
    if (!workspace) {
      return c.json({ error: "Workspace not found" }, 404);
    }
    await next();
  })
  .get("/", zValidator("query", listChatsQuerySchema), async (c) => {
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) {
      return c.json({ error: "Missing workspaceId" }, 400);
    }

    const { limit, cursor } = c.req.valid("query");
    const result = await ChatStorage.listChatsByWorkspace(workspaceId, { limit, cursor });
    if (!result.ok) {
      return c.json({ error: result.error }, 500);
    }

    return c.json(result.data, 200);
  })

  /**
   * Forwards the raw request to `chat.webhooks.atlas()`, which handles
   * validation, persistence, signal trigger, and SSE streaming.
   */
  .post("/", async (c) => {
    const ctx = c.get("app");
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) {
      return c.json({ error: "Missing workspaceId" }, 400);
    }

    const body: unknown = await c.req.raw
      .clone()
      .json()
      .catch(() => null);
    const rawFgIds =
      typeof body === "object" && body !== null && "foreground_workspace_ids" in body
        ? body.foreground_workspace_ids
        : undefined;
    const foregroundIds = Array.isArray(rawFgIds)
      ? rawFgIds.filter((id: unknown): id is string => typeof id === "string")
      : [];
    if (foregroundIds.length > 0) {
      const manager = ctx.getWorkspaceManager();
      for (const fgId of foregroundIds) {
        const found = await manager.find({ id: fgId });
        if (!found) {
          return c.json({ error: `Unknown foreground workspace: ${fgId}` }, 400);
        }
      }
    }

    // Read chatId from the request body so we can register an AbortController
    // for this turn BEFORE forwarding to the adapter. A new POST with the same
    // chatId aborts any in-flight controller — the FSM engine and AI SDK
    // observe the signal and stop the prior turn so two assistant runs don't
    // race in the same chat. The adapter retrieves the controller from the
    // registry by chatId in `handleWebhook`.
    const chatId =
      typeof body === "object" && body !== null && "id" in body && typeof body.id === "string"
        ? body.id
        : undefined;
    if (chatId) {
      ctx.chatTurnRegistry.replace(chatId);
    }

    const instance = await ctx.getOrCreateChatSdkInstance(workspaceId).catch((error: unknown) => {
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

    // Clone and set userId header — adapter reads it for message attribution.
    // `set` replaces any client-supplied value so a malicious client can't
    // smuggle their own identity into analytics/audit logs.
    const headers = new Headers(c.req.raw.headers);
    headers.set("X-Atlas-User-Id", getUserId());
    const request = new Request(c.req.raw, { headers });
    return handler(request);
  })

  .delete("/:chatId/stream", (c) => {
    const ctx = c.get("app");
    const chatId = c.req.param("chatId");

    // Abort the in-flight FSM/model call AND close the SSE buffer. Without
    // the abort, finishStream only stops new events from being broadcast —
    // the agent run continues server-side and may produce a partial message
    // that gets persisted after the client thought it cancelled.
    ctx.chatTurnRegistry.abort(chatId);
    ctx.streamRegistry.finishStream(chatId);

    return c.json({ success: true }, 200);
  })

  .get("/:chatId/stream", (c) => {
    const ctx = c.get("app");
    const chatId = c.req.param("chatId");

    const buffer = ctx.streamRegistry.getStream(chatId);

    if (!buffer?.active) {
      return c.body(null, 204);
    }

    c.header("X-Turn-Started-At", String(buffer.createdAt));

    const readableStream = new ReadableStream<Uint8Array>({
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

    return c.body(readableStream, 200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
  })

  .get("/:chatId", async (c) => {
    const chatId = c.req.param("chatId");
    const workspaceId = c.req.param("workspaceId");

    const chatResult = await ChatStorage.getChat(chatId, workspaceId);
    if (!chatResult.ok || !chatResult.data) {
      return c.json({ error: "Chat not found" }, 404);
    }

    const { messages, systemPromptContext, ...chat } = chatResult.data;
    const limitedMessages = messages.slice(-100);
    const sanitized = await validateAtlasUIMessages(limitedMessages);

    return c.json(
      { chat, messages: sanitized, systemPromptContext: systemPromptContext ?? null },
      200,
    );
  })

  .delete("/:chatId", async (c) => {
    const chatId = c.req.param("chatId");
    const workspaceId = c.req.param("workspaceId");

    const result = await ChatStorage.deleteChat(chatId, workspaceId);
    if (!result.ok) {
      const status = result.error === "Chat not found" ? 404 : 500;
      return c.json({ error: result.error }, status);
    }
    return c.body(null, 204);
  })

  .post(
    "/:chatId/message",
    zValidator(
      "json",
      z.object({
        message: z.union([
          z.string(),
          z.record(z.string(), z.unknown()),
          z.array(z.record(z.string(), z.unknown())),
        ]),
      }),
    ),
    async (c) => {
      const chatId = c.req.param("chatId");
      const workspaceId = c.req.param("workspaceId");
      const { message } = c.req.valid("json");

      const chatResult = await ChatStorage.getChat(chatId, workspaceId);
      if (!chatResult.ok || !chatResult.data) {
        return c.json({ error: "Chat not found" }, 404);
      }

      const [validatedMessage] = await validateAtlasUIMessages(normalizeToUIMessages(message));
      if (!validatedMessage) {
        return c.json({ error: "Invalid message format" }, 400);
      }
      // Only user-role messages may be appended through this endpoint. Assistant
      // and system messages are produced server-side by agents, which persist
      // them in-process via ChatStorage. Allowing client-supplied roles here
      // would let any caller poison the next LLM turn (prompt injection).
      if (validatedMessage.role !== "user") {
        return c.json({ error: "Only user-role messages may be appended" }, 403);
      }

      const appendResult = await ChatStorage.appendMessage(chatId, validatedMessage, workspaceId);
      if (!appendResult.ok) {
        logger.error("Failed to append message", { chatId, error: appendResult.error });
        return c.json({ error: "Failed to append message" }, 500);
      }

      return c.json({ success: true }, 200);
    },
  )

  .patch("/:chatId/title", zValidator("json", z.object({ title: z.string() })), async (c) => {
    const chatId = c.req.param("chatId");
    const workspaceId = c.req.param("workspaceId");
    const { title } = c.req.valid("json");

    const result = await ChatStorage.updateChatTitle(chatId, title, workspaceId);
    if (!result.ok) {
      return c.json({ error: result.error }, result.error === "Chat not found" ? 404 : 500);
    }

    return c.json({ chat: result.data }, 200);
  });

export default workspaceChatRoutes;
export type WorkspaceChatRoutes = typeof workspaceChatRoutes;

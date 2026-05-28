/**
 * Workspace chat routes.
 *
 * POST /                 — Create chat, stream response via Chat SDK
 * GET  /                 — List workspace chats
 * GET  /:chatId          — Get workspace chat
 * GET  /:chatId/stream   — Resume SSE stream
 * DELETE /:chatId/stream — Stop stream (cosmetic)
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { normalizeToUIMessages, validateAtlasUIMessages } from "@atlas/agent-sdk";
import { ChatStorage } from "@atlas/core/chat/storage";
import { ChatSummariesStorage } from "@atlas/core/chat/summaries-storage";
import { WorkspaceNotFoundError } from "@atlas/core/errors/workspace-not-found";
import { UserStorage } from "@atlas/core/users/storage";
import { logger } from "@atlas/logger";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { daemonFactory } from "../../src/factory.ts";
import { summarizeChat } from "../../src/summarize-chat.ts";
import { requireWorkspaceMember } from "../../src/workspace-authz.ts";
import { MAX_FULL_EXPORT_BYTES, MAX_FULL_EXPORT_MESSAGES } from "./chat-limits.ts";

/**
 * Bound the steering text the caller can send. The summarizer is
 * server-side LLM cost; nobody should be able to push a 100KB
 * "focus" through. 500 chars is plenty for "decisions and open
 * questions" or similar steering.
 */
const SUMMARIZE_FOCUS_MAX_CHARS = 500;
const summarizeChatBodySchema = z.object({
  focus: z.string().max(SUMMARIZE_FOCUS_MAX_CHARS).optional(),
});

function hashFocus(focus: string | undefined): string {
  if (!focus || focus.trim().length === 0) return "noop";
  return createHash("sha256").update(focus.trim()).digest("hex").slice(0, 16);
}

const listChatsQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).optional(),
  cursor: z.coerce.number().optional(),
});

/**
 * Query schema for `GET /:chatId`. `?full=true` returns the entire message
 * list; absent value or any other string preserves the legacy last-100 trim
 * used by the live chat UI rehydrate path. The schema accepts an optional
 * raw string and narrows to a boolean so callers branch on `full` without
 * re-parsing — only the literal string "true" opts in.
 */
const getChatQuerySchema = z.object({
  full: z
    .string()
    .optional()
    .transform((value) => value === "true"),
});

const workspaceChatRoutes = daemonFactory
  .createApp()
  .use("*", async (c, next) => {
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) {
      return c.json({ error: "Missing workspaceId" }, 400);
    }
    // Gate every chat route on workspace membership before the
    // existence check — fail-closed for non-members even if the
    // workspace is real. requireWorkspaceMember throws HTTPException;
    // Hono's outer handler maps it to 401/403 cleanly.
    await requireWorkspaceMember(c, workspaceId);
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
        // Foreground context is fed into the prompt builder; without
        // this check a member of workspace A could ask the model to
        // see workspace B's config / chats by passing B as a
        // foreground id.
        await requireWorkspaceMember(c, fgId);
      }
    }

    // Register the abort controller BEFORE forwarding so a second POST with
    // the same chatId can stop the prior turn (no two assistant runs racing).
    // The registry is now keyed by `(workspaceId, chatId)` so a foreign
    // workspace's controller can't be aborted from this path even if the
    // chat id collides.
    const chatId =
      typeof body === "object" && body !== null && "id" in body && typeof body.id === "string"
        ? body.id
        : undefined;
    if (chatId) {
      ctx.chatTurnRegistry.replace(workspaceId, chatId);
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

    // `set` (not `append`) so a client can't smuggle their own identity.
    const headers = new Headers(c.req.raw.headers);
    headers.set("X-Atlas-User-Id", c.get("userId") ?? UserStorage.getCachedLocalUserId());
    const request = new Request(c.req.raw, { headers });
    return handler(request);
  })

  .delete("/:chatId/stream", async (c) => {
    const ctx = c.get("app");
    const chatId = c.req.param("chatId");
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) {
      return c.json({ error: "Missing workspaceId" }, 400);
    }

    // Confirm the chat actually exists in this workspace before
    // touching the registry. `getChat(chatId, workspaceId)` reads from
    // the workspace-scoped namespace — a chat in a different workspace
    // returns null here, so the 404 fires correctly. The registry is
    // also keyed by `(workspaceId, chatId)`, so even if a caller
    // bypassed this check it couldn't reach a foreign workspace's
    // turn — defense in depth.
    const chat = await ChatStorage.getChat(chatId, workspaceId);
    if (!chat.ok || !chat.data) {
      return c.json({ error: "Chat not found" }, 404);
    }

    // abort() stops the FSM/model server-side; finishStream() alone would
    // let it keep running and persist a partial message after cancel.
    ctx.chatTurnRegistry.abort(workspaceId, chatId);
    ctx.streamRegistry.finishStream(workspaceId, chatId);

    return c.json({ success: true }, 200);
  })

  .get("/:chatId/stream", async (c) => {
    const ctx = c.get("app");
    const chatId = c.req.param("chatId");
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) {
      return c.json({ error: "Missing workspaceId" }, 400);
    }

    // Same chat-belongs-to-workspace gate as the DELETE above; without
    // it a resume request leaks the existence of a chat in another
    // workspace (200 vs 404).
    const chat = await ChatStorage.getChat(chatId, workspaceId);
    if (!chat.ok || !chat.data) {
      return c.json({ error: "Chat not found" }, 404);
    }

    const buffer = ctx.streamRegistry.getStream(workspaceId, chatId);

    if (!buffer?.active) {
      return c.body(null, 204);
    }

    // 410 (not 204/200-empty): without this, subscribe() refuses the
    // replayDisabled buffer and closes the controller — the SDK reads zero
    // events as a clean finish and silently truncates the assistant message.
    // The header lets the client branch on "buffer gone" vs "replay refused".
    if (buffer.replayDisabled) {
      c.header("X-Stream-Replay-Disabled", "true");
      return c.body(null, 410);
    }

    c.header("X-Turn-Started-At", String(buffer.createdAt));

    const lastEventIdHeader = c.req.header("Last-Event-ID");
    let lastEventId: number | undefined;
    if (lastEventIdHeader !== undefined) {
      const parsed = Number.parseInt(lastEventIdHeader, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        lastEventId = parsed;
      }
    }

    const readableStream = new ReadableStream<Uint8Array>({
      start(controller) {
        const subscribed = ctx.streamRegistry.subscribe(
          workspaceId,
          chatId,
          controller,
          lastEventId,
        );
        if (!subscribed) {
          controller.close();
          return;
        }

        c.req.raw.signal.addEventListener("abort", () => {
          ctx.streamRegistry.unsubscribe(workspaceId, chatId, controller);
        });
      },
    });

    return c.body(readableStream, 200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
  })

  .get("/:chatId", zValidator("query", getChatQuerySchema), async (c) => {
    const chatId = c.req.param("chatId");
    const workspaceId = c.req.param("workspaceId");
    const { full } = c.req.valid("query");

    const chatResult = await ChatStorage.getChat(chatId, workspaceId);
    if (!chatResult.ok || !chatResult.data) {
      return c.json({ error: "Chat not found" }, 404);
    }

    const { messages, systemPromptContext, ...chat } = chatResult.data;
    // Export preview (`?full=true`) needs the whole conversation; the live
    // UI rehydrate path keeps the last-100 trim to bound payload size.
    // Reject `?full=true` for chats above the export cap before sanitising
    // — `validateAtlasUIMessages` is unbounded work per message, so a giant
    // chat would otherwise pin the daemon. The trimmed view is always
    // bounded at 100 so it doesn't need the guard.
    if (full && messages.length > MAX_FULL_EXPORT_MESSAGES) {
      return c.json(
        {
          error: "Chat too large to export",
          messageCount: messages.length,
          limit: MAX_FULL_EXPORT_MESSAGES,
        },
        413,
      );
    }
    const selectedMessages = full ? messages : messages.slice(-100);
    const sanitized = await validateAtlasUIMessages(selectedMessages);

    const responseBody = {
      chat,
      messages: sanitized,
      systemPromptContext: systemPromptContext ?? null,
      // Total messages in the chat regardless of the route-side trim.
      // Lets agent tools compute `truncated` honestly — without this
      // they only know "I sliced what I received", not "the route
      // already sliced at 100". See friday-studio-ns4.
      totalMessageCount: messages.length,
    };

    if (full) {
      // Cap the serialised payload before shipping. Stringify once for the
      // size check; `c.json` re-stringifies for the response body, which is
      // a small cost vs. preserving Hono RPC's response-type inference (a
      // raw `c.body(string, …)` widens the return type to `string | {…}`
      // and breaks downstream typed callers). The trimmed live-UI path is
      // bounded at 100 messages so it skips this branch entirely.
      //
      // `Buffer.byteLength` measures the actual UTF-8 wire size, not the
      // JS string length (UTF-16 code units). For ASCII content the two
      // match; for emoji-heavy or CJK chats the wire bytes can be 3-4×
      // the code-unit count, so the field name `payloadBytes` would be a
      // lie if we kept the cheaper `.length`.
      const serializedBytes = Buffer.byteLength(JSON.stringify(responseBody), "utf8");
      if (serializedBytes > MAX_FULL_EXPORT_BYTES) {
        return c.json(
          {
            error: "Chat too large to export",
            payloadBytes: serializedBytes,
            limit: MAX_FULL_EXPORT_BYTES,
          },
          413,
        );
      }
    }

    return c.json(responseBody, 200);
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

  /**
   * POST /:chatId/summarize — bounded-output LLM summary of the chat.
   *
   * Powers the "continue a context-maxed prior chat" use case: the
   * agent in a new chat @-mentions the old one, then calls
   * `summarize_chat` to ingest a compact representation instead of
   * `read_chat`'s raw transcript. Auth is the workspace-membership
   * gate mounted at the route group head.
   *
   * Caching: keyed on (workspaceId, chatId, updatedAt, focusHash).
   * A new message append advances `updatedAt` and naturally
   * invalidates. Cache miss runs the map-reduce in
   * `summarize-chat.ts` and persists the result. Write failures are
   * non-fatal — the route still returns the freshly computed summary.
   */
  .post("/:chatId/summarize", zValidator("json", summarizeChatBodySchema), async (c) => {
    const chatId = c.req.param("chatId");
    const workspaceId = c.req.param("workspaceId");
    if (!chatId || !workspaceId) {
      return c.json({ error: "Missing chatId or workspaceId" }, 400);
    }
    const { focus } = c.req.valid("json");

    const chatResult = await ChatStorage.getChat(chatId, workspaceId);
    if (!chatResult.ok || !chatResult.data) {
      return c.json({ error: "Chat not found" }, 404);
    }

    const chat = chatResult.data;
    const updatedAtMs = Date.parse(chat.updatedAt);
    const focusHash = hashFocus(focus);
    // Date.parse returns NaN for malformed timestamps. String(NaN)
    // is the literal "NaN" — baking that into the cache key freezes
    // the key forever (subsequent appends still parse to NaN → same
    // key → stale summary returned with cached:true). Bypass cache
    // entirely on bad timestamps so each call recomputes. See
    // friday-studio-4t7.
    const cacheable = Number.isFinite(updatedAtMs);
    const keyParts = cacheable ? { workspaceId, chatId, updatedAtMs, focusHash } : null;

    if (keyParts) {
      const cached = await ChatSummariesStorage.get(keyParts);
      if (cached) {
        return c.json({ ...cached, cached: true }, 200);
      }
    }

    try {
      const ctx = c.get("app");
      const result = await summarizeChat({
        chat,
        platformModels: ctx.platformModels,
        focus,
        abortSignal: c.req.raw.signal,
      });
      if (keyParts) await ChatSummariesStorage.put(keyParts, result);
      return c.json({ ...result, cached: false }, 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("chat_summarize_failed", { workspaceId, chatId, error: message });
      return c.json({ error: "Summarization failed", details: message }, 503);
    }
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
      // Client-supplied assistant/system messages would be a prompt injection
      // vector — agents persist their own non-user messages via ChatStorage.
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

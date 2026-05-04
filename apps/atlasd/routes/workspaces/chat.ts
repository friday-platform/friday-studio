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
import { ArtifactStorage } from "@atlas/core/artifacts/server";
import { deriveDownloadFilename } from "@atlas/core/artifacts/file-upload";
import type { ArtifactSummary } from "@atlas/core/artifacts";
import { renderChatToHTML } from "@atlas/core/chat/export/export-html";
import { buildExportZip } from "@atlas/core/chat/export/export-zip";
import { ChatStorage } from "@atlas/core/chat/storage";
import { extractTempestUserId } from "@atlas/core/credentials";
import { WorkspaceNotFoundError } from "@atlas/core/errors/workspace-not-found";
import { logger } from "@atlas/logger";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { daemonFactory } from "../../src/factory.ts";

/**
 * Hard ceiling on the entire export route. Hit this and the route bails
 * with a 503 before constructing the zip — the spec for "Chat too large
 * to export" in `docs/plans/2026-05-03-chat-export-design.md` § Export Route.
 */
const EXPORT_TIMEOUT_MS = 10_000;

/**
 * Total artifact byte budget for one export. When adding the next artifact
 * would push the running total over this, we skip it (and every subsequent
 * artifact larger than the remaining budget) and surface a placeholder in
 * the rendered HTML instead. Mirrors § Asset Bundling § Size cap.
 */
const EXPORT_SIZE_LIMIT_BYTES = 50 * 1024 * 1024;

/**
 * Per-artifact ceiling on `readBinaryContents`. Slow blobs are dropped with
 * a placeholder rather than starving the global 10s budget. Mirrors
 * § Performance Considerations § Artifact read cost.
 */
const ARTIFACT_READ_TIMEOUT_MS = 5_000;

/**
 * Slugify a derived filename to ASCII-safe characters before it lands in the
 * zip. `deriveDownloadFilename` reads `originalName` straight from artifact
 * metadata, which can carry any unicode the user/agent wrote — strip control
 * chars and path separators so the zip never grows nested directories or
 * non-portable names.
 */
function slugifyZipBasename(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "artifact";
}

/**
 * Race a promise against a fixed timeout. Resolves to `{ ok: true, value }`
 * if the work finishes first, `{ ok: false }` on timeout. The timer is
 * cleared in either case so a long-lived caller doesn't accumulate dangling
 * `setTimeout` handles.
 */
async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), timeoutMs);
  });
  try {
    return await Promise.race([work.then((value) => ({ ok: true as const, value })), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface ChatArtifactBundle {
  files: Array<{ path: string; bytes: Uint8Array }>;
  pathMap: Map<string, string>;
  /**
   * Artifacts intentionally excluded from the bundle — either oversized
   * (would push the running total over `EXPORT_SIZE_LIMIT_BYTES`) or slow
   * to read (`readBinaryContents` exceeded `ARTIFACT_READ_TIMEOUT_MS`). The
   * HTML renderer emits a `[skipped: ...]` placeholder for these. Failed
   * reads (err Result) are logged but NOT added here — the renderer treats
   * those as `[artifact file unavailable]`, a distinct UX signal.
   */
  skippedArtifactIds: Set<string>;
}

/**
 * Bundle the chat's registered artifacts for export under a fixed total
 * byte budget and per-artifact read timeout. Returns the zip-ready file
 * entries (`assets/artifacts/<id>/<basename>` paths plus bytes), a
 * `{artifactId → assetPath}` map for the renderer, and the set of artifact
 * ids that were intentionally skipped. Read failures are logged and
 * excluded from `pathMap` but not added to `skippedArtifactIds` — they
 * surface as `[artifact file unavailable]` rather than `[skipped]`.
 */
async function bundleChatArtifacts(artifacts: ArtifactSummary[]): Promise<ChatArtifactBundle> {
  const uniqueById = new Map<string, ArtifactSummary>();
  for (const summary of artifacts) {
    if (!uniqueById.has(summary.id)) uniqueById.set(summary.id, summary);
  }

  const reads = await Promise.all(
    [...uniqueById.values()].map(async (summary) => {
      const raced = await withTimeout(
        ArtifactStorage.readBinaryContents({ id: summary.id }),
        ARTIFACT_READ_TIMEOUT_MS,
      );
      return { summary, raced };
    }),
  );

  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  const pathMap = new Map<string, string>();
  const skippedArtifactIds = new Set<string>();
  let bytesUsed = 0;

  for (const { summary, raced } of reads) {
    if (!raced.ok) {
      logger.error("Artifact read timed out during chat export", {
        artifactId: summary.id,
        timeoutMs: ARTIFACT_READ_TIMEOUT_MS,
      });
      skippedArtifactIds.add(summary.id);
      continue;
    }
    const result = raced.value;
    if (!result.ok) {
      logger.error("Failed to read artifact for chat export", {
        artifactId: summary.id,
        error: result.error,
      });
      continue;
    }
    if (bytesUsed + result.data.byteLength > EXPORT_SIZE_LIMIT_BYTES) {
      logger.warn("Skipping artifact: export size cap reached", {
        artifactId: summary.id,
        artifactBytes: result.data.byteLength,
        bytesUsed,
        limitBytes: EXPORT_SIZE_LIMIT_BYTES,
      });
      skippedArtifactIds.add(summary.id);
      continue;
    }
    const basename = slugifyZipBasename(
      deriveDownloadFilename({
        mimeType: summary.mimeType,
        originalName: summary.originalName,
        title: summary.title,
      }),
    );
    const path = `assets/artifacts/${summary.id}/${basename}`;
    files.push({ path, bytes: result.data });
    pathMap.set(summary.id, path);
    bytesUsed += result.data.byteLength;
  }
  return { files, pathMap, skippedArtifactIds };
}

const listChatsQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).optional(),
  cursor: z.coerce.number().optional(),
});

/**
 * Extract userId from FRIDAY_KEY JWT.
 * Falls back to "default-user" in dev mode (no FRIDAY_KEY).
 */
function getUserId(): string {
  const atlasKey = process.env.FRIDAY_KEY;
  return (atlasKey && extractTempestUserId(atlasKey)) || "default-user";
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

  .get("/:chatId/export", async (c) => {
    const chatId = c.req.param("chatId");
    const workspaceId = c.req.param("workspaceId");

    // Wrap the full pipeline (chat fetch → artifact list → bundle → render
    // → zip) in a 10s race so a pathological chat or hung upstream can't
    // pin the daemon. We never construct the response body until the work
    // resolves, so a timeout returns a clean 503 with no half-written zip.
    const exportWork = (async () => {
      const chatResult = await ChatStorage.getChat(chatId, workspaceId);
      if (!chatResult.ok) return { kind: "chat-error" as const, error: chatResult.error };
      if (!chatResult.data) return { kind: "not-found" as const };
      const chat = chatResult.data;

      const artifactsResult = await ArtifactStorage.listByChat({ chatId });
      if (!artifactsResult.ok) return { kind: "list-error" as const, error: artifactsResult.error };
      const artifacts = artifactsResult.data;
      const { files: artifactFiles, pathMap: artifactPathMap, skippedArtifactIds } =
        await bundleChatArtifacts(artifacts);
      // Export uses the full message list — unlike GET /:chatId which trims
      // to the last 100 for UI rehydrate.
      const html = renderChatToHTML(chat, artifacts, artifactPathMap, skippedArtifactIds);
      const stream = await buildExportZip(html, chat, artifactFiles);
      return { kind: "ok" as const, stream };
    })();

    const raced = await withTimeout(exportWork, EXPORT_TIMEOUT_MS);
    if (!raced.ok) {
      logger.warn("Chat export timed out", {
        chatId,
        workspaceId,
        timeoutMs: EXPORT_TIMEOUT_MS,
      });
      return c.json({ error: "Chat too large to export" }, 503);
    }
    const outcome = raced.value;
    if (outcome.kind === "chat-error") {
      return c.json({ error: outcome.error }, 500);
    }
    if (outcome.kind === "not-found") {
      return c.json({ error: "Chat not found" }, 404);
    }
    if (outcome.kind === "list-error") {
      // Post-#164 the artifact migration is awaited at daemon boot, so this
      // branch is largely unreachable — but if the upstream surfaces a
      // migration-shaped error anyway, prefer 503 over 500 so callers can
      // retry cleanly instead of treating it as a permanent failure.
      if (/migrating/i.test(outcome.error)) {
        logger.warn("Chat export hit artifact migration shim", {
          chatId,
          error: outcome.error,
        });
        return c.json({ error: "Chat artifacts are being migrated; try again shortly" }, 503);
      }
      logger.error("Failed to list artifacts for chat export", {
        chatId,
        error: outcome.error,
      });
      return c.json({ error: outcome.error }, 500);
    }
    return c.body(outcome.stream, 200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="friday-chat-${chatId.slice(0, 8)}.zip"`,
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

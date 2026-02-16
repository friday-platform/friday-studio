import { SessionHistoryStorage } from "@atlas/core";
import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { daemonFactory } from "../../src/factory.ts";

interface SessionInfo {
  id: string;
  workspaceId: string;
  status: string;
  summary: string;
  signal: string;
  startTime?: string;
  endTime?: string;
  progress: number;
}

/**
 * Atlas daemon session routes.
 * Provides API for session management across workspaces.
 * Mounted at /api/sessions/ on the daemon's HTTP server.
 */
const sessionsRoutes = daemonFactory
  .createApp()
  // List sessions across all workspaces
  .get(
    "/",
    zValidator(
      "query",
      z.object({
        limit: z.coerce.number().int().min(1).max(200).optional().default(50),
        cursor: z.string().optional(),
      }),
    ),
    (c) => {
      const { limit, cursor } = c.req.valid("query");
      const ctx = c.get("app");
      const allSessions: SessionInfo[] = [];

      for (const [workspaceId, runtime] of ctx.daemon.runtimes) {
        const sessions = runtime.getSessions().map((activeSession) => ({
          id: activeSession.id,
          workspaceId,
          status: activeSession.session.status,
          summary: activeSession.session.summarize(),
          signal: activeSession.signalId,
          startTime: activeSession.startedAt.toISOString(),
          endTime: undefined, // Not tracked in current implementation
          progress: activeSession.session.progress(),
        }));
        allSessions.push(...sessions);
      }

      // Sort by startTime desc (newest first)
      allSessions.sort((a, b) => {
        const ta = a.startTime ?? "";
        const tb = b.startTime ?? "";
        return tb.localeCompare(ta);
      });

      // Apply cursor: skip everything up to and including the cursor session
      let startIndex = 0;
      if (cursor) {
        const cursorIndex = allSessions.findIndex((s) => s.id === cursor);
        if (cursorIndex !== -1) {
          startIndex = cursorIndex + 1;
        }
      }

      const page = allSessions.slice(startIndex, startIndex + limit + 1);
      const hasMore = page.length > limit;
      const items = hasMore ? page.slice(0, limit) : page;
      const nextCursor = hasMore ? items[items.length - 1]?.id : undefined;

      return c.json({ items, nextCursor, total: allSessions.length }, 200);
    },
  )
  // Get specific session from any workspace
  .get("/:id", async (c) => {
    const ctx = c.get("app");
    const sessionId = c.req.param("id");

    // 1. Check active runtimes first (in-memory sessions)
    for (const [workspaceId, runtime] of ctx.daemon.runtimes) {
      const activeSession = runtime.getSessions().find((s) => s.id === sessionId);
      if (activeSession) {
        return c.json(
          {
            id: activeSession.id,
            workspaceId,
            status: activeSession.session.status,
            progress: activeSession.session.progress(),
            summary: activeSession.session.summarize(),
            signal: activeSession.signalId,
            startTime: activeSession.startedAt.toISOString(),
            endTime: undefined, // Not tracked in current implementation
            artifacts: activeSession.session.getArtifacts(),
          },
          200,
        );
      }
    }

    // 2. Fallback to history storage for completed sessions
    const historyResult = await SessionHistoryStorage.getSessionMetadata(sessionId);

    if (!historyResult.ok) {
      logger.error("Failed to query session history", { sessionId, error: historyResult.error });
      return c.json({ error: `Session not found: ${sessionId}` }, 404);
    }

    if (historyResult.data) {
      // Found in history storage
      return c.json(
        {
          id: historyResult.data.sessionId,
          workspaceId: historyResult.data.workspaceId,
          status: historyResult.data.status,
          progress: 100, // Completed sessions are always 100%
          summary: historyResult.data.summary || `Session ${sessionId}`,
          signal: historyResult.data.signal.id,
          startTime: historyResult.data.createdAt,
          endTime: historyResult.data.updatedAt,
          artifacts: [], // Could load from timeline if needed
          source: "history", // Indicate this came from storage
        },
        200,
      );
    }

    return c.json({ error: `Session not found: ${sessionId}` }, 404);
  })
  // DELETE /api/sessions/:id - Cancel a session
  .delete("/:id", zValidator("param", z.object({ id: z.string() })), async (c) => {
    const { id } = c.req.valid("param");
    const ctx = c.get("app");

    // Find session across all runtimes
    for (const [workspaceId, runtime] of ctx.daemon.runtimes) {
      const activeSession = runtime.getSessions().find((s) => s.id === id);
      if (activeSession) {
        try {
          await runtime.cancelSession(id);
          return c.json({ message: `Session ${id} cancelled`, workspaceId }, 200);
        } catch (error) {
          logger.error("Failed to cancel session", { error, sessionId: id, workspaceId });
          return c.json({ error: stringifyError(error) }, 500);
        }
      }
    }

    return c.json({ error: `Session not found: ${id}` }, 404);
  });

export { sessionsRoutes };
export type SessionsRoutes = typeof sessionsRoutes;
export type { SessionHistoryRoutes } from "./history.ts";
export { sessionHistoryRoutes } from "./history.ts";

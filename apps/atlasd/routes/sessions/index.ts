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
  .get("/", (c) => {
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

    return c.json(allSessions, 200);
  })
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
  // DELETE /api/sessions/:sessionId - Cancel a session
  .delete("/:id", zValidator("param", z.object({ sessionId: z.string() })), async (c) => {
    const { sessionId } = c.req.valid("param");
    const ctx = c.get("app");
    const { runtimes } = ctx;

    // Find session across all runtimes
    for (const [workspaceId, runtime] of runtimes) {
      const activeSession = runtime.getSessions().find((s) => s.id === sessionId);
      if (activeSession) {
        try {
          await runtime.cancelSession(sessionId);
          return c.json({ message: `Session ${sessionId} cancelled`, workspaceId }, 200);
        } catch (error) {
          logger.error("Failed to cancel session", { error, sessionId, workspaceId });
          return c.json({ error: stringifyError(error) }, 500);
        }
      }
    }

    return c.json({ error: `Session not found: ${sessionId}` }, 404);
  });

export { sessionsRoutes };
export type SessionsRoutes = typeof sessionsRoutes;
export type { SessionHistoryRoutes } from "./history.ts";
export { sessionHistoryRoutes } from "./history.ts";

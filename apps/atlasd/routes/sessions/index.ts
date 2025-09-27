import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod/v4";
import { daemonFactory } from "../../src/factory.ts";

interface SessionInfo {
  id: string;
  workspaceId: string;
  status: string;
  summary: string;
  signal: string;
  startTime?: unknown;
  endTime?: unknown;
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
  .get("/sessions", (c) => {
    const ctx = c.get("app");
    const allSessions: SessionInfo[] = [];

    for (const [workspaceId, runtime] of ctx.daemon.runtimes) {
      const sessions = runtime.getSessions().map((session) => ({
        id: session.id,
        workspaceId,
        status: session.status,
        summary: session.summarize(),
        signal: session.signals?.triggers?.[0]?.id || "unknown",
        startTime: undefined, // Private property, not accessible
        endTime: undefined, // Private property, not accessible
        progress: session.progress(),
      }));
      allSessions.push(...sessions);
    }

    return c.json(allSessions);
  })
  // Get specific session from any workspace
  .get("/api/sessions/:sessionId", (c) => {
    const ctx = c.get("app");
    const sessionId = c.req.param("sessionId");

    // Find session across all runtimes
    for (const [workspaceId, runtime] of ctx.daemon.runtimes) {
      const session = runtime.getSession(sessionId);
      if (session) {
        interface SessionDetails {
          id: string;
          workspaceId: string;
          status: string;
          progress: number;
          summary: string;
          signal: string;
          startTime?: unknown;
          endTime?: unknown;
          artifacts: unknown[];
          results?: unknown;
        }

        const sessionData: SessionDetails = {
          id: session.id,
          workspaceId,
          status: session.status,
          progress: session.progress(),
          summary: session.summarize(),
          signal: session.signals?.triggers?.[0]?.id || "unknown",
          startTime: undefined, // Private property, not accessible
          endTime: undefined, // Private property, not accessible
          artifacts: session.getArtifacts(),
        };

        // Get execution results if available
        const artifacts = session.getArtifacts();
        const resultsArtifact = artifacts.find((a) => a.type === "execution_results");
        if (resultsArtifact?.data) {
          sessionData.results = resultsArtifact.data.results;
          sessionData.summary = resultsArtifact.data.summary;
        }

        return c.json(sessionData);
      }
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
      const session = runtime.getSession(sessionId);
      if (session) {
        try {
          await runtime.cancelSession(sessionId);
          return c.json({ message: `Session ${sessionId} cancelled`, workspaceId });
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

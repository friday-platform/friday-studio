import { stat } from "node:fs/promises";
import { join } from "node:path";
import { buildSessionView, type SessionSummary, type SessionView } from "@atlas/core";
import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { daemonFactory } from "../../src/factory.ts";

const ListQuery = z.object({ workspaceId: z.string().optional() });

/**
 * Build a SessionSummary from a SessionView (for active sessions
 * that only exist as in-memory event buffers).
 */
function viewToSummary(view: SessionView): SessionSummary {
  return {
    sessionId: view.sessionId,
    workspaceId: view.workspaceId,
    jobName: view.jobName,
    task: view.task,
    status: view.status,
    startedAt: view.startedAt,
    completedAt: view.completedAt,
    durationMs: view.durationMs,
    stepCount: view.agentBlocks.length,
    agentNames: view.agentBlocks.map((b) => b.agentName),
    aiSummary: view.aiSummary,
  };
}

/**
 * Atlas daemon session routes.
 * Provides API for session management across workspaces.
 * Mounted at /api/sessions/ on the daemon's HTTP server.
 */
const sessionsRoutes = daemonFactory
  .createApp()
  /** List session summaries, optionally filtered by workspace. */
  .get("/", zValidator("query", ListQuery), async (c) => {
    const { workspaceId } = c.req.valid("query");
    const ctx = c.get("app");
    const { sessionStreamRegistry: registry, sessionHistoryAdapter: adapter } = ctx;

    // Completed sessions from adapter
    const completedSummaries = await adapter.listByWorkspace(workspaceId);

    // Active sessions from registry — reduce in-memory buffers to summaries
    const activeSummaries: SessionSummary[] = [];
    for (const stream of registry.listActive()) {
      const view = buildSessionView(stream.getBufferedEvents());
      if (!workspaceId || view.workspaceId === workspaceId) {
        activeSummaries.push(viewToSummary(view));
      }
    }

    // Merge and sort by startedAt descending
    const sessions = [...activeSummaries, ...completedSummaries].sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );

    return c.json({ sessions }, 200);
  })
  /**
   * GET /api/sessions/:id/stream
   * SSE endpoint for real-time session events.
   *
   * Active session: replays buffered durable events, then streams live events.
   * Finalized session (still in registry): replays all events including
   * session:complete, then closes.
   * Completed session (v2 adapter): returns 404 — client falls back to
   * GET /:id JSON endpoint, which returns the full SessionView.
   * Old-format session (v1 JSON file exists): returns 410 Gone.
   */
  .get("/:id/stream", async (c) => {
    const ctx = c.get("app");
    const sessionId = c.req.param("id");
    const registry = ctx.sessionStreamRegistry;

    // 1. Check registry for active or recently-finalized stream
    const stream = registry.get(sessionId);
    if (stream) {
      const sseStream = new ReadableStream<Uint8Array>({
        start(controller) {
          stream.subscribe(controller);

          c.req.raw.signal.addEventListener("abort", () => {
            stream.unsubscribe(controller);
          });
        },
      });

      return c.body(sseStream, 200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
    }

    // 2. Check for old-format session (v1 JSON file)
    const oldSessionPath = join(getAtlasHome(), "sessions", `${sessionId}.json`);
    try {
      await stat(oldSessionPath);
      return c.json({ error: "Session uses outdated storage format" }, 410);
    } catch {
      // File doesn't exist — not an old-format session
    }

    // 3. Unknown session — client falls back to GET /:id JSON endpoint
    return c.json({ error: `Session not found: ${sessionId}` }, 404);
  })
  /** Get a single session — checks active runtimes, v2 registry, v2 adapter. */
  .get("/:id", async (c) => {
    const ctx = c.get("app");
    const sessionId = c.req.param("id");

    // 1. Check v2 registry (active or recently-finalized sessions)
    const registry = ctx.sessionStreamRegistry;
    const stream = registry.get(sessionId);
    if (stream) {
      const view = buildSessionView(stream.getBufferedEvents());
      return c.json(view, 200);
    }

    // 2. Check v2 adapter (completed sessions persisted to disk)
    const adapter = ctx.sessionHistoryAdapter;
    const view = await adapter.get(sessionId);
    if (view) {
      return c.json(view, 200);
    }

    // 3. Check for old-format session (v1 JSON file)
    const oldSessionPath = join(getAtlasHome(), "sessions", `${sessionId}.json`);
    try {
      await stat(oldSessionPath);
      return c.json({ error: "Session uses outdated storage format" }, 410);
    } catch {
      // File doesn't exist — not an old-format session
    }

    return c.json({ error: `Session not found: ${sessionId}` }, 404);
  })
  /** Cancel a running session. */
  .delete("/:id", zValidator("param", z.object({ id: z.string() })), async (c) => {
    const { id } = c.req.valid("param");
    const ctx = c.get("app");

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

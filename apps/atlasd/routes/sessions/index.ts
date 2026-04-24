import { stat } from "node:fs/promises";
import { join } from "node:path";
import { buildSessionView, type SessionSummary, type SessionView } from "@atlas/core";
import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { zValidator } from "@hono/zod-validator";
import { consumerOpts } from "nats";
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
   * Subscribes to the NATS JetStream SESSIONS stream with DeliverAll so
   * reconnecting clients get full event replay. Also subscribes to the
   * NATS core ephemeral subject for live streaming chunks.
   *
   * Session existence is confirmed via the in-memory registry. If the
   * session is unknown, falls through to 404 (client uses GET /:id).
   */
  .get("/:id/stream", async (c) => {
    const ctx = c.get("app");
    const sessionId = c.req.param("id");
    const registry = ctx.sessionStreamRegistry;

    // 1. Check registry — confirms the session is active or recently finalized
    const stream = registry.get(sessionId);
    if (stream) {
      const nc = ctx.daemon.getNatsConnection();
      const js = nc.jetstream();
      const encoder = new TextEncoder();

      const sseStream = new ReadableStream<Uint8Array>({
        start(controller) {
          let closed = false;

          function enqueue(data: string) {
            if (!closed) {
              try {
                controller.enqueue(encoder.encode(data));
              } catch {
                closed = true;
              }
            }
          }

          function close() {
            if (!closed) {
              closed = true;
              try {
                controller.close();
              } catch {
                // already closed
              }
            }
          }

          // Subscribe to durable events via JetStream (replays from sequence 0)
          const opts = consumerOpts();
          opts.deliverAll();
          opts.ackNone();
          opts.replayInstantly();
          opts.orderedConsumer();
          const jsSub = js.subscribe(`sessions.${sessionId}.events`, opts);

          void (async () => {
            try {
              const sub = await jsSub;
              for await (const msg of sub) {
                if (closed) {
                  sub.unsubscribe();
                  break;
                }
                const data = msg.string();
                enqueue(`data: ${data}\n\n`);
                // Close after session:complete — SSE clients handle this terminal event
                try {
                  const parsed: unknown = JSON.parse(data);
                  if (
                    typeof parsed === "object" &&
                    parsed !== null &&
                    "type" in parsed &&
                    parsed.type === "session:complete"
                  ) {
                    sub.unsubscribe();
                    close();
                    break;
                  }
                } catch {
                  // ignore parse errors on individual messages
                }
              }
              close();
            } catch (err) {
              if (!closed) {
                controller.error(err instanceof Error ? err : new Error(String(err)));
              }
            }
          })();

          // Subscribe to ephemeral chunks via NATS core (live only, no replay)
          const ephemerSub = nc.subscribe(`sessions.${sessionId}.ephemeral`);
          void (async () => {
            try {
              for await (const msg of ephemerSub) {
                if (closed) break;
                enqueue(`event: ephemeral\ndata: ${msg.string()}\n\n`);
              }
            } catch {
              // subscription closed
            }
          })();

          c.req.raw.signal.addEventListener("abort", () => {
            closed = true;
            ephemerSub.unsubscribe();
            jsSub.then((sub) => sub.unsubscribe()).catch(() => {});
            close();
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
  .delete("/:id", zValidator("param", z.object({ id: z.string() })), (c) => {
    const { id } = c.req.valid("param");
    const ctx = c.get("app");

    // `getSessions()` returns only *finalized* sessions on the runtime; an
    // in-flight execution lives in `activeAbortControllers` until its finally
    // block. Check that explicitly so DELETE can hit currently-running work.
    for (const [workspaceId, runtime] of ctx.daemon.runtimes) {
      if (!runtime.hasActiveSession(id)) continue;
      try {
        runtime.cancelSession(id);
        return c.json({ message: `Session ${id} cancelled`, workspaceId }, 200);
      } catch (error) {
        logger.error("Failed to cancel session", { error, sessionId: id, workspaceId });
        return c.json({ error: stringifyError(error) }, 500);
      }
    }

    return c.json({ error: `Session not found or not active: ${id}` }, 404);
  });

export { sessionsRoutes };
export type SessionsRoutes = typeof sessionsRoutes;

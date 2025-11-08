import { SessionHistoryStorage } from "@atlas/core/session/history-storage";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { daemonFactory } from "../../src/factory.ts";

const ListSessionHistoryQuery = z.object({ workspaceId: z.string() });

const GetSessionHistoryParams = z.object({ id: z.string() });

const sessionHistoryRoutes = daemonFactory
  .createApp()
  /** List session history for a workspace */
  .get("/", zValidator("query", ListSessionHistoryQuery), async (c) => {
    const { workspaceId } = c.req.valid("query");
    const result = await SessionHistoryStorage.listSessions({ workspaceId });

    if (!result.ok) {
      return c.json({ error: result.error }, 500);
    }

    return c.json({ sessions: result.data.sessions }, 200);
  })
  /** Get full session timeline (metadata + events) */
  .get("/:id", zValidator("param", GetSessionHistoryParams), async (c) => {
    const { id } = c.req.valid("param");
    const result = await SessionHistoryStorage.loadSessionTimeline(id);

    if (!result.ok) {
      return c.json({ error: result.error }, 500);
    }

    if (!result.data) {
      return c.json({ error: "Session not found" }, 404);
    }

    return c.json(result.data, 200);
  });

export { sessionHistoryRoutes };
export type SessionHistoryRoutes = typeof sessionHistoryRoutes;

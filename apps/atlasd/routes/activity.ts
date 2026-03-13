import {
  ActivityListFilterSchema,
  type ActivityStorageAdapter,
  ActivityWithReadStatusSchema,
  ReadStatusValueSchema,
} from "@atlas/activity";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { daemonFactory } from "../src/factory.ts";
import { getCurrentUser } from "./me/adapter.ts";

// ==============================================================================
// Auth helper
// ==============================================================================

async function requireUser(): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const result = await getCurrentUser();
  if (!result.ok || !result.data) return { ok: false, error: "Unauthorized" };
  return { ok: true, userId: result.data.id };
}

// ==============================================================================
// Query / body schemas
// ==============================================================================

const ListQuerySchema = ActivityListFilterSchema;

const MarkByIdsSchema = z.object({
  activityIds: z.array(z.string().min(1)).min(1),
  status: ReadStatusValueSchema,
});

const MarkByTimestampSchema = z.object({
  before: z.string().datetime(),
  status: z.literal("viewed"),
});

const MarkBodySchema = z.union([MarkByIdsSchema, MarkByTimestampSchema]);

// ==============================================================================
// Helper to get adapter from context
// ==============================================================================

function getAdapter(c: {
  get: (key: "app") => { getActivityAdapter(): ActivityStorageAdapter };
}): ActivityStorageAdapter {
  return c.get("app").getActivityAdapter();
}

// ==============================================================================
// Routes
// ==============================================================================

export const activityRoutes = daemonFactory
  .createApp()
  // ─── LIST ─────────────────────────────────────────────────────────────────
  .get("/", zValidator("query", ListQuerySchema), async (c) => {
    const auth = await requireUser();
    if (!auth.ok) return c.json({ error: auth.error }, 401);

    const filters = c.req.valid("query");
    const adapter = getAdapter(c);
    const result = await adapter.list(auth.userId, filters);
    const parsed = z.array(ActivityWithReadStatusSchema).parse(result.activities);
    return c.json({ activities: parsed, hasMore: result.hasMore });
  })
  // ─── UNREAD COUNT ─────────────────────────────────────────────────────────
  .get("/unread-count", async (c) => {
    const auth = await requireUser();
    if (!auth.ok) return c.json({ error: auth.error }, 401);

    const adapter = getAdapter(c);
    const count = await adapter.getUnreadCount(auth.userId);
    return c.json({ count });
  })
  // ─── MARK READ STATUS ────────────────────────────────────────────────────
  .post("/mark", zValidator("json", MarkBodySchema), async (c) => {
    const auth = await requireUser();
    if (!auth.ok) return c.json({ error: auth.error }, 401);

    const body = c.req.valid("json");
    const adapter = getAdapter(c);

    if ("activityIds" in body) {
      await adapter.updateReadStatus(auth.userId, body.activityIds, body.status);
    } else {
      await adapter.markViewedBefore(auth.userId, body.before);
    }

    return c.json({ success: true });
  });

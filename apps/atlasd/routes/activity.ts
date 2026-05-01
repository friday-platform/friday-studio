import {
  ActivityListFilterSchema,
  type ActivityStorageAdapter,
  ActivityWithReadStatusSchema,
  activityNotifier,
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

const UnreadCountQuerySchema = z.object({ workspaceId: z.string().min(1).optional() });

const MarkByIdsSchema = z.object({
  activityIds: z.array(z.string().min(1)).min(1),
  status: ReadStatusValueSchema,
});

const MarkByTimestampSchema = z.object({
  before: z.string().datetime(),
  status: z.literal("viewed"),
  workspaceId: z.string().min(1).optional(),
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

export type ActivityRoutes = typeof activityRoutes;

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
  .get("/unread-count", zValidator("query", UnreadCountQuerySchema), async (c) => {
    const auth = await requireUser();
    if (!auth.ok) return c.json({ error: auth.error }, 401);

    const adapter = getAdapter(c);
    const { workspaceId } = c.req.valid("query");
    const count = await adapter.getUnreadCount(auth.userId, workspaceId);
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
      await adapter.markViewedBefore(auth.userId, body.before, body.workspaceId);
    }

    return c.json({ success: true });
  })
  // ─── SSE STREAM ──────────────────────────────────────────────────────────
  .get("/stream", async (c) => {
    const auth = await requireUser();
    if (!auth.ok) return c.json({ error: auth.error }, 401);

    const adapter = getAdapter(c);
    const userId = auth.userId;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        let lastCount = -1;

        async function sendCount(): Promise<void> {
          const count = await adapter.getUnreadCount(userId);
          if (count === lastCount) return;
          lastCount = count;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ count })}\n\n`));
        }

        // Send initial count
        await sendCount();

        // Subscribe to mutations
        const unsubscribe = activityNotifier.subscribe(() => {
          sendCount();
        });

        // Keepalive every 30s
        const keepalive = setInterval(() => {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        }, 30_000);

        // Cleanup on disconnect
        c.req.raw.signal.addEventListener("abort", () => {
          unsubscribe();
          clearInterval(keepalive);
          controller.close();
        });
      },
    });

    return c.body(stream, 200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
  });

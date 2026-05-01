/** Activity HTTP routes. Mounted under /v1/activity. */
import {
  ActivityListFilterSchema,
  ActivityWithReadStatusSchema,
  CreateActivityInputSchema,
  ReadStatusValueSchema,
} from "@atlas/activity";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { factory } from "./factory.ts";

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

const UnreadCountQuerySchema = z.object({ workspaceId: z.string().min(1).optional() });

const ReferenceIdParamSchema = z.object({ referenceId: z.string().min(1) });

/** Creates the activity routes. Mounted under /v1/activity. */
export function createActivityRoutes() {
  return factory
    .createApp()

    .get("/", zValidator("query", ActivityListFilterSchema), async (c) => {
      const adapter = c.get("activityAdapter");
      const userId = c.get("userId");
      const filters = c.req.valid("query");
      const result = await adapter.list(userId, filters);
      const parsed = z.array(ActivityWithReadStatusSchema).parse(result.activities);
      return c.json({ activities: parsed, hasMore: result.hasMore });
    })

    .get("/unread-count", zValidator("query", UnreadCountQuerySchema), async (c) => {
      const adapter = c.get("activityAdapter");
      const userId = c.get("userId");
      const { workspaceId } = c.req.valid("query");
      const count = await adapter.getUnreadCount(userId, workspaceId);
      return c.json({ count });
    })

    .post("/mark", zValidator("json", MarkBodySchema), async (c) => {
      const adapter = c.get("activityAdapter");
      const userId = c.get("userId");
      const body = c.req.valid("json");

      if ("activityIds" in body) {
        await adapter.updateReadStatus(userId, body.activityIds, body.status);
      } else {
        await adapter.markViewedBefore(userId, body.before, body.workspaceId);
      }

      return c.json({ success: true });
    })

    .post("/", zValidator("json", CreateActivityInputSchema), async (c) => {
      const adapter = c.get("activityAdapter");
      const input = c.req.valid("json");
      const result = await adapter.create(input);
      return c.json(result, 201);
    })

    .delete(
      "/by-reference/:referenceId",
      zValidator("param", ReferenceIdParamSchema),
      async (c) => {
        const adapter = c.get("activityAdapter");
        const { referenceId } = c.req.valid("param");
        await adapter.deleteByReferenceId(referenceId);
        return c.json({ deleted: true });
      },
    );
}

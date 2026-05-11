/**
 * HTTP routes for durable human-in-the-loop elicitations. Backed by
 * `ElicitationStorage` in `@atlas/core` — a JetStream stream + KV
 * bucket facade. Mounted at `/api/elicitations` from `atlas-daemon.ts`.
 *
 * Surface:
 *   - GET /              list with workspaceId/sessionId/status/kind filters
 *   - GET /:id           get one (404 if unknown)
 *   - POST /:id/answer   { value, note?, answeredBy? } — server fills
 *                        `answeredAt`; flips status to `answered`
 *   - POST /:id/decline  { note? } — flips status to `declined`
 *
 * Live updates are delivered through the per-user firehose at
 * `/api/me/stream`; no per-feed SSE handler lives here.
 */

import {
  ElicitationKindSchema,
  ElicitationSchema,
  ElicitationStatusSchema,
  ElicitationStorage,
  ToolAccessGrants,
} from "@atlas/core";
import { createLogger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { HTTPException } from "hono/http-exception";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { daemonFactory } from "../../src/factory.ts";
import { errorResponseSchema } from "../../src/utils.ts";
import { getAccessibleWorkspaceIds, requireWorkspaceMember } from "../../src/workspace-authz.ts";

const elicitationApp = daemonFactory.createApp();
const logger = createLogger({ component: "elicitation-routes" });

// ---------------------------------------------------------------------------
// GET / — list
// ---------------------------------------------------------------------------

const ListQuerySchema = z.object({
  workspaceId: z.string().optional(),
  sessionId: z.string().optional(),
  status: ElicitationStatusSchema.optional(),
  kind: ElicitationKindSchema.optional(),
});

elicitationApp.get(
  "/",
  describeRoute({
    tags: ["Elicitations"],
    summary: "List elicitations",
    description:
      "List elicitations, optionally filtered by workspaceId, sessionId, status, or kind. " +
      "No filter returns the global Activity-page view.",
    responses: {
      200: {
        description: "Elicitations retrieved",
        content: {
          "application/json": {
            schema: resolver(
              z.object({ elicitations: z.array(ElicitationSchema), count: z.number() }),
            ),
          },
        },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  validator("query", ListQuerySchema),
  async (c) => {
    try {
      const userId = c.get("userId");
      if (!userId) return c.json({ error: "Unauthorized" }, 401);

      const { workspaceId, sessionId, status, kind } = c.req.valid("query");

      // Workspace-scoped explicit filter: gate on membership.
      if (workspaceId !== undefined) {
        await requireWorkspaceMember(c, workspaceId);
      }

      const result = await ElicitationStorage.list({
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(status !== undefined ? { status } : {}),
      });
      if (!result.ok) {
        return c.json({ error: result.error }, 500);
      }

      // Global view (no explicit workspaceId): filter to elicitations
      // the caller can see based on their workspace memberships. Keeps
      // the listing semantically the same — "everything I'm allowed to
      // see" — without exposing other tenants' rows.
      const accessible = workspaceId === undefined ? await getAccessibleWorkspaceIds(userId) : null;
      const visible =
        accessible === null
          ? result.data
          : result.data.filter((e) => accessible.has(e.workspaceId));

      // The storage layer doesn't filter by `kind` (no direct support),
      // so apply the filter here for parity with the documented surface.
      const elicitations = kind === undefined ? visible : visible.filter((e) => e.kind === kind);
      return c.json({ elicitations, count: elicitations.length });
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      return c.json({ error: stringifyError(error) }, 500);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /:id — fetch one
// ---------------------------------------------------------------------------

elicitationApp.get(
  "/:id",
  describeRoute({
    tags: ["Elicitations"],
    summary: "Get an elicitation by id",
    responses: {
      200: {
        description: "Elicitation found",
        content: { "application/json": { schema: resolver(ElicitationSchema) } },
      },
      404: {
        description: "Elicitation not found",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  validator("param", z.object({ id: z.string() })),
  async (c) => {
    try {
      const { id } = c.req.valid("param");
      const result = await ElicitationStorage.get({ id });
      if (!result.ok) return c.json({ error: result.error }, 500);
      if (!result.data) {
        return c.json({ error: `Elicitation ${id} not found` }, 404);
      }
      await requireWorkspaceMember(c, result.data.workspaceId);
      return c.json(result.data);
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      return c.json({ error: stringifyError(error) }, 500);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /:id/answer
// ---------------------------------------------------------------------------

const AnswerBodySchema = z.object({
  value: z.string(),
  note: z.string().optional(),
  answeredBy: z.string().optional(),
});

elicitationApp.post(
  "/:id/answer",
  describeRoute({
    tags: ["Elicitations"],
    summary: "Answer a pending elicitation",
    description:
      "Mark an elicitation as answered. Server fills `answeredAt`. " +
      "Returns the updated envelope. 404 if the id is unknown; 500 if the " +
      "elicitation is already in a terminal state.",
    responses: {
      200: {
        description: "Elicitation answered",
        content: { "application/json": { schema: resolver(ElicitationSchema) } },
      },
      400: {
        description: "Invalid request body",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
      404: {
        description: "Elicitation not found",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
      500: {
        description: "Internal server error or terminal-state conflict",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  validator("param", z.object({ id: z.string() })),
  validator("json", AnswerBodySchema),
  async (c) => {
    try {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");

      // 404 fast: storage `answer` collapses "not found" and "already
      // terminal" into a single failed-Result. Disambiguate with a get
      // first so the HTTP status mirrors the user's expectation.
      const got = await ElicitationStorage.get({ id });
      if (!got.ok) return c.json({ error: got.error }, 500);
      if (!got.data) {
        return c.json({ error: `Elicitation ${id} not found` }, 404);
      }
      // Workspace-scope authz: the elicitation carries its workspaceId;
      // require the caller to be a member of that workspace.
      await requireWorkspaceMember(c, got.data.workspaceId);

      const result = await ElicitationStorage.answer({
        id,
        answer: {
          value: body.value,
          ...(body.note !== undefined ? { note: body.note } : {}),
          ...(body.answeredBy !== undefined ? { answeredBy: body.answeredBy } : {}),
          answeredAt: new Date().toISOString(),
        },
      });
      if (!result.ok) return c.json({ error: result.error }, 500);
      if (
        result.data.kind === "tool-allowlist" &&
        result.data.answer?.value === "allow_always" &&
        result.data.pendingTool?.name
      ) {
        const grant = await ToolAccessGrants.grantAlways({
          workspaceId: result.data.workspaceId,
          toolName: result.data.pendingTool.name,
          sourceElicitationId: result.data.id,
          ...(body.answeredBy ? { grantedBy: body.answeredBy } : {}),
        });
        if (!grant.ok) {
          // The user's answer is already durable; log the secondary
          // persistence failure without hiding the accepted answer from
          // the UI or the blocked run.
          logger.warn("Failed to persist allow-always tool grant", { error: grant.error });
        }
      }
      return c.json(result.data);
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      return c.json({ error: stringifyError(error) }, 500);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /:id/decline
// ---------------------------------------------------------------------------

const DeclineBodySchema = z.object({ note: z.string().optional() });

elicitationApp.post(
  "/:id/decline",
  describeRoute({
    tags: ["Elicitations"],
    summary: "Decline a pending elicitation",
    description:
      "Mark an elicitation as declined. Optional note is preserved on " +
      "the envelope. 404 if the id is unknown; 500 if already terminal.",
    responses: {
      200: {
        description: "Elicitation declined",
        content: { "application/json": { schema: resolver(ElicitationSchema) } },
      },
      400: {
        description: "Invalid request body",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
      404: {
        description: "Elicitation not found",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
      500: {
        description: "Internal server error or terminal-state conflict",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  validator("param", z.object({ id: z.string() })),
  validator("json", DeclineBodySchema),
  async (c) => {
    try {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");

      const got = await ElicitationStorage.get({ id });
      if (!got.ok) return c.json({ error: got.error }, 500);
      if (!got.data) {
        return c.json({ error: `Elicitation ${id} not found` }, 404);
      }
      await requireWorkspaceMember(c, got.data.workspaceId);

      const result = await ElicitationStorage.decline({
        id,
        ...(body.note !== undefined ? { note: body.note } : {}),
      });
      if (!result.ok) return c.json({ error: result.error }, 500);
      return c.json(result.data);
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      return c.json({ error: stringifyError(error) }, 500);
    }
  },
);

export { elicitationApp };

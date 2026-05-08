/**
 * HTTP routes for durable human-in-the-loop elicitations. Backed by
 * `ElicitationStorage` in `@atlas/core` — a JetStream stream + KV
 * bucket facade. Mounted at `/api/elicitations` from `atlas-daemon.ts`.
 *
 * Surface:
 *   - GET /              list with workspaceId/sessionId/status/kind filters
 *   - GET /:id           get one (404 if unknown)
 *   - GET /stream        Workspace-scoped SSE feed; subscribes to NATS
 *                        `elicitations.<wsid>.>` and forwards each envelope
 *                        as a `data:` frame
 *   - GET /stream/global Sanitized global SSE feed; subscribes to NATS
 *                        `elicitations.>` but strips sensitive fields
 *   - POST /:id/answer   { value, note?, answeredBy? } — server fills
 *                        `answeredAt`; flips status to `answered`
 *   - POST /:id/decline  { note? } — flips status to `declined`
 */

import {
  ElicitationKindSchema,
  ElicitationSchema,
  ElicitationStatusSchema,
  ElicitationStorage,
  ElicitationSummarySchema,
  ToolAccessGrants,
} from "@atlas/core";
import { createLogger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { daemonFactory } from "../../src/factory.ts";
import { errorResponseSchema } from "../../src/utils.ts";

const elicitationApp = daemonFactory.createApp();
const logger = createLogger({ component: "elicitation-routes" });

const enc = new TextEncoder();

/** Subjects use `[A-Za-z0-9_-]` only (jetstream-adapter sanitizes ids). */
const SAFE_TOKEN_RE = /[^A-Za-z0-9_-]/g;
function sanitizeToken(s: string): string {
  return s.replace(SAFE_TOKEN_RE, "_");
}

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
      const { workspaceId, sessionId, status, kind } = c.req.valid("query");
      const result = await ElicitationStorage.list({
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(status !== undefined ? { status } : {}),
      });
      if (!result.ok) {
        return c.json({ error: result.error }, 500);
      }
      // The storage layer doesn't filter by `kind` (no direct support),
      // so apply the filter here for parity with the documented surface.
      const elicitations =
        kind === undefined ? result.data : result.data.filter((e) => e.kind === kind);
      return c.json({ elicitations, count: elicitations.length });
    } catch (error) {
      return c.json({ error: stringifyError(error) }, 500);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /stream — SSE feed
// ---------------------------------------------------------------------------

const StreamQuerySchema = z.object({ workspaceId: z.string().min(1) });

elicitationApp.get(
  "/stream",
  describeRoute({
    tags: ["Elicitations"],
    summary: "Subscribe to live elicitation events (SSE)",
    description:
      "Server-sent events feed of elicitation envelopes published to " +
      "`elicitations.<workspaceId>.<sessionId>.<id>`. `workspaceId` is " +
      "required so clients cannot passively subscribe to all workspaces. " +
      "Each event arrives as a `data:` frame containing the full envelope JSON.",
    responses: {
      200: {
        description:
          "SSE stream (text/event-stream). Each frame is a JSON-encoded Elicitation envelope.",
      },
      400: {
        description: "workspaceId query parameter is required",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
      503: {
        description: "NATS connection not ready",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  validator("query", StreamQuerySchema),
  async (c) => {
    const { workspaceId } = c.req.valid("query");
    const ctx = c.get("app");
    const nc = ctx.daemon.getNatsConnection();
    if (!nc) return c.json({ error: "NATS connection not ready" }, 503);

    const subject = `elicitations.${sanitizeToken(workspaceId)}.>`;
    const sub = nc.subscribe(subject);
    // `subscribe()` returns before the broker registers the subscription;
    // flush forces a PING/PONG round-trip so the SSE handshake honestly
    // means "from now on, every event published to this subject."
    await nc.flush();

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        c.req.raw.signal.addEventListener("abort", () => {
          try {
            sub.unsubscribe();
          } catch {
            // already gone
          }
          try {
            controller.close();
          } catch {
            // already closed
          }
        });

        void (async () => {
          try {
            for await (const msg of sub) {
              const payload = msg.string();
              controller.enqueue(enc.encode(`data: ${payload}\n\n`));
            }
          } catch {
            // for-await exited early — controller cancel can land before
            // the abort listener fires. Fall through to the finally
            // teardown so we never leak the NATS subscription.
          } finally {
            try {
              sub.unsubscribe();
            } catch {
              // already gone
            }
            try {
              controller.close();
            } catch {
              // already closed
            }
          }
        })();
      },
    });

    return c.body(body, 200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
  },
);

// ---------------------------------------------------------------------------
// GET /stream/global — sanitized global SSE feed
// ---------------------------------------------------------------------------

elicitationApp.get(
  "/stream/global",
  describeRoute({
    tags: ["Elicitations"],
    summary: "Subscribe to sanitized global elicitation updates (SSE)",
    description:
      "Server-sent events feed for global Activity/sidebar invalidation. " +
      "Subscribes to all elicitation subjects but emits only metadata fields " +
      "and never includes question text, pendingTool.args, options, or answers.",
    responses: {
      200: {
        description:
          "SSE stream (text/event-stream). Each frame is a JSON-encoded ElicitationSummary.",
      },
      503: {
        description: "NATS connection not ready",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const ctx = c.get("app");
    const nc = ctx.daemon.getNatsConnection();
    if (!nc) return c.json({ error: "NATS connection not ready" }, 503);

    const sub = nc.subscribe("elicitations.>");
    await nc.flush();

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        c.req.raw.signal.addEventListener("abort", () => {
          try {
            sub.unsubscribe();
          } catch {
            // already gone
          }
          try {
            controller.close();
          } catch {
            // already closed
          }
        });

        void (async () => {
          try {
            for await (const msg of sub) {
              let raw: unknown;
              try {
                raw = JSON.parse(msg.string());
              } catch (error) {
                logger.warn("Dropping non-JSON elicitation event from global stream", {
                  error: stringifyError(error),
                });
                continue;
              }
              const parsed = ElicitationSchema.safeParse(raw);
              if (!parsed.success) {
                logger.warn("Dropping invalid elicitation event from global stream", {
                  error: parsed.error.message,
                });
                continue;
              }
              const safe = ElicitationSummarySchema.parse(parsed.data);
              controller.enqueue(enc.encode(`data: ${JSON.stringify(safe)}\n\n`));
            }
          } catch {
            // for-await exited early — controller cancel can land before
            // the abort listener fires. Fall through to teardown.
          } finally {
            try {
              sub.unsubscribe();
            } catch {
              // already gone
            }
            try {
              controller.close();
            } catch {
              // already closed
            }
          }
        })();
      },
    });

    return c.body(body, 200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
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
      return c.json(result.data);
    } catch (error) {
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

      const result = await ElicitationStorage.decline({
        id,
        ...(body.note !== undefined ? { note: body.note } : {}),
      });
      if (!result.ok) return c.json({ error: result.error }, 500);
      return c.json(result.data);
    } catch (error) {
      return c.json({ error: stringifyError(error) }, 500);
    }
  },
);

export { elicitationApp };

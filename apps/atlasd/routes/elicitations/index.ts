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

import { join } from "node:path";
import {
  type Elicitation,
  ElicitationKindSchema,
  ElicitationSchema,
  ElicitationStatusSchema,
  ElicitationStorage,
  ToolAccessGrants,
  WorkspaceSetupAnswerValueSchema,
} from "@atlas/core";
import { createLogger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { setEnvFileVar } from "@atlas/workspace";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { commitGlobalEnvWrite } from "../../src/env-commit.ts";
import type { AppVariables } from "../../src/factory.ts";
import { daemonFactory } from "../../src/factory.ts";
import { commitWorkspaceSetupAnswer } from "../../src/setup-answer-handler.ts";
import { errorResponseSchema } from "../../src/utils.ts";
import { getAccessibleWorkspaceIds, requireWorkspaceMember } from "../../src/workspace-authz.ts";

/**
 * Shape of an `env-write` elicitation's `pendingTool.args`.
 *
 * Note: the write's target workspace is taken from the *elicitation envelope*
 * (`elicitation.workspaceId`), never from the tool args — the envelope is
 * server-controlled at create time, the args are not. A `workspace`-scoped
 * write can therefore only ever touch the elicitation's own workspace.
 */
const EnvWriteArgsSchema = z.object({
  scope: z.enum(["workspace", "global"]),
  vars: z.record(z.string(), z.string()),
});

/**
 * Apply a confirmed `env-write` elicitation. A chat turn can't block on the
 * user, so `env_set` only proposes — the actual write lands here.
 *
 * Called *before* the elicitation is marked answered: the write must succeed
 * for "answered" to be honest. A failure returns `{ ok: false }` so the
 * caller can 500 and leave the elicitation `pending` for the user to retry
 * (`setEnvFileVar` / `commitGlobalEnvWrite` are idempotent, so retry is safe).
 */
async function commitEnvWriteElicitation(
  c: Context<AppVariables>,
  elicitation: Elicitation,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = EnvWriteArgsSchema.safeParse(elicitation.pendingTool?.args);
  if (!parsed.success) {
    logger.error("env-write elicitation has malformed pendingTool args", {
      id: elicitation.id,
      error: parsed.error.message,
    });
    return { ok: false, error: `malformed env-write args: ${parsed.error.message}` };
  }
  const { scope, vars } = parsed.data;
  const keys = Object.keys(vars);

  try {
    if (scope === "global") {
      for (const [key, value] of Object.entries(vars)) commitGlobalEnvWrite(key, value);
      logger.info("env-write elicitation applied (global)", { id: elicitation.id, keys });
      return { ok: true };
    }
    // workspace scope — the write target is the elicitation's own workspace,
    // taken from the server-controlled envelope, not from tool args.
    const wsId = elicitation.workspaceId;
    const workspace = await c.get("app").getWorkspaceManager().find({ id: wsId });
    if (!workspace) {
      logger.error("env-write elicitation: workspace not found", {
        id: elicitation.id,
        workspaceId: wsId,
      });
      return { ok: false, error: `workspace '${wsId}' not found` };
    }
    const envPath = join(workspace.path, ".env");
    for (const [key, value] of Object.entries(vars)) setEnvFileVar(envPath, key, value);
    logger.info("env-write elicitation applied (workspace)", {
      id: elicitation.id,
      workspaceId: wsId,
      keys,
    });
    return { ok: true };
  } catch (error) {
    const message = stringifyError(error);
    logger.error("env-write elicitation commit failed", { id: elicitation.id, error: message });
    return { ok: false, error: message };
  }
}

/**
 * Apply a confirmed `workspace-setup` elicitation. Mirrors the pre-flight,
 * commit, then restart shape from the design doc (Decision 6):
 *
 *   1. Resolve workspace + parsed config off the manager.
 *   2. Re-parse the answer value as `WorkspaceSetupAnswerValueSchema` —
 *      `AnswerBodySchema` already validates the union, but re-parse here
 *      shrinks the type from the union to the structured shape without an
 *      assertion cast.
 *   3. Pre-flight + commit via `commitWorkspaceSetupAnswer`.
 *   4. Restart signals so the setup gate re-evaluates and any deferred
 *      schedule / fs-watch registrations land.
 *
 * Returns `{ ok: true }` to let the caller fall through to
 * `ElicitationStorage.answer`; otherwise returns a fully-formed JSON Response
 * for the caller to early-return.
 */
async function commitWorkspaceSetupElicitation(
  c: Context<AppVariables>,
  elicitation: Elicitation,
  rawValue:
    | string
    | { variableValues: Record<string, unknown>; credentialChoices: Record<string, string> },
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const parsedValue = WorkspaceSetupAnswerValueSchema.safeParse(rawValue);
  if (!parsedValue.success) {
    return {
      ok: false,
      response: c.json(
        { error: `workspace-setup answer value malformed: ${parsedValue.error.message}` },
        400,
      ),
    };
  }

  const manager = c.get("app").getWorkspaceManager();
  const workspace = await manager.find({ id: elicitation.workspaceId });
  if (!workspace) {
    logger.error("workspace-setup elicitation: workspace not found", {
      id: elicitation.id,
      workspaceId: elicitation.workspaceId,
    });
    return {
      ok: false,
      response: c.json({ error: `workspace '${elicitation.workspaceId}' not found` }, 500),
    };
  }

  const merged = await manager.getWorkspaceConfig(elicitation.workspaceId);
  if (!merged) {
    logger.error("workspace-setup elicitation: workspace config not loadable", {
      id: elicitation.id,
      workspaceId: elicitation.workspaceId,
    });
    return {
      ok: false,
      response: c.json(
        { error: `workspace '${elicitation.workspaceId}' config not loadable` },
        500,
      ),
    };
  }

  const outcome = await commitWorkspaceSetupAnswer({
    workspacePath: workspace.path,
    parsedConfig: merged.workspace,
    answer: parsedValue.data,
  });

  if (!outcome.ok && outcome.status === 400) {
    return { ok: false, response: c.json({ error: "validation_failed", ...outcome.errors }, 400) };
  }
  if (!outcome.ok) {
    return {
      ok: false,
      response: c.json({ error: outcome.message, committedKeys: outcome.committedKeys }, 500),
    };
  }

  // Post-commit: re-derive the setup gate and (re-)register schedule +
  // fs-watch signals. `handleWorkspaceConfigChange` is the public entrypoint
  // that routes through the same `restartSignalsForWorkspace` path the
  // file-watcher uses, so the gate from T13 sees the updated env + config.
  try {
    const entry = await manager.find({ id: elicitation.workspaceId });
    if (entry) await manager.handleWorkspaceConfigChange(entry, entry.configPath);
  } catch (err) {
    // Best-effort: a restart hiccup must not leave the elicitation pending
    // after a successful commit. The next workspace config change will
    // reconcile.
    logger.warn("workspace-setup post-commit signal restart failed", {
      id: elicitation.id,
      workspaceId: elicitation.workspaceId,
      error: stringifyError(err),
    });
  }

  return { ok: true };
}

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

/**
 * Answer body. `value` is a plain string for the option-style kinds
 * (`tool-allowlist`, `auth-refresh`, `confirm-action`, `open-question`,
 * `env-write`) and a structured `{ variableValues, credentialChoices }`
 * object for `workspace-setup`. Mirrors `ElicitationAnswerSchema.value`.
 */
const AnswerBodySchema = z.object({
  value: z.union([z.string(), WorkspaceSetupAnswerValueSchema]),
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

      // For env-write confirmations the write must land *before* the
      // elicitation is marked answered — "answered" has to mean "applied".
      // A commit failure leaves the elicitation pending so the user can
      // retry; the per-key writers are idempotent, so retry is safe.
      //
      // The inverse — commit succeeds, then `answer` below fails — leaves the
      // write applied while the elicitation stays `pending`. That's the
      // accepted asymmetry: the write IS done (idempotent, so a retry confirm
      // is a no-op), and a stuck-`pending` elicitation is a far better failure
      // than a silently-lost write. There is no compensating rollback.
      if (got.data.kind === "env-write" && body.value === "confirm") {
        const commit = await commitEnvWriteElicitation(c, got.data);
        if (!commit.ok) {
          return c.json({ error: `env write failed: ${commit.error}` }, 500);
        }
      }

      // workspace-setup follows the same commit-before-`answer` ordering as
      // env-write, but on a richer payload. Pre-flight validates everything
      // and only then writes; a post-pre-flight failure (concurrent
      // credential deletion etc.) leaves the elicitation `pending` and
      // returns the env keys that already committed so the caller's retry is
      // idempotent. Decision 6.
      if (got.data.kind === "workspace-setup") {
        const setupOutcome = await commitWorkspaceSetupElicitation(c, got.data, body.value);
        if (!setupOutcome.ok) return setupOutcome.response;
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
      // env-write commits happen *before* `answer` above — so by here, an
      // answered+confirm env-write elicitation is genuinely applied.
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

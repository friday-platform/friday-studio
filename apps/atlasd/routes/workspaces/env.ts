/**
 * Workspace `.env` daemon routes.
 *
 * Per-key CRUD over `workspaces/:id/.env` — the per-workspace store of
 * non-secret env values. Backed by the comment-preserving line editor in
 * `@atlas/workspace`, so a single-key write never disturbs comments or other
 * keys (unlike the daemon-global bulk `PUT /env`, which re-stringifies the
 * whole file).
 *
 * Values are returned raw — the agent-facing env tools mask secret-looking
 * keys before they reach an LLM; the settings UI does its own client-side
 * masking. Authz is workspace-member, matching the memory routes.
 *
 * Handlers are inline (not extracted) so Hono's `c.req.valid()` inference
 * picks up the zValidator schemas — see apps/atlasd/CLAUDE.md.
 */

import { join } from "node:path";
import { createLogger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { deleteEnvFileVar, loadEnvFile, setEnvFileVar } from "@atlas/workspace";
import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import { z } from "zod";
import type { AppVariables } from "../../src/factory.ts";
import { daemonFactory } from "../../src/factory.ts";
import { requireWorkspaceMember } from "../../src/workspace-authz.ts";

const logger = createLogger({ component: "workspace-env-routes" });

/**
 * Env var keys are POSIX identifiers. Tighter than what `@std/dotenv` accepts
 * on read — a key with a newline could smuggle extra lines into the file.
 */
const KeyParamSchema = z.object({
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "env var keys must be POSIX identifiers"),
});

/** Values must be single-line — the line-based editor can't represent CR/LF. */
const ValueBodySchema = z.object({
  value: z.string().regex(/^[^\r\n]*$/, "env var values must not contain newlines"),
});

/**
 * Resolve a workspace's `.env` path. Returns `null` when the workspace is not
 * registered — the caller turns that into a 404.
 */
async function resolveWorkspaceEnvPath(
  c: Context<AppVariables>,
  workspaceId: string,
): Promise<string | null> {
  const workspace = await c.get("app").getWorkspaceManager().find({ id: workspaceId });
  if (!workspace) return null;
  return join(workspace.path, ".env");
}

const workspaceEnvRoutes = daemonFactory
  .createApp()
  .get("/", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) {
      return c.json({ success: false, error: "bad_request", message: "Missing workspaceId" }, 400);
    }
    await requireWorkspaceMember(c, workspaceId);

    const envPath = await resolveWorkspaceEnvPath(c, workspaceId);
    if (!envPath) {
      return c.json({ success: false, error: "not_found", message: "Workspace not found" }, 404);
    }
    // Absent file → empty overlay (lazy-on-write), not an error.
    return c.json({ success: true, env: loadEnvFile(envPath) });
  })
  .get("/:key", zValidator("param", KeyParamSchema), async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const { key } = c.req.valid("param");
    if (!workspaceId) {
      return c.json({ success: false, error: "bad_request", message: "Missing workspaceId" }, 400);
    }
    await requireWorkspaceMember(c, workspaceId);

    const envPath = await resolveWorkspaceEnvPath(c, workspaceId);
    if (!envPath) {
      return c.json({ success: false, error: "not_found", message: "Workspace not found" }, 404);
    }
    const value = loadEnvFile(envPath)[key];
    if (value === undefined) {
      return c.json({ success: false, error: "not_found", message: `'${key}' is not set` }, 404);
    }
    return c.json({ success: true, key, value });
  })
  .put(
    "/:key",
    zValidator("param", KeyParamSchema),
    zValidator("json", ValueBodySchema),
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const { key } = c.req.valid("param");
      const { value } = c.req.valid("json");
      if (!workspaceId) {
        return c.json(
          { success: false, error: "bad_request", message: "Missing workspaceId" },
          400,
        );
      }
      await requireWorkspaceMember(c, workspaceId);

      const envPath = await resolveWorkspaceEnvPath(c, workspaceId);
      if (!envPath) {
        return c.json({ success: false, error: "not_found", message: "Workspace not found" }, 404);
      }
      try {
        setEnvFileVar(envPath, key, value);
        logger.info("Workspace env var set", { workspaceId, key });
        return c.json({ success: true, key });
      } catch (error) {
        logger.error("Failed to set workspace env var", { workspaceId, key, error });
        return c.json({ success: false, error: "internal", message: stringifyError(error) }, 500);
      }
    },
  )
  .delete("/:key", zValidator("param", KeyParamSchema), async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const { key } = c.req.valid("param");
    if (!workspaceId) {
      return c.json({ success: false, error: "bad_request", message: "Missing workspaceId" }, 400);
    }
    await requireWorkspaceMember(c, workspaceId);

    const envPath = await resolveWorkspaceEnvPath(c, workspaceId);
    if (!envPath) {
      return c.json({ success: false, error: "not_found", message: "Workspace not found" }, 404);
    }
    try {
      const removed = deleteEnvFileVar(envPath, key);
      logger.info("Workspace env var delete", { workspaceId, key, removed });
      return c.json({ success: true, key, removed });
    } catch (error) {
      logger.error("Failed to delete workspace env var", { workspaceId, key, error });
      return c.json({ success: false, error: "internal", message: stringifyError(error) }, 500);
    }
  });

export { workspaceEnvRoutes };
export type WorkspaceEnvRoutes = typeof workspaceEnvRoutes;

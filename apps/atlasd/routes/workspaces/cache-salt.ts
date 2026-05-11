/**
 * Workspace prompt-cache salt — read + bump.
 *
 * Mounted at `/api/workspaces/:workspaceId` so the routes resolve as:
 *   GET  /api/workspaces/:workspaceId/_cache-salt
 *   POST /api/workspaces/:workspaceId/_bump-cache-salt
 *
 * The chat handler reads the salt and embeds it in system block 2.
 * The /debug page calls the POST endpoint when an operator clicks the
 * "Force fresh cache next turn" button — the bump invalidates every
 * chat in the workspace's cached prefix from block 2 onward.
 *
 * Plain Hono<AppVariables> instead of the daemonFactory chain — same
 * reasoning as `chat-debug.ts`: keeping these routes off the deep
 * factory chain avoids TS2589 inference depth issues.
 */

import { bumpWorkspaceCacheSalt, getWorkspaceCacheSalt } from "@atlas/core/chat/cache-salt-storage";
import { Hono } from "hono";
import type { AppVariables } from "../../src/factory.ts";
import { requireWorkspaceAdmin, requireWorkspaceMember } from "../../src/workspace-authz.ts";

const workspaceCacheSaltRoutes: Hono<AppVariables> = new Hono<AppVariables>()
  .get("/_cache-salt", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) return c.json({ error: "Missing workspaceId" }, 400);
    await requireWorkspaceMember(c, workspaceId);
    const ctx = c.get("app");
    let nc: ReturnType<typeof ctx.daemon.getNatsConnection>;
    try {
      nc = ctx.daemon.getNatsConnection();
    } catch {
      return c.json({ error: "NATS not initialized" }, 503);
    }
    const salt = await getWorkspaceCacheSalt(nc, workspaceId);
    return c.json({ workspaceId, salt });
  })
  .post("/_bump-cache-salt", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) return c.json({ error: "Missing workspaceId" }, 400);
    await requireWorkspaceAdmin(c, workspaceId);
    const ctx = c.get("app");
    let nc: ReturnType<typeof ctx.daemon.getNatsConnection>;
    try {
      nc = ctx.daemon.getNatsConnection();
    } catch {
      return c.json({ error: "NATS not initialized" }, 503);
    }
    const salt = await bumpWorkspaceCacheSalt(nc, workspaceId);
    return c.json({ workspaceId, salt });
  });

export default workspaceCacheSaltRoutes;

/**
 * Workspace variables daemon route.
 *
 * `GET /api/workspaces/:wsId/variables` returns one fully-resolved row per
 * declared variable (declaration + raw env value + effective value + filled
 * status + optional validation error). Composes
 * `manager.getWorkspaceConfig(workspaceId)` with `loadEnvFile(envPath)` and
 * delegates per-variable resolution to `resolveVariableState` from
 * `@atlas/workspace` so this surface, the bootstrap setup card, and
 * `resolveWorkspaceSetupRequirements` cannot drift apart.
 *
 * Workspace with no `variables:` block is a 200 with `variables: []`, not a
 * 404 — the client renders an empty group without special-casing.
 */

import { join } from "node:path";
import {
  loadEnvFile,
  resolveVariableState,
  type VariableState,
  variableEnvKey,
} from "@atlas/workspace";
import { daemonFactory } from "../../src/factory.ts";
import { requireWorkspaceMember } from "../../src/workspace-authz.ts";

const workspaceVariablesRoutes = daemonFactory.createApp().get("/", async (c) => {
  const workspaceId = c.req.param("workspaceId");
  if (!workspaceId) {
    return c.json({ success: false, error: "bad_request", message: "Missing workspaceId" }, 400);
  }
  await requireWorkspaceMember(c, workspaceId);

  const manager = c.get("app").getWorkspaceManager();
  const workspace = await manager.find({ id: workspaceId });
  if (!workspace) {
    return c.json({ success: false, error: "not_found", message: "Workspace not found" }, 404);
  }

  const merged = await manager.getWorkspaceConfig(workspaceId);
  if (!merged) {
    return c.json({ success: false, error: "not_found", message: "Workspace not found" }, 404);
  }

  const declarations = merged.workspace.variables ?? {};
  const envSnapshot = loadEnvFile(join(workspace.path, ".env"));
  const variables: VariableState[] = Object.entries(declarations).map(([name, decl]) =>
    resolveVariableState(name, decl, envSnapshot[variableEnvKey(name)]),
  );

  return c.json({ success: true, variables });
});

export { workspaceVariablesRoutes };
export type WorkspaceVariablesRoutes = typeof workspaceVariablesRoutes;

/**
 * Workspace MCP daemon routes.
 *
 * Provides workspace-scoped endpoints for viewing and mutating MCP server
 * enablement: GET status, PUT enable, DELETE disable.
 *
 * Reads from and writes to workspace.yml directly (legacy path). Blueprint-
 * linked workspaces are blocked from direct mutations — the blueprint recompile
 * path is the source of truth for those.
 */

import type { MCPServerConfig } from "@atlas/agent-sdk";
import type { WorkspaceConfig } from "@atlas/config";
import { applyMutation, disableMCPServer, enableMCPServer } from "@atlas/config/mutations";
import { discoverMCPServers } from "@atlas/core/mcp-registry/discovery";
import { getWorkspaceMCPStatus } from "@atlas/core/mcp-registry/workspace-mcp";
import { createLogger } from "@atlas/logger";
import { storeWorkspaceHistory } from "@atlas/storage";
import { stringifyError } from "@atlas/utils";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AppVariables } from "../../src/factory.ts";
import { daemonFactory } from "../../src/factory.ts";
import { mapMutationError } from "./mutation-errors.ts";

const logger = createLogger({ component: "workspace-mcp-routes" });

// =============================================================================
// SCHEMAS
// =============================================================================

const ServerIdParamSchema = z.object({ serverId: z.string().min(1) });

// =============================================================================
// SHARED GUARDS
// =============================================================================

/** System workspace guard — mutations are forbidden on system workspaces. */
function isSystemWorkspace(workspace: { metadata?: Record<string, unknown> }): boolean {
  if (workspace.metadata?.canonical === "system") return true;
  if (workspace.metadata?.system && workspace.metadata?.canonical !== "personal") return true;
  return false;
}

/** Blueprint workspace guard — direct config mutations return 422. */
function isBlueprintWorkspace(workspace: { metadata?: Record<string, unknown> }): boolean {
  return !!workspace.metadata?.blueprintArtifactId;
}

// =============================================================================
// GET /api/workspaces/:workspaceId/mcp
// =============================================================================

const handleGetMCPStatus = async (c: import("hono").Context<AppVariables>) => {
  const workspaceId = c.req.param("workspaceId");
  if (!workspaceId) {
    return c.json({ success: false, error: "bad_request", message: "Missing workspaceId" }, 400);
  }
  const ctx = c.get("app");

  try {
    const manager = ctx.getWorkspaceManager();
    const workspace = await manager.find({ id: workspaceId });
    if (!workspace) {
      return c.json(
        { success: false, error: "not_found", entityType: "workspace", entityId: workspaceId },
        404,
      );
    }

    const config = await manager.getWorkspaceConfig(workspace.id);
    if (!config) {
      return c.json(
        { success: false, error: "internal", message: "Failed to load workspace configuration" },
        500,
      );
    }

    const status = await getWorkspaceMCPStatus(workspaceId, config.workspace);
    return c.json(status);
  } catch (error) {
    logger.error("Failed to get workspace MCP status", {
      workspaceId,
      error: stringifyError(error),
    });
    return c.json(
      {
        success: false,
        error: "internal",
        message: `Failed to get workspace MCP status: ${stringifyError(error)}`,
      },
      500,
    );
  }
};

// =============================================================================
// PUT /api/workspaces/:workspaceId/mcp/:serverId
// =============================================================================

const handleEnableMCPServer = async (c: import("hono").Context<AppVariables>) => {
  const workspaceId = c.req.param("workspaceId");
  const serverId = c.req.param("serverId");
  if (!workspaceId || !serverId) {
    return c.json(
      { success: false, error: "bad_request", message: "Missing workspaceId or serverId" },
      400,
    );
  }
  const ctx = c.get("app");

  try {
    const manager = ctx.getWorkspaceManager();
    const workspace = await manager.find({ id: workspaceId });
    if (!workspace) {
      return c.json(
        { success: false, error: "not_found", entityType: "workspace", entityId: workspaceId },
        404,
      );
    }

    if (isSystemWorkspace(workspace)) {
      return c.json(
        { success: false, error: "forbidden", message: "Cannot modify system workspace" },
        403,
      );
    }

    if (isBlueprintWorkspace(workspace)) {
      return c.json(
        {
          success: false,
          error: "not_supported",
          message:
            "This workspace uses a blueprint — direct config mutations are not supported. " +
            "Use the blueprint mutation path instead.",
        },
        422,
      );
    }

    const config = await manager.getWorkspaceConfig(workspace.id);
    if (!config) {
      return c.json(
        { success: false, error: "internal", message: "Failed to load workspace configuration" },
        500,
      );
    }

    // Idempotent check — if already enabled, return 200 immediately
    const existingServers = config.workspace.tools?.mcp?.servers ?? {};
    if (serverId in existingServers) {
      // Still need catalog metadata for the name; discover with explicit config
      const candidates = await discoverMCPServers(workspaceId, config.workspace);
      const candidate = candidates.find((c) => c.metadata.id === serverId);
      const name = candidate?.metadata.name ?? serverId;
      return c.json({ server: { id: serverId, name } }, 200);
    }

    // Look up server in consolidated catalog
    const candidates = await discoverMCPServers(workspaceId, config.workspace);
    const candidate = candidates.find((c) => c.metadata.id === serverId);
    if (!candidate) {
      return c.json(
        { success: false, error: "not_found", entityType: "mcp server", entityId: serverId },
        404,
      );
    }

    const mutationFn = (cfg: WorkspaceConfig) =>
      enableMCPServer(cfg, serverId, candidate.metadata.configTemplate as MCPServerConfig);

    const result = await applyMutation(workspace.path, mutationFn, {
      onBeforeWrite: async () => {
        await storeWorkspaceHistory(workspace, config.workspace, "partial-update", {
          throwOnError: true,
        });
      },
    });

    if (!result.ok) {
      return mapMutationError(c, result.error);
    }

    // Destroy runtime if active so next request picks up new tools.mcp.servers
    if (ctx.getWorkspaceRuntime(workspace.id)) {
      await ctx.destroyWorkspaceRuntime(workspace.id);
    }

    return c.json({ server: { id: serverId, name: candidate.metadata.name } }, 200);
  } catch (error) {
    logger.error("Failed to enable MCP server", {
      workspaceId,
      serverId,
      error: stringifyError(error),
    });
    return c.json(
      {
        success: false,
        error: "internal",
        message: `Failed to enable MCP server: ${stringifyError(error)}`,
      },
      500,
    );
  }
};

// =============================================================================
// DELETE /api/workspaces/:workspaceId/mcp/:serverId
// =============================================================================

const handleDisableMCPServer = async (c: import("hono").Context<AppVariables>) => {
  const workspaceId = c.req.param("workspaceId");
  const serverId = c.req.param("serverId");
  const force = c.req.query("force") === "true";
  if (!workspaceId || !serverId) {
    return c.json(
      { success: false, error: "bad_request", message: "Missing workspaceId or serverId" },
      400,
    );
  }
  const ctx = c.get("app");

  try {
    const manager = ctx.getWorkspaceManager();
    const workspace = await manager.find({ id: workspaceId });
    if (!workspace) {
      return c.json(
        { success: false, error: "not_found", entityType: "workspace", entityId: workspaceId },
        404,
      );
    }

    if (isSystemWorkspace(workspace)) {
      return c.json(
        { success: false, error: "forbidden", message: "Cannot modify system workspace" },
        403,
      );
    }

    if (isBlueprintWorkspace(workspace)) {
      return c.json(
        {
          success: false,
          error: "not_supported",
          message:
            "This workspace uses a blueprint — direct config mutations are not supported. " +
            "Use the blueprint mutation path instead.",
        },
        422,
      );
    }

    const config = await manager.getWorkspaceConfig(workspace.id);
    if (!config) {
      return c.json(
        { success: false, error: "internal", message: "Failed to load workspace configuration" },
        500,
      );
    }

    const mutationFn = (cfg: WorkspaceConfig) => disableMCPServer(cfg, serverId, { force });

    const result = await applyMutation(workspace.path, mutationFn, {
      onBeforeWrite: async () => {
        await storeWorkspaceHistory(workspace, config.workspace, "partial-update", {
          throwOnError: true,
        });
      },
    });

    if (!result.ok) {
      if (result.error.type === "not_found") {
        return c.json(
          { success: false, error: "not_found", entityType: "mcp server", entityId: serverId },
          404,
        );
      }
      if (result.error.type === "conflict") {
        return mapMutationError(
          c,
          result.error,
          `Server is referenced by ${result.error.willUnlinkFrom.length} ${result.error.willUnlinkFrom.length === 1 ? "entity" : "entities"}. Use ?force=true to cascade delete.`,
        );
      }
      return mapMutationError(c, result.error);
    }

    if (ctx.getWorkspaceRuntime(workspace.id)) {
      await ctx.destroyWorkspaceRuntime(workspace.id);
    }

    return c.json({ removed: serverId }, 200);
  } catch (error) {
    logger.error("Failed to disable MCP server", {
      workspaceId,
      serverId,
      error: stringifyError(error),
    });
    return c.json(
      {
        success: false,
        error: "internal",
        message: `Failed to disable MCP server: ${stringifyError(error)}`,
      },
      500,
    );
  }
};

// =============================================================================
// ROUTE DEFINITIONS
// =============================================================================

const mcpRoutes = daemonFactory
  .createApp()
  .get("/", handleGetMCPStatus)
  .put("/:serverId", zValidator("param", ServerIdParamSchema), handleEnableMCPServer)
  .delete("/:serverId", zValidator("param", ServerIdParamSchema), handleDisableMCPServer);

export { mcpRoutes };
export type WorkspaceMCPRoutes = typeof mcpRoutes;

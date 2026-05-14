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

import { join } from "node:path";
import type { LinkCredentialRef, MCPServerConfig } from "@atlas/agent-sdk";
import type { WorkspaceConfig } from "@atlas/config";
import { disableMCPServer, enableMCPServer, setMCPServerEnvWiring } from "@atlas/config/mutations";
import { readEnvVar } from "@atlas/core";
import { discoverMCPServers } from "@atlas/core/mcp-registry/discovery";
import { splitLiteralEnvValues } from "@atlas/core/mcp-registry/env-routing";
import { getWorkspaceMCPStatus } from "@atlas/core/mcp-registry/workspace-mcp";
import { createLogger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { loadEnvFile, setEnvFileVar } from "@atlas/workspace";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AppVariables } from "../../src/factory.ts";
import { daemonFactory } from "../../src/factory.ts";
import { requireWorkspaceAdmin, requireWorkspaceMember } from "../../src/workspace-authz.ts";
import { applyDraftAwareMutation, getEditableConfig } from "./draft-helpers.ts";
import { mapMutationError } from "./mutation-errors.ts";

const logger = createLogger({ component: "workspace-mcp-routes" });

// =============================================================================
// SCHEMAS
// =============================================================================

const ServerIdParamSchema = z.object({ serverId: z.string().min(1) });

const DeleteQuerySchema = z.object({ force: z.literal("true").optional() });

const ServerEnvParamSchema = z.object({
  serverId: z.string().min(1),
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "env var keys must be POSIX identifiers"),
});

const ServerEnvBodySchema = z.object({
  value: z.string().regex(/^[^\r\n]*$/, "env var values must not contain newlines"),
});

// =============================================================================
// SHARED GUARDS
// =============================================================================

/** System workspace guard — mutations are forbidden on system workspaces. */
function isSystemWorkspace(workspace: { metadata?: Record<string, unknown> }): boolean {
  if (workspace.metadata?.canonical === "system") return true;
  if (workspace.metadata?.system && workspace.metadata?.canonical !== "personal") return true;
  return false;
}

// =============================================================================
// COPY-ON-ENABLE ENV SPLIT
// =============================================================================

/**
 * Drop `from_environment` / `auto` wiring for vars that resolve nowhere.
 *
 * `splitLiteralEnvValues` leaves magic-string wiring (`from_environment` /
 * `auto`) in place. But a registry template often declares optional env vars
 * the user has never set — wiring those into the workspace config makes them
 * *hard requirements*: `validateMCPEnvironmentForWorkspace` throws on any
 * unresolved magic-string entry, which aborts the whole workspace runtime.
 *
 * So a magic-string entry is kept only when the var actually resolves — it is
 * about to be written to the workspace `.env` (`pendingValues`), or it is
 * already set in `process.env` / the workspace `.env` overlay. Otherwise the
 * entry is dropped: the server still enables, it just doesn't declare a var
 * nothing can satisfy. Literal values and Link refs pass through untouched.
 */
function dropUnresolvableWiring(
  wiring: Record<string, string | LinkCredentialRef>,
  pendingValues: Record<string, string>,
  overlay: Record<string, string>,
): Record<string, string | LinkCredentialRef> {
  const kept: Record<string, string | LinkCredentialRef> = {};
  for (const [key, value] of Object.entries(wiring)) {
    if (value === "from_environment" || value === "auto") {
      if (key in pendingValues || readEnvVar(key, overlay) !== undefined) {
        kept[key] = value;
      }
      continue;
    }
    kept[key] = value;
  }
  return kept;
}

/**
 * Copy-on-enable env split. Lifts literal env values out of the registry
 * template — both the server `env` block and any `startup.env` sidecar block —
 * into a flat value map, leaving `from_environment` wiring behind, then drops
 * magic-string wiring for vars that resolve nowhere (see
 * {@link dropUnresolvableWiring}). The caller writes the lifted values to the
 * workspace `.env` once the enable mutation has landed, so the config copy
 * holds resolvable wiring only and the `.env` holds the values the settings
 * UI edits.
 */
function splitTemplateEnv(
  template: MCPServerConfig,
  overlay: Record<string, string>,
): { template: MCPServerConfig; envValues: Record<string, string> } {
  const envValues: Record<string, string> = {};
  // Spread, never reassign absent keys to `undefined` — `@std/yaml` throws on
  // an explicit `undefined` value when the config copy is written out.
  const prepared: MCPServerConfig = { ...template };

  if (template.env) {
    const split = splitLiteralEnvValues(template.env);
    prepared.env = dropUnresolvableWiring(split.wiring, split.values, overlay);
    Object.assign(envValues, split.values);
  }

  if (template.startup?.env) {
    const split = splitLiteralEnvValues(template.startup.env);
    prepared.startup = {
      ...template.startup,
      env: dropUnresolvableWiring(split.wiring, split.values, overlay),
    };
    Object.assign(envValues, split.values);
  }

  return { template: prepared, envValues };
}

/**
 * Write lifted env values into the workspace `.env`, skipping any key already
 * present — a value supplied earlier (shared by name with another server or
 * agent) is authoritative and is never clobbered by a fresh enable.
 */
function writeWorkspaceEnvValues(workspacePath: string, values: Record<string, string>): void {
  const keys = Object.keys(values);
  if (keys.length === 0) return;
  const envPath = join(workspacePath, ".env");
  const existing = loadEnvFile(envPath);
  for (const key of keys) {
    if (existing[key] === undefined) {
      setEnvFileVar(envPath, key, values[key] ?? "");
    }
  }
}

// =============================================================================
// GET /api/workspaces/:workspaceId/mcp
// =============================================================================

const handleGetMCPStatus = async (c: import("hono").Context<AppVariables>) => {
  const workspaceId = c.req.param("workspaceId");
  if (!workspaceId) {
    return c.json({ success: false, error: "bad_request", message: "Missing workspaceId" }, 400);
  }
  await requireWorkspaceMember(c, workspaceId);
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

    // Prefer editable config (draft if exists, live otherwise) so the MCP
    // status reflects staged changes during draft mode.
    let config: WorkspaceConfig;
    const editableResult = await getEditableConfig(workspace.path);
    if (editableResult.ok) {
      config = editableResult.value;
    } else {
      const liveConfig = await manager.getWorkspaceConfig(workspace.id);
      if (!liveConfig) {
        return c.json(
          { success: false, error: "internal", message: "Failed to load workspace configuration" },
          500,
        );
      }
      config = liveConfig.workspace;
    }

    const status = await getWorkspaceMCPStatus(workspaceId, config);
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
  await requireWorkspaceAdmin(c, workspaceId);
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

    const config = await manager.getWorkspaceConfig(workspace.id);
    if (!config) {
      return c.json(
        { success: false, error: "internal", message: "Failed to load workspace configuration" },
        500,
      );
    }

    // Load editable config (draft if exists, live otherwise) for idempotency and catalog lookup
    const editableResult = await getEditableConfig(workspace.path);
    if (!editableResult.ok) {
      return c.json({ success: false, error: "internal", message: editableResult.error }, 500);
    }
    const editableConfig = editableResult.value;

    // Idempotent check — if already enabled, return 200 immediately
    const existingServers = editableConfig.tools?.mcp?.servers ?? {};
    if (serverId in existingServers) {
      // Still need catalog metadata for the name; discover with explicit config
      const candidates = await discoverMCPServers(workspaceId, editableConfig);
      const candidate = candidates.find((c) => c.metadata.id === serverId);
      const name = candidate?.metadata.name ?? serverId;
      return c.json({ server: { id: serverId, name } }, 200);
    }

    // Look up server in consolidated catalog
    const candidates = await discoverMCPServers(workspaceId, editableConfig);
    const candidate = candidates.find((c) => c.metadata.id === serverId);
    if (!candidate) {
      return c.json(
        { success: false, error: "not_found", entityType: "mcp server", entityId: serverId },
        404,
      );
    }

    // An `unknown`-verdict entry installed but the doctor couldn't enumerate
    // its config — it must be manually configured before it can run.
    if (candidate.metadata.doctor_report?.verdict === "unknown") {
      return c.json({ success: false, error: "needs_manual_config", serverId }, 409);
    }

    // Copy-on-enable: snapshot the registry template into the workspace, but
    // split literal setting values out into the workspace `.env` so the config
    // copy holds `from_environment` wiring only — one coherent edit target for
    // the settings UI. The overlay lets the split drop wiring for vars that
    // resolve nowhere, so an optional template var can't brick the runtime.
    const workspaceEnvOverlay = loadEnvFile(join(workspace.path, ".env"));
    const { template: preparedTemplate, envValues } = splitTemplateEnv(
      candidate.metadata.configTemplate as MCPServerConfig,
      workspaceEnvOverlay,
    );

    const mutationFn = (cfg: WorkspaceConfig) => enableMCPServer(cfg, serverId, preparedTemplate);

    // Workspace config history (storeWorkspaceHistory) was Cortex-backed
    // and got deleted with the rest of the speculative remote-backend
    // infrastructure 2026-05-02. If audit-trail-on-config-write returns,
    // wire it as a new local primitive (or via JetStream) — don't
    // resurrect the Cortex shape.
    const { result } = await applyDraftAwareMutation(workspace.path, mutationFn);

    if (!result.ok) {
      return mapMutationError(c, result.error);
    }

    // Mutation landed — persist the lifted setting values into the workspace
    // `.env`. Done after the mutation so a failed enable leaves no orphans.
    writeWorkspaceEnvValues(workspace.path, envValues);

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
  await requireWorkspaceAdmin(c, workspaceId);
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

    const config = await manager.getWorkspaceConfig(workspace.id);
    if (!config) {
      return c.json(
        { success: false, error: "internal", message: "Failed to load workspace configuration" },
        500,
      );
    }

    const mutationFn = (cfg: WorkspaceConfig) => disableMCPServer(cfg, serverId, { force });

    // Workspace config history (storeWorkspaceHistory) was Cortex-backed
    // and got deleted with the rest of the speculative remote-backend
    // infrastructure 2026-05-02. If audit-trail-on-config-write returns,
    // wire it as a new local primitive (or via JetStream) — don't
    // resurrect the Cortex shape.
    const { result } = await applyDraftAwareMutation(workspace.path, mutationFn);

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
  .put("/:serverId", zValidator("param", ServerIdParamSchema), (c) => handleEnableMCPServer(c))
  // Set one of an enabled server's env values. Writes the value into the
  // workspace `.env` and points the config copy's `env` entry at it
  // (`from_environment`) — migrating a legacy literal in the process. Inline
  // handler so Hono's `c.req.valid()` inference works (see apps/atlasd/CLAUDE.md).
  .put(
    "/:serverId/env/:key",
    zValidator("param", ServerEnvParamSchema),
    zValidator("json", ServerEnvBodySchema),
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const { serverId, key } = c.req.valid("param");
      const { value } = c.req.valid("json");
      if (!workspaceId) {
        return c.json(
          { success: false, error: "bad_request", message: "Missing workspaceId" },
          400,
        );
      }
      await requireWorkspaceAdmin(c, workspaceId);
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
        // 1. Persist the value into the workspace `.env` — the value store.
        setEnvFileVar(join(workspace.path, ".env"), key, value);
        // 2. Point the config copy at `.env`; migrates a legacy literal entry.
        const { result } = await applyDraftAwareMutation(workspace.path, (cfg) =>
          setMCPServerEnvWiring(cfg, serverId, key),
        );
        if (!result.ok) {
          return mapMutationError(c, result.error);
        }
        return c.json({ ok: true }, 200);
      } catch (error) {
        logger.error("Failed to set MCP server env var", {
          workspaceId,
          serverId,
          key,
          error: stringifyError(error),
        });
        return c.json({ success: false, error: "internal", message: stringifyError(error) }, 500);
      }
    },
  )
  .delete(
    "/:serverId",
    zValidator("param", ServerIdParamSchema),
    zValidator("query", DeleteQuerySchema),
    (c) => handleDisableMCPServer(c),
  );

export { mcpRoutes };
export type WorkspaceMCPRoutes = typeof mcpRoutes;

/**
 * Shared helper for compiling a blueprint and writing the resulting workspace.yml.
 *
 * Extracted from the recompile endpoint so that blueprint-aware mutation handlers
 * can reuse the compile → write → reload cycle after mutating the blueprint.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MutationError, MutationResult } from "@atlas/config/mutations";
import { ArtifactStorage } from "@atlas/core/artifacts/server";
import type { MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";
import { getMCPRegistryAdapter } from "@atlas/core/mcp-registry/storage";
import { createLogger } from "@atlas/logger";
import { storeWorkspaceHistory } from "@atlas/storage";
import type { WorkspaceEntry } from "@atlas/workspace/types";
import type { WorkspaceBlueprint } from "@atlas/workspace-builder";
import { compileBlueprint, WorkspaceBlueprintSchema } from "@atlas/workspace-builder";
import type { Context } from "hono";
import type { AppContext, AppVariables } from "../../src/factory.ts";

const logger = createLogger({ component: "blueprint-recompile" });

export interface RecompileResult {
  ok: true;
  revision: number;
  runtimeReloaded: boolean;
}

export interface RecompileError {
  ok: false;
  error: string;
  status: 400 | 404 | 422 | 500;
}

/**
 * Load the blueprint artifact for a workspace.
 *
 * Resolves the artifact ID from workspace metadata, loads and parses the blueprint.
 * Returns the parsed blueprint and artifact metadata.
 */
export async function loadWorkspaceBlueprint(
  workspace: WorkspaceEntry,
): Promise<
  { ok: true; blueprint: WorkspaceBlueprint; artifactId: string; revision: number } | RecompileError
> {
  const artifactId = workspace.metadata?.blueprintArtifactId;
  if (!artifactId) {
    return {
      ok: false,
      error: "Workspace has no linked blueprint — cannot use blueprint mutation path",
      status: 400,
    };
  }

  const artifactResult = await ArtifactStorage.get({ id: artifactId });
  if (!artifactResult.ok) {
    return { ok: false, error: `Failed to load artifact: ${artifactResult.error}`, status: 500 };
  }
  const artifact = artifactResult.data;
  if (!artifact) {
    return { ok: false, error: `Artifact not found: ${artifactId}`, status: 404 };
  }
  if (artifact.type !== "workspace-plan") {
    return {
      ok: false,
      error: `Artifact is not a workspace plan (got: ${artifact.type})`,
      status: 400,
    };
  }
  if (artifact.data.version !== 2) {
    return {
      ok: false,
      error: `Unsupported blueprint version: ${artifact.data.version}. Only v2 is supported.`,
      status: 400,
    };
  }

  const blueprintParse = WorkspaceBlueprintSchema.safeParse(artifact.data.data);
  if (!blueprintParse.success) {
    return {
      ok: false,
      error: `Invalid blueprint data: ${blueprintParse.error.message}`,
      status: 400,
    };
  }

  return { ok: true, blueprint: blueprintParse.data, artifactId, revision: artifact.revision };
}

/**
 * Save a mutated blueprint back to artifact storage, recompile, and write workspace.yml.
 *
 * This is the full cycle:
 * 1. Load dynamic MCP servers
 * 2. Compile blueprint → YAML (validate before persisting)
 * 3. Save compiled blueprint to artifact storage
 * 4. Store workspace history
 * 5. Write workspace.yml
 * 6. Update workspace metadata with new revision
 * 7. Destroy runtime (hot reload)
 */
export async function saveAndRecompileBlueprint(
  workspace: WorkspaceEntry,
  blueprint: WorkspaceBlueprint,
  artifactId: string,
  ctx: AppContext,
  revisionMessage: string,
): Promise<RecompileResult | RecompileError> {
  // 1. Load dynamic MCP servers (non-fatal)
  let dynamicServers: MCPServerMetadata[] | undefined;
  try {
    const mcpAdapter = await getMCPRegistryAdapter();
    dynamicServers = await mcpAdapter.list();
  } catch {
    // Non-fatal — compile without dynamic servers
  }

  // 2. Compile blueprint → YAML (before saving, so broken blueprints aren't persisted)
  const compiled = compileBlueprint(blueprint, dynamicServers);
  if (!compiled.ok) {
    return { ok: false, error: `Compilation failed: ${compiled.error}`, status: 422 };
  }

  // 3. Save compiled blueprint to artifact storage
  const updateResult = await ArtifactStorage.update({
    id: artifactId,
    data: { type: "workspace-plan", version: 2, data: blueprint },
    summary: `Blueprint updated via UI: ${revisionMessage}`,
    revisionMessage,
  });
  if (!updateResult.ok) {
    return { ok: false, error: `Failed to save blueprint: ${updateResult.error}`, status: 500 };
  }
  const newRevision = updateResult.data?.revision ?? 0;

  // 4. Store history before overwriting
  const manager = ctx.getWorkspaceManager();
  const currentConfig = await manager.getWorkspaceConfig(workspace.id);
  if (currentConfig) {
    await storeWorkspaceHistory(workspace, currentConfig.workspace, "full-update", {
      throwOnError: true,
    });
  }

  // 5. Write workspace.yml
  const ymlPath = join(workspace.path, "workspace.yml");
  await writeFile(ymlPath, compiled.yaml, "utf-8");

  // 6. Update workspace metadata
  const newMetadata = {
    ...workspace.metadata,
    blueprintArtifactId: artifactId,
    blueprintRevision: newRevision,
  };
  await manager.updateWorkspaceStatus(workspace.id, workspace.status, { metadata: newMetadata });

  // 7. Destroy runtime if active — forces reload on next request
  const runtime = ctx.getWorkspaceRuntime(workspace.id);
  if (runtime) {
    await ctx.destroyWorkspaceRuntime(workspace.id);
  }

  logger.info("Blueprint mutated and recompiled", {
    workspaceId: workspace.id,
    artifactId,
    revision: newRevision,
    revisionMessage,
  });

  return { ok: true, revision: newRevision, runtimeReloaded: !!runtime };
}

/**
 * Map a blueprint mutation error to an HTTP response.
 *
 * Preserves error detail (entity IDs, validation messages) instead of
 * collapsing everything to a generic message.
 */
function mapBlueprintMutationError(c: Context<AppVariables>, error: MutationError): Response {
  switch (error.type) {
    case "not_found":
      return c.json(
        {
          success: false,
          error: "not_found",
          entityType: error.entityType,
          entityId: error.entityId,
        },
        404,
      );
    case "not_supported":
      return c.json({ success: false, error: "not_supported", message: error.message }, 422);
    case "validation":
      return c.json(
        { success: false, error: "validation", message: error.message, issues: error.issues },
        400,
      );
    case "invalid_operation":
      return c.json({ success: false, error: "invalid_operation", message: error.message }, 422);
    case "conflict":
      return c.json(
        { success: false, error: "conflict", willUnlinkFrom: error.willUnlinkFrom },
        409,
      );
    case "write":
      return c.json({ success: false, error: "write", message: error.message }, 500);
  }
}

/**
 * Result of withBlueprintMutation.
 *
 * - `legacy`: workspace has no blueprint — caller should use legacy mutation path
 * - `blueprint`: mutation was handled via blueprint — response is ready to return
 */
export type BlueprintMutationResult =
  | { mode: "legacy" }
  | { mode: "blueprint"; response: Response };

/**
 * Shared flow for blueprint-aware mutation handlers.
 *
 * Encapsulates: workspace lookup → system check → load blueprint → apply mutation →
 * recompile. Returns a discriminated result so callers decide what to do for
 * non-blueprint workspaces.
 *
 * When the workspace has a blueprint, all errors are surfaced — no silent
 * fallback to legacy. If the mutation returns `not_supported`, it means the
 * input can't be represented in the blueprint schema and is rejected with 422.
 */
export async function withBlueprintMutation(
  c: Context<AppVariables>,
  opts: {
    mutate: (blueprint: WorkspaceBlueprint) => MutationResult<WorkspaceBlueprint>;
    revisionMessage: string;
  },
): Promise<BlueprintMutationResult> {
  const workspaceId = c.req.param("workspaceId");
  const ctx = c.get("app");

  const manager = ctx.getWorkspaceManager();
  const workspace = await manager.find({ id: workspaceId });
  if (!workspace) {
    return {
      mode: "blueprint",
      response: c.json(
        { success: false, error: "not_found", entityType: "workspace", entityId: workspaceId },
        404,
      ),
    };
  }

  if (workspace.metadata?.system) {
    return {
      mode: "blueprint",
      response: c.json(
        { success: false, error: "forbidden", message: "Cannot modify system workspace" },
        403,
      ),
    };
  }

  // No blueprint — caller should use legacy mutation path
  if (!workspace.metadata?.blueprintArtifactId) {
    return { mode: "legacy" };
  }

  const loaded = await loadWorkspaceBlueprint(workspace);
  if (!loaded.ok) {
    return {
      mode: "blueprint",
      response: c.json({ success: false, error: "internal", message: loaded.error }, loaded.status),
    };
  }

  const mutationResult = opts.mutate(loaded.blueprint);
  if (!mutationResult.ok) {
    const error = mutationResult.error;
    return { mode: "blueprint", response: mapBlueprintMutationError(c, error) };
  }

  const recompileResult = await saveAndRecompileBlueprint(
    workspace,
    mutationResult.value,
    loaded.artifactId,
    ctx,
    opts.revisionMessage,
  );

  if (!recompileResult.ok) {
    return {
      mode: "blueprint",
      response: c.json(
        { success: false, error: "internal", message: recompileResult.error },
        recompileResult.status,
      ),
    };
  }

  return { mode: "blueprint", response: c.json({ ok: true }, 200) };
}

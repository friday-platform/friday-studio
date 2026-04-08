/**
 * Shared helpers for compiling a blueprint and writing the resulting workspace.yml.
 *
 * Extracted from the recompile/approve endpoints so that blueprint-aware handlers
 * can reuse the compile → write → reload cycle.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MutationResult } from "@atlas/config/mutations";
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
import { mapMutationError } from "./mutation-errors.ts";

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
 * Resolves the artifact ID from workspace metadata (or explicit params),
 * loads and parses the blueprint. Returns the parsed blueprint and artifact metadata.
 */
export async function loadWorkspaceBlueprint(
  workspace: WorkspaceEntry,
  opts?: { artifactId?: string; revision?: number },
): Promise<
  { ok: true; blueprint: WorkspaceBlueprint; artifactId: string; revision: number } | RecompileError
> {
  const artifactId = opts?.artifactId ?? workspace.metadata?.blueprintArtifactId;
  if (!artifactId) {
    return {
      ok: false,
      error: "Workspace has no linked blueprint — cannot use blueprint mutation path",
      status: 400,
    };
  }

  const artifactResult = await ArtifactStorage.get({ id: artifactId, revision: opts?.revision });
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
 * Compile a blueprint and apply it to a workspace.
 *
 * Core cycle: compile → history → write YAML → update metadata → destroy runtime.
 * Does NOT save to artifact storage — use saveAndRecompileBlueprint() for mutation flows
 * that need to persist a new artifact revision.
 *
 * When `preCompiled` is provided, skips compilation (used by saveAndRecompileBlueprint
 * to avoid double-compiling and ensure artifact/YAML consistency).
 */
export async function applyBlueprint(
  workspace: WorkspaceEntry,
  blueprint: WorkspaceBlueprint,
  artifactId: string,
  revision: number,
  ctx: AppContext,
  opts?: { extraMetadata?: Record<string, unknown>; preCompiled?: { yaml: string } },
): Promise<RecompileResult | RecompileError> {
  let yaml: string;

  if (opts?.preCompiled) {
    yaml = opts.preCompiled.yaml;
  } else {
    // Load dynamic MCP servers (non-fatal)
    let dynamicServers: MCPServerMetadata[] | undefined;
    try {
      const mcpAdapter = await getMCPRegistryAdapter();
      dynamicServers = await mcpAdapter.list();
    } catch (error) {
      logger.warn("Failed to load dynamic MCP servers — compiling without them", {
        workspaceId: workspace.id,
        error,
      });
    }

    const compiled = compileBlueprint(blueprint, dynamicServers);
    if (!compiled.ok) {
      return { ok: false, error: `Compilation failed: ${compiled.error}`, status: 422 };
    }
    yaml = compiled.yaml;
  }

  // Store history before overwriting
  const manager = ctx.getWorkspaceManager();
  const currentConfig = await manager.getWorkspaceConfig(workspace.id);
  if (currentConfig) {
    await storeWorkspaceHistory(workspace, currentConfig.workspace, "full-update", {
      throwOnError: true,
    });
  }

  // Write workspace.yml
  const ymlPath = join(workspace.path, "workspace.yml");
  await writeFile(ymlPath, yaml, "utf-8");

  // Update workspace metadata
  const newMetadata = {
    ...workspace.metadata,
    blueprintArtifactId: artifactId,
    blueprintRevision: revision,
    ...opts?.extraMetadata,
  };
  await manager.updateWorkspaceStatus(workspace.id, workspace.status, { metadata: newMetadata });

  // Destroy runtime if active — forces reload on next request
  const runtime = ctx.getWorkspaceRuntime(workspace.id);
  if (runtime) {
    await ctx.destroyWorkspaceRuntime(workspace.id);
  }

  logger.info("Blueprint compiled and applied", {
    workspaceId: workspace.id,
    artifactId,
    revision,
  });

  return { ok: true, revision, runtimeReloaded: !!runtime };
}

/**
 * Save a mutated blueprint back to artifact storage, recompile, and write workspace.yml.
 *
 * Full mutation cycle: compile (validate first) → save artifact → apply to workspace.
 */
export async function saveAndRecompileBlueprint(
  workspace: WorkspaceEntry,
  blueprint: WorkspaceBlueprint,
  artifactId: string,
  ctx: AppContext,
  revisionMessage: string,
): Promise<RecompileResult | RecompileError> {
  // Compile first to validate before persisting — broken blueprints shouldn't be saved
  let dynamicServers: MCPServerMetadata[] | undefined;
  try {
    const mcpAdapter = await getMCPRegistryAdapter();
    dynamicServers = await mcpAdapter.list();
  } catch (error) {
    logger.warn("Failed to load dynamic MCP servers — compiling without them", {
      workspaceId: workspace.id,
      error,
    });
  }

  const compiled = compileBlueprint(blueprint, dynamicServers);
  if (!compiled.ok) {
    return { ok: false, error: `Compilation failed: ${compiled.error}`, status: 422 };
  }

  // Save to artifact storage
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

  // Pass pre-compiled YAML to avoid double-compiling
  return applyBlueprint(workspace, blueprint, artifactId, newRevision, ctx, {
    preCompiled: { yaml: compiled.yaml },
  });
}

/**
 * Shared flow for blueprint-aware mutation handlers.
 *
 * Encapsulates: workspace lookup → system check → load blueprint → apply mutation →
 * recompile. Returns a discriminated result so callers decide what to do for
 * non-blueprint workspaces.
 */
export type BlueprintMutationResult =
  | { mode: "legacy" }
  | { mode: "blueprint"; response: Response };

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
    return { mode: "blueprint", response: mapMutationError(c, mutationResult.error) };
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

/**
 * Workspace config history storage to Cortex
 *
 * Stores old workspace configs before updates for audit trail.
 * Uses Cortex directly via HTTP - NOT through ArtifactStorage.
 * Artifacts are for execution outputs; this is system state versioning.
 */

import process from "node:process";
import type { WorkspaceConfig } from "@atlas/config";
import { createLogger } from "@atlas/logger";
import { z } from "zod";

const log = createLogger({ name: "cortex-storage" });
const DEFAULT_TIMEOUT_MS = 10_000;

// Zod schemas for external response validation (per CLAUDE.md)
const CortexStoreResponseSchema = z.object({ id: z.string().min(1) });

/**
 * Minimal workspace info needed for history storage.
 * Avoids circular dependency with @atlas/workspace.
 */
export interface WorkspaceHistoryInput {
  id: string;
  metadata?: { system?: boolean };
}

/**
 * Metadata stored with workspace config snapshots in Cortex.
 */
export interface WorkspaceConfigMetadata {
  workspace_id: string;
  type: "workspace-config";
  schema_version: 1;
  source: "partial-update" | "full-update";
  created_at: string;
}

/**
 * Attempt to delete a Cortex object during rollback.
 * Best-effort: logs warning on failure but doesn't throw.
 */
async function rollbackCortexObject(
  url: string,
  id: string,
  token: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    const deleteResponse = await fetch(`${url}/objects/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!deleteResponse.ok) {
      log.warn("failed to rollback orphaned Cortex object", { id, status: deleteResponse.status });
    }
  } catch (error) {
    log.warn("failed to rollback orphaned Cortex object", {
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Store content to Cortex with metadata.
 *
 * @param baseUrl - Cortex service base URL
 * @param content - Content to store (will be JSON stringified)
 * @param metadata - Metadata to attach to the object
 * @returns Cortex object ID
 * @throws Error if storage fails
 */
export async function storeToCortex(
  baseUrl: string,
  content: unknown,
  metadata: WorkspaceConfigMetadata,
): Promise<string> {
  const token = process.env.ATLAS_KEY;
  if (!token) {
    throw new Error("ATLAS_KEY not available for Cortex authentication");
  }

  let url = baseUrl;
  while (url.endsWith("/")) url = url.slice(0, -1);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${url}/objects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(content),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Cortex store failed: ${response.status} ${errorText}`);
    }

    const { id } = CortexStoreResponseSchema.parse(await response.json());

    // Set metadata on the object
    const metadataResponse = await fetch(`${url}/objects/${id}/metadata`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(metadata),
      signal: controller.signal,
    });

    if (!metadataResponse.ok) {
      const errorText = await metadataResponse.text();
      // Rollback: delete orphaned object to prevent data inconsistency
      await rollbackCortexObject(url, id, token, controller.signal);
      throw new Error(`Cortex metadata update failed: ${metadataResponse.status} ${errorText}`);
    }

    // Drain response body (Cortex returns empty 200)
    await metadataResponse.text();

    return id;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Request timeout after 10s");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Options for storeWorkspaceHistory behavior.
 */
export interface StoreWorkspaceHistoryOptions {
  /**
   * When true, throws on storage failure instead of catching and logging.
   * Use this when history storage is a prerequisite for the operation
   * (e.g., must store history before mutating config).
   * @default false
   */
  throwOnError?: boolean;
}

/**
 * Store old workspace config to Cortex before applying updates.
 *
 * Behavior:
 * - Skips system workspaces (workspace.metadata?.system)
 * - Skips if CORTEX_URL not configured (logs debug)
 * - By default, catches and logs errors as warnings (non-fatal)
 * - With throwOnError: true, re-throws errors for caller to handle
 *
 * @param workspace - The workspace entry (or minimal info with id and metadata.system)
 * @param oldConfig - The config being replaced
 * @param source - Whether this is a partial or full update
 * @param options - Optional settings (throwOnError)
 */
export async function storeWorkspaceHistory(
  workspace: WorkspaceHistoryInput,
  oldConfig: WorkspaceConfig,
  source: "partial-update" | "full-update",
  options?: StoreWorkspaceHistoryOptions,
): Promise<void> {
  // Skip system workspaces
  if (workspace.metadata?.system) {
    return;
  }

  const cortexUrl = process.env.CORTEX_URL;
  if (!cortexUrl) {
    log.debug("CORTEX_URL not configured, skipping workspace history");
    return;
  }

  try {
    await storeToCortex(cortexUrl, oldConfig, {
      workspace_id: workspace.id,
      type: "workspace-config",
      schema_version: 1,
      source,
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    if (options?.throwOnError) {
      throw error;
    }
    log.warn("failed to store workspace history", {
      workspaceId: workspace.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

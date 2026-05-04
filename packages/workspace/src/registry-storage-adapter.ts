/**
 * Registry Storage Adapter
 *
 * Domain-specific storage adapter for workspace registry operations.
 * Built on top of the KVStorage interface.
 *
 * **Single-key model (since 2026-05-02):** Each workspace lives at a
 * single KV key (`["workspaces", <id>]`). The previous implementation
 * also maintained a `["workspaces", "_list"]` index for O(1) listing
 * and `["registry", "version"]` / `["registry", "lastUpdated"]` meta
 * keys, all kept in sync via Deno KV's multi-key `atomic()`. JetStream
 * KV (the substrate after the Deno KV consolidation) only supports
 * per-key CAS, not multi-key transactions.
 *
 * The fix: drop the secondary structures entirely.
 *   - List comes from `kv.list({prefix: ["workspaces"]})` — sub-ms at
 *     Friday's expected workspace cardinality (≤100 per install).
 *   - Registry version was set once to "2.0.0" and never branched on.
 *     Removed.
 *   - `lastUpdated` had no external consumers (`getRegistryStats` was
 *     dead code). Removed.
 *
 * Result: every operation is a single-key write — no atomic needed,
 * no risk of `_list` and per-workspace records drifting out of sync,
 * no orphan-list-entry failure mode.
 */

import { stat } from "node:fs/promises";
import { logger } from "@atlas/logger";
import type { KVStorage } from "@atlas/storage/kv";
import type { WorkspaceStatus } from "./types.ts";
import { type WorkspaceEntry, WorkspaceEntrySchema, WorkspaceStatusEnum } from "./types.ts";

export class RegistryStorageAdapter {
  constructor(private storage: KVStorage) {}

  /** Initialize the underlying storage. No-op for the registry itself. */
  async initialize(): Promise<void> {
    await this.storage.initialize();
  }

  async registerWorkspace(workspace: WorkspaceEntry): Promise<void> {
    const validated = WorkspaceEntrySchema.parse(workspace);
    await this.storage.set(["workspaces", validated.id], validated);
  }

  async unregisterWorkspace(id: string): Promise<void> {
    await this.storage.delete(["workspaces", id]);
  }

  async getWorkspace(id: string): Promise<WorkspaceEntry | null> {
    return await this.storage.get<WorkspaceEntry>(["workspaces", id]);
  }

  async findWorkspaceByName(name: string): Promise<WorkspaceEntry | null> {
    for await (const { value } of this.storage.list<WorkspaceEntry>(["workspaces"])) {
      if (value && value.name === name) return value;
    }
    return null;
  }

  async findWorkspaceByPath(path: string): Promise<WorkspaceEntry | null> {
    for await (const { value } of this.storage.list<WorkspaceEntry>(["workspaces"])) {
      if (value && value.path === path) return value;
    }
    return null;
  }

  /** List all registered workspaces. Validates each entry; warn-and-skip on parse failure. */
  async listWorkspaces(): Promise<WorkspaceEntry[]> {
    const out: WorkspaceEntry[] = [];
    for await (const { key, value } of this.storage.list<WorkspaceEntry>(["workspaces"])) {
      if (!value) continue;
      const result = WorkspaceEntrySchema.safeParse(value);
      if (result.success) {
        out.push(result.data);
      } else {
        logger.warn("Skipping invalid workspace entry in storage", {
          key,
          errors: result.error.issues.map((i) => i.message),
        });
      }
    }
    return out;
  }

  async getWorkspacesByStatus(status: WorkspaceStatus): Promise<WorkspaceEntry[]> {
    const all = await this.listWorkspaces();
    return all.filter((w) => w.status === status);
  }

  /**
   * Update a workspace's `lastSeen` timestamp. Best-effort — failures
   * log a warning but don't throw, since lastSeen drift is acceptable
   * compared to disrupting the calling operation.
   *
   * No retry loop: the underlying KV is single-writer-per-key, so
   * concurrent updateWorkspaceLastSeen calls naturally serialize. The
   * old retry+backoff path was guarding against multi-key atomic
   * failures that don't apply to the single-key model.
   */
  async updateWorkspaceLastSeen(id: string): Promise<void> {
    try {
      const current = await this.getWorkspace(id);
      if (!current) return; // Workspace gone — nothing to update.
      const validated = WorkspaceEntrySchema.parse({
        ...current,
        lastSeen: new Date().toISOString(),
      });
      await this.storage.set(["workspaces", id], validated);
    } catch (err) {
      logger.warn(`Failed to update lastSeen for workspace ${id}`, { error: err });
    }
  }

  /**
   * Update workspace status + optional metadata patch. Single-key
   * write (was multi-key atomic + retry loop in the prior
   * implementation; per-key CAS via the KV layer's natural single-
   * writer semantics is sufficient).
   */
  async updateWorkspaceStatus(
    id: string,
    status: WorkspaceStatus,
    updates?: Partial<WorkspaceEntry>,
  ): Promise<void> {
    const current = await this.getWorkspace(id);
    if (!current) throw new Error(`Workspace ${id} not found`);

    const next: WorkspaceEntry = {
      ...current,
      ...(updates ?? {}),
      status,
      lastSeen: new Date().toISOString(),
    };

    if (status === WorkspaceStatusEnum.RUNNING) {
      next.startedAt = new Date().toISOString();
    } else if (status === WorkspaceStatusEnum.STOPPED || status === WorkspaceStatusEnum.INACTIVE) {
      next.stoppedAt = new Date().toISOString();
      next.pid = undefined;
      next.port = undefined;
    }

    const validated = WorkspaceEntrySchema.parse(next);
    await this.storage.set(["workspaces", id], validated);
  }

  /**
   * Remove workspaces whose `path` no longer exists on disk. Returns
   * the IDs that were cleaned up. Per-key deletes; no atomic needed.
   */
  async cleanupOrphanedWorkspaces(): Promise<string[]> {
    const all = await this.listWorkspaces();
    const orphaned: string[] = [];

    for (const w of all) {
      try {
        const result = await stat(w.path);
        if (!result.isDirectory()) orphaned.push(w.id);
      } catch {
        orphaned.push(w.id);
      }
    }

    for (const id of orphaned) {
      await this.storage.delete(["workspaces", id]);
    }

    return orphaned;
  }

  async close(): Promise<void> {
    await this.storage.close();
  }

  /**
   * Get the underlying storage. Use sparingly — prefer the
   * domain-specific methods above.
   */
  getStorage(): KVStorage {
    return this.storage;
  }
}

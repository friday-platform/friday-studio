/**
 * Block 2 (workspace-stable inventory) cache.
 *
 * The `<workspace>` XML section + memory store names + skill names form
 * the "workspace-stable" tier of the system prompt: their bytes change
 * only when workspace structure changes (skill assigned, MCP server
 * added, communicator wired). Across turns within a session — and
 * across sessions for the same workspace state — the bytes are
 * identical, which is what the Anthropic prompt cache wants.
 *
 * This cache memoizes the per-workspace HTTP-fetched inputs
 * (`WorkspaceDetails` from 5 endpoints + `WorkspaceConfig` from the
 * config endpoint). Downstream `formatWorkspaceSection` is pure +
 * deterministic, so the output string is byte-stable across turns
 * even though we re-format from cached inputs each turn.
 *
 * v0: in-memory, daemon-process-local, TTL-bounded (5 min — matches
 * the Anthropic cache window). v1 (future) can KV-back this for
 * cross-restart durability + KV `Watch`-driven invalidation.
 */

import { client, parseResult } from "@atlas/client/v2";
import type { WorkspaceConfig } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { fetchWorkspaceDetails, type WorkspaceDetails } from "./workspace-chat.agent.ts";

export interface Block2Inputs {
  details: WorkspaceDetails;
  config?: WorkspaceConfig;
  /** When this entry was materialized. */
  computedAt: string;
}

interface CacheEntry {
  value: Block2Inputs;
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, CacheEntry>();

/**
 * Get cached Block 2 inputs (workspace details + config) for a
 * workspace, fetching on miss / expiry. The two source HTTP calls
 * (`fetchWorkspaceDetails` + `client.workspace[:id].config.$get`)
 * run in parallel on miss.
 */
export async function getBlock2Inputs(workspaceId: string, logger: Logger): Promise<Block2Inputs> {
  const now = Date.now();
  const hit = cache.get(workspaceId);
  if (hit && hit.expiresAt > now) {
    return hit.value;
  }

  const [details, configResult] = await Promise.all([
    fetchWorkspaceDetails(workspaceId, logger),
    parseResult(client.workspace[":workspaceId"].config.$get({ param: { workspaceId } })),
  ]);

  let config: WorkspaceConfig | undefined;
  if (configResult.ok) {
    config = configResult.data.config;
  } else {
    logger.warn("getBlock2Inputs: failed to fetch workspace config", {
      workspaceId,
      error: configResult.error,
    });
  }

  const value: Block2Inputs = { details, config, computedAt: new Date().toISOString() };
  cache.set(workspaceId, { value, expiresAt: now + TTL_MS });
  if (hit) logger.debug("Block 2 cache miss (expired)", { workspaceId });
  return value;
}

/**
 * Drop the cached entry for a workspace. Called when the workspace
 * structure is known to have changed (publish_draft, upsert_*,
 * skill assignment events). Caller is responsible for triggering;
 * the cache otherwise relies on the 5-minute TTL.
 */
export function invalidateBlock2(workspaceId: string): void {
  cache.delete(workspaceId);
}

/** Test-only: drop everything. */
export function clearBlock2CacheForTests(): void {
  cache.clear();
}

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

/**
 * LRU cap. Map iteration order in JS is insertion order, so re-set on
 * read keeps the recency ordering and `Map#keys().next()` gives the
 * least-recently-used. 64 covers the realistic working set of any
 * single daemon (typical user has <10 workspaces; foreground composition
 * touches at most a few extras per turn) without leaking unbounded
 * across long runs.
 */
const MAX_ENTRIES = 64;

export class Block2Cache {
  private readonly map = new Map<string, CacheEntry>();

  get(workspaceId: string): CacheEntry | undefined {
    const hit = this.map.get(workspaceId);
    if (!hit) return undefined;
    // Refresh recency: re-insert moves to the end of the iteration order.
    this.map.delete(workspaceId);
    this.map.set(workspaceId, hit);
    return hit;
  }

  set(workspaceId: string, entry: CacheEntry): void {
    if (this.map.has(workspaceId)) this.map.delete(workspaceId);
    this.map.set(workspaceId, entry);
    while (this.map.size > MAX_ENTRIES) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(workspaceId: string): void {
    this.map.delete(workspaceId);
  }

  clear(): void {
    this.map.clear();
  }

  size(): number {
    return this.map.size;
  }
}

const cache = new Block2Cache();

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

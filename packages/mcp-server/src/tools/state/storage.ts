/**
 * Workspace state storage — JetStream KV facade for the `state_*` MCP
 * tools (append / lookup / filter).
 *
 * Each workspace gets its own KV bucket: `WS_STATE_<sanitized_wsid>`.
 * Inside a bucket, entries live under hierarchical keys
 * `[<table>, <uuid>]` mapped onto JS KV's flat keyspace by the existing
 * `JetStreamKVStorage` (which handles `:` / space / unicode encoding).
 *
 * Per-workspace bucket so deleting a workspace teardown is one
 * `js.kv.delete(WS_STATE_<wsid>)` — no global scan-and-prune.
 *
 * TTL is implemented in app code on `append` (KV is per-bucket TTL,
 * not per-key). For the typical workloads — dozens to hundreds of
 * entries per table — the O(N) scan is fine. Revisit if a table grows
 * past ~10K rows.
 */

import { createJetStreamKVStorage, type KVStorage } from "@atlas/storage";
import type { NatsConnection } from "nats";

const SAFE_BUCKET_RE = /[^A-Za-z0-9_-]/g;

let nc: NatsConnection | null = null;
const cachedKV = new Map<string, KVStorage>();

/**
 * Wire workspace-state storage to a NATS connection. Daemon calls this
 * once at startup, before any MCP tool that touches `state_*` runs.
 */
export function initWorkspaceStateStorage(connection: NatsConnection): void {
  nc = connection;
}

/** Reset module state — tests only. */
export function _resetWorkspaceStateStorageForTest(): void {
  nc = null;
  cachedKV.clear();
}

function sanitizeBucketName(workspaceId: string): string {
  return workspaceId.replace(SAFE_BUCKET_RE, "_");
}

async function getKV(workspaceId: string): Promise<KVStorage> {
  const sanitized = sanitizeBucketName(workspaceId);
  const cached = cachedKV.get(sanitized);
  if (cached) return cached;
  if (!nc) {
    throw new Error(
      "Workspace state storage not initialized — call initWorkspaceStateStorage(nc) at daemon startup",
    );
  }
  const kv = await createJetStreamKVStorage(nc, { bucket: `WS_STATE_${sanitized}`, history: 1 });
  cachedKV.set(sanitized, kv);
  return kv;
}

export interface StateEntry extends Record<string, unknown> {
  _ts: string;
}

export interface AppendResult {
  count: number;
  pruned: number;
}

/**
 * Append a JSON entry to a workspace state "table" (KV prefix).
 * Auto-stamps `_ts`. If `ttl_hours` is set, entries older than the
 * cutoff are deleted in the same call (best-effort).
 */
export async function appendStateEntry(
  workspaceId: string,
  table: string,
  entry: Record<string, unknown>,
  ttl_hours?: number,
): Promise<AppendResult> {
  const kv = await getKV(workspaceId);
  const ts = new Date().toISOString();
  const stored: StateEntry = { ...entry, _ts: ts };
  const id = crypto.randomUUID();
  await kv.set([table, id], stored);

  let pruned = 0;
  let count = 0;
  if (ttl_hours !== undefined) {
    const cutoff = new Date(Date.now() - ttl_hours * 3600000).toISOString();
    const toDelete: string[][] = [];
    for await (const e of kv.list<StateEntry>([table])) {
      count++;
      if (e.value._ts < cutoff) {
        toDelete.push([...e.key]);
      }
    }
    for (const key of toDelete) {
      await kv.delete(key);
      pruned++;
    }
    count -= pruned;
  } else {
    for await (const _ of kv.list<StateEntry>([table])) count++;
  }

  return { count, pruned };
}

/**
 * Find the first entry in a table whose `field` matches `value`.
 * Scans the whole table — see file-level note on scale.
 */
export async function lookupStateEntry(
  workspaceId: string,
  table: string,
  field: string,
  value: string | number | boolean,
): Promise<StateEntry | null> {
  const kv = await getKV(workspaceId);
  for await (const e of kv.list<StateEntry>([table])) {
    if (extractField(e.value, field) === value) return e.value;
  }
  return null;
}

/**
 * Return the subset of `values` NOT present in any entry's `field`.
 * Single-pass scan; deduplication-friendly idempotency for workflows
 * that batch-process external IDs.
 */
export async function filterStateValues(
  workspaceId: string,
  table: string,
  field: string,
  values: Array<string | number>,
): Promise<{ unprocessed: Array<string | number>; total: number; filtered: number }> {
  const kv = await getKV(workspaceId);
  const seen = new Set<string>();
  for await (const e of kv.list<StateEntry>([table])) {
    const v = extractField(e.value, field);
    if (v !== undefined && v !== null) seen.add(String(v));
  }
  const unprocessed = values.filter((v) => !seen.has(String(v)));
  return { unprocessed, total: values.length, filtered: values.length - unprocessed.length };
}

/**
 * Resolve dotted-path field access (e.g. "data.id" reads `entry.data.id`).
 * Mirrors SQLite `json_extract($.field)` behavior.
 */
function extractField(entry: unknown, field: string): unknown {
  let cur: unknown = entry;
  for (const part of field.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

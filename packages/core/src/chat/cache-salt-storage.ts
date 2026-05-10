/**
 * Workspace-scoped prompt-cache salt.
 *
 * Anthropic exposes no clear-cache API; cached prefixes expire only by
 * TTL (1h on long-lived blocks, 5m on session-stable) or when one byte
 * of the prefix changes. The salt is the byte we change on demand: a
 * monotonically increasing integer per workspace, embedded as a tiny
 * `<cache_salt .../>` tag at the start of system block 2.
 *
 * System block 1 is `prompt.txt` (weeks-stable across every chat and
 * every workspace) — keeping the salt out of block 1 preserves cross-
 * workspace caching of those bytes. Bumping the salt invalidates block
 * 2's cache breakpoint for every chat in the workspace; turn N+1 after
 * a bump writes a fresh cache, turn N+2 hits the new prefix and caching
 * resumes normally.
 *
 * Storage: a tiny dedicated KV bucket so the salt isn't entangled with
 * chat or workspace records that have their own schema concerns. The
 * read path is fire-and-forget for the chat handler — a transient KV
 * failure falls through to "no salt" (bytes match the never-bumped
 * state, which is fine; the cache stays as it was).
 */

import { type NatsConnection, StorageType } from "nats";

const KV_BUCKET = "CACHE_SALTS";
const KEY_PREFIX = "ws.";

const SAFE_NAME_RE = /[^A-Za-z0-9_-]/g;

function safeKey(workspaceId: string): string {
  // KV key constraints mirror the chat-storage pattern — restrict to
  // `[A-Za-z0-9_-]` so a workspace id's punctuation (slashes, colons)
  // doesn't trip nats.js's `validateKey`.
  return `${KEY_PREFIX}${workspaceId.replace(SAFE_NAME_RE, "_")}`;
}

async function ensureBucket(nc: NatsConnection) {
  const js = nc.jetstream();
  return await js.views.kv(KV_BUCKET, { history: 1, storage: StorageType.File });
}

function decodeSalt(entry: { value: Uint8Array } | null | undefined): number {
  if (!entry || !entry.value || entry.value.length === 0) return 0;
  const text = new TextDecoder().decode(entry.value);
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Current salt for a workspace. `0` means "never bumped" — the chat
 * handler omits the salt tag entirely in that case so the cache prefix
 * matches what it was before the salt mechanism existed.
 */
export async function getWorkspaceCacheSalt(
  nc: NatsConnection,
  workspaceId: string,
): Promise<number> {
  try {
    const kv = await ensureBucket(nc);
    const entry = await kv.get(safeKey(workspaceId));
    return decodeSalt(entry);
  } catch {
    return 0;
  }
}

/**
 * Increment the salt for a workspace by one and return the new value.
 * The caller (an HTTP route) surfaces the new value back to the UI so
 * the operator sees confirmation that the bump landed and can correlate
 * it with the next turn's cache_write.
 *
 * CAS-bounded: two concurrent operators clicking "Force fresh cache" used
 * to read the same N and both write N+1, losing one increment. The bumps
 * are idempotent for cache-correctness purposes (any salt change
 * invalidates the prefix), but operators expect strictly-monotonic
 * confirmation values. `kv.update(key, …, revision)` rejects on stale
 * revision; we retry against the new value. Capped to keep a contended
 * spin from running forever.
 */
const BUMP_MAX_ATTEMPTS = 8;

export async function bumpWorkspaceCacheSalt(
  nc: NatsConnection,
  workspaceId: string,
): Promise<number> {
  const kv = await ensureBucket(nc);
  const key = safeKey(workspaceId);
  const enc = new TextEncoder();

  for (let attempt = 0; attempt < BUMP_MAX_ATTEMPTS; attempt++) {
    const entry = await kv.get(key);
    const current = decodeSalt(entry);
    const next = current + 1;
    const bytes = enc.encode(String(next));

    if (entry === null) {
      // No prior value — claim the key with create (compare-and-null-set).
      // A racing creator wins the create; the loser falls through to the
      // update path on the next loop iteration.
      try {
        await kv.create(key, bytes);
        return next;
      } catch {
        continue;
      }
    }

    try {
      await kv.update(key, bytes, entry.revision);
      return next;
    } catch {}
  }

  throw new Error(
    `bumpWorkspaceCacheSalt: ${BUMP_MAX_ATTEMPTS} CAS attempts exhausted for ${workspaceId}`,
  );
}

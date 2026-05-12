/**
 * JetStream-backed opaque-session storage.
 *
 * One KV bucket `SESSIONS` keyed by the session token (a random
 * 32-byte base64url string with no embedded claims). The KV record
 * holds `{ userId, createdAt, lastSeenAt, expiresAt }`; the daemon's
 * middleware reads the token off the cookie / Bearer header,
 * validates against this bucket, and stamps the resulting userId on
 * the Hono context.
 *
 * Opaque (not JWT) so:
 * - Revocation is `kv.delete(token)` — no denylist sidecar to keep
 *   in sync.
 * - "Active sessions" and "log out everywhere" surfaces are trivial
 *   future additions.
 * - The same primitive scales to multi-tenant cloud: login flow
 *   becomes "validate credentials then `createSession(userId)`",
 *   everything downstream is identical.
 */

import { fail, type Result, stringifyError, success } from "@atlas/utils";
import { type KV, type NatsConnection, StorageType } from "nats";
import { z } from "zod";

const KV_BUCKET = "SESSIONS";

/** Token byte length before base64url encoding — 32 bytes ≈ 256 bits of entropy. */
const TOKEN_BYTES = 32;
/** Default session lifetime: 90 days. Cookie Max-Age mirrors this. */
export const DEFAULT_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export const SessionRecordSchema = z.object({
  userId: z.string().min(1),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Generate a fresh opaque session token. 32 random bytes encoded as
 * URL-safe base64 (no padding). Web Crypto is available in Deno and
 * Node 18+, both daemon targets.
 */
export function mintSessionToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  // base64url without padding
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface JetStreamSessionBackend {
  /** Create a fresh session bound to `userId`. Returns the token to set as the cookie. */
  createSession(
    userId: string,
    ttlMs?: number,
  ): Promise<Result<{ token: string; record: SessionRecord }, string>>;
  /**
   * Look up a session by token. Returns null when missing OR expired
   * (a missing record and an expired one are equivalent for authn —
   * both force re-auth). Side-effect: refreshes `lastSeenAt` on hit.
   */
  getSession(token: string): Promise<Result<SessionRecord | null, string>>;
  deleteSession(token: string): Promise<Result<void, string>>;
}

export async function ensureSessionsKVBucket(nc: NatsConnection): Promise<KV> {
  const js = nc.jetstream();
  return await js.views.kv(KV_BUCKET, { history: 1, storage: StorageType.File });
}

export function createJetStreamSessionBackend(nc: NatsConnection): JetStreamSessionBackend {
  let cachedKV: KV | null = null;
  async function kv(): Promise<KV> {
    if (cachedKV) return cachedKV;
    cachedKV = await ensureSessionsKVBucket(nc);
    return cachedKV;
  }

  async function createSession(
    userId: string,
    ttlMs: number = DEFAULT_SESSION_TTL_MS,
  ): Promise<Result<{ token: string; record: SessionRecord }, string>> {
    try {
      const k = await kv();
      const token = mintSessionToken();
      const now = new Date();
      const record: SessionRecord = {
        userId,
        createdAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      };
      // `kv.create` would CAS-fail on duplicate; 256-bit tokens make
      // collisions vanishingly unlikely — plain put is fine.
      await k.put(token, enc.encode(JSON.stringify(record)));
      return success({ token, record });
    } catch (error) {
      return fail(stringifyError(error));
    }
  }

  async function getSession(token: string): Promise<Result<SessionRecord | null, string>> {
    if (!token) return success(null);
    try {
      const k = await kv();
      const entry = await k.get(token);
      if (!entry || entry.operation !== "PUT") return success(null);
      const parsed = SessionRecordSchema.safeParse(JSON.parse(dec.decode(entry.value)));
      if (!parsed.success) return success(null);
      const record = parsed.data;
      if (new Date(record.expiresAt).getTime() <= Date.now()) {
        // Lazy expiry: delete on read. Cheap, avoids a sweeper.
        try {
          await k.delete(token);
        } catch {
          // Best-effort.
        }
        return success(null);
      }
      // Touch lastSeenAt opportunistically. CAS-update — if another
      // request raced and updated first, that's fine, we don't retry
      // (the timestamp drift is microseconds either way).
      try {
        const next: SessionRecord = { ...record, lastSeenAt: new Date().toISOString() };
        await k.update(token, enc.encode(JSON.stringify(next)), entry.revision);
      } catch {
        // CAS race — ignore.
      }
      return success(record);
    } catch (error) {
      return fail(stringifyError(error));
    }
  }

  async function deleteSession(token: string): Promise<Result<void, string>> {
    if (!token) return success(undefined);
    try {
      const k = await kv();
      await k.delete(token);
      return success(undefined);
    } catch (error) {
      return fail(stringifyError(error));
    }
  }

  return { createSession, getSession, deleteSession };
}

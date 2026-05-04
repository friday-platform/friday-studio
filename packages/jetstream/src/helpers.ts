/**
 * Shared helpers for working with NATS / JetStream APIs.
 *
 * Every chat / memory / signal module previously inlined its own copies of
 * these — the same `isStreamNotFound` / `isCASConflict` regex match, the
 * same `enc/dec` codecs, the same retry-on-CAS-conflict loop. Centralized
 * here so future surfaces (artifacts, cron, mcp-registry, …) don't
 * re-duplicate.
 */

import type { KV } from "nats";

/** Single-source TextEncoder / TextDecoder so callers don't allocate per-op. */
export const enc = new TextEncoder();
export const dec = new TextDecoder();

/**
 * NATS error message strings vary slightly across server versions;
 * matching on the message text is more portable than matching on
 * error codes.
 */
export function isStreamNotFound(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err);
  return msg.includes("stream not found") || msg.includes("no stream");
}

export function isConsumerNotFound(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err);
  return msg.includes("consumer not found");
}

export function isCASConflict(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err);
  return msg.includes("wrong last sequence") || msg.includes("revision");
}

/**
 * Read a JSON value from a KV bucket. Returns `null` for missing or
 * deleted (operation === "DEL") entries — callers that need to
 * distinguish should use `kv.get` directly.
 */
export async function readKvJson<T = unknown>(kv: KV, key: string): Promise<T | null> {
  const entry = await kv.get(key);
  if (!entry || entry.operation !== "PUT") return null;
  return JSON.parse(dec.decode(entry.value)) as T;
}

/** Write a JSON value to a KV bucket (overwrites without CAS). */
export async function writeKvJson(kv: KV, key: string, value: unknown): Promise<void> {
  await kv.put(key, enc.encode(JSON.stringify(value)));
}

export interface CasOptions {
  /** Max retry attempts on CAS conflict before throwing. Default: 8. */
  retries?: number;
}

/**
 * Read-modify-write a JSON KV value with CAS retry. The mutator receives
 * the current value (or `null` if the key doesn't exist) and returns the
 * next value. On CAS conflict (another writer beat us), retries the read
 * with the latest revision.
 *
 * Throws after exhausting `retries` (default 8) — caller decides whether
 * to escalate or back off.
 */
export async function updateKvJsonCAS<T>(
  kv: KV,
  key: string,
  mut: (current: T | null) => T,
  opts: CasOptions = {},
): Promise<T> {
  const retries = opts.retries ?? 8;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const existing = await kv.get(key);
    const isPut = existing && existing.operation === "PUT";
    const current = isPut ? (JSON.parse(dec.decode(existing.value)) as T) : null;
    const next = mut(current);
    try {
      if (!isPut) {
        await kv.create(key, enc.encode(JSON.stringify(next)));
      } else {
        await kv.update(key, enc.encode(JSON.stringify(next)), existing.revision);
      }
      return next;
    } catch (err) {
      if (isCASConflict(err) && attempt < retries) continue;
      throw err;
    }
  }
  throw new Error(`KV CAS update exhausted ${retries} retries: ${key}`);
}

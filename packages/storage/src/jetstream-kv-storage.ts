/**
 * JetStream-KV–backed implementation of `KVStorage`.
 *
 * Maps the hierarchical `string[]` key shape onto JetStream KV's flat
 * string keyspace by joining segments with `/` (a valid character in
 * JS KV keys per the NATS skill notes; `*`/`>` would conflict with
 * filter wildcards but we use neither).
 *
 *   ["cron_timers", "ws-1:every-min"]  ↔  "cron_timers/ws-1:every-min"
 *
 * Hierarchy preserved on `list()` by splitting the key back into
 * segments before yielding.
 *
 * **Limitations vs DenoKVStorage:**
 * - `atomic()` is unsupported. JS KV's CAS is per-key (`update(key, value, revision)`),
 *   not multi-key. Callers that need multi-key transactional semantics
 *   (e.g. the workspace registry, which keeps `_list` in sync with
 *   per-workspace records) MUST be refactored to single-document
 *   storage or accept best-effort per-key updates. Throws explicitly
 *   so the migration breaks loudly rather than silently doing the
 *   wrong thing.
 * - `health()` round-trips a no-op KV get; cheap but adds latency
 *   compared to Deno KV's local-file `health()`.
 * - No on-disk persistence guarantees beyond JetStream's `sync_interval`
 *   (default 2 min). For cron timers this is fine — missing one tick
 *   on a broker crash is recoverable; the next tick fires from the
 *   correct schedule.
 */

import type { MaybePromise } from "@atlas/utils";
import { dec, enc, isCASConflict } from "jetstream";
import type { KV, NatsConnection } from "nats";
import type { AtomicOperation, KVEntry, KVStorage } from "./kv-storage.ts";

const SEPARATOR = "/";

/**
 * JS KV keys allow `a-z A-Z 0-9 _ - . = /` only. The hierarchical
 * `string[]` keys callers pass can contain anything (`:`, spaces,
 * unicode, etc), so we percent-encode-style escape illegal chars
 * using `=` as the escape (legal AND uncommon in identifiers).
 *
 *   "aged_dill:auto-sweep"  →  "aged_dill=3Aauto-sweep"
 *
 * `=` itself is escaped first as `=3D` so the encoding is reversible.
 * `/` IS legal in JS KV keys but we use it as the segment separator —
 * if a segment legitimately contains `/`, encode it too so it doesn't
 * collide with the segment boundary.
 *
 * This entire layer is private to JetStreamKVStorage — callers see
 * the original `string[]` shape on read AND write, the encoding is
 * just to satisfy JS KV's keyspace.
 */
const ILLEGAL_KEY_CHARS = /[^A-Za-z0-9_\-.]/g;
const ENCODED_PATTERN = /=([0-9A-Fa-f]{2})/g;

function encodeSegment(s: string): string {
  return s
    .replace(/=/g, "=3D") // escape the escape FIRST
    .replace(ILLEGAL_KEY_CHARS, (c) => {
      const hex = c.codePointAt(0)?.toString(16).toUpperCase().padStart(2, "0") ?? "??";
      return `=${hex}`;
    });
}

function decodeSegment(s: string): string {
  return s.replace(ENCODED_PATTERN, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

function joinKey(segments: string[]): string {
  return segments.map(encodeSegment).join(SEPARATOR);
}

function splitKey(flat: string): string[] {
  return flat.split(SEPARATOR).map(decodeSegment);
}

export interface JetStreamKVStorageOptions {
  /** JetStream KV bucket name. */
  bucket: string;
  /** History depth (per-key revision retention). Default 5. */
  history?: number;
}

export class JetStreamKVStorage implements KVStorage {
  private kv: KV | null = null;

  constructor(
    private readonly nc: NatsConnection,
    private readonly opts: JetStreamKVStorageOptions,
  ) {}

  async initialize(): Promise<void> {
    if (this.kv) return;
    const js = this.nc.jetstream();
    this.kv = await js.views.kv(this.opts.bucket, { history: this.opts.history ?? 5 });
  }

  private requireKv(): KV {
    if (!this.kv) {
      throw new Error(
        `JetStreamKVStorage(${this.opts.bucket}) not initialized — call initialize() first`,
      );
    }
    return this.kv;
  }

  async get<T>(key: string[]): Promise<T | null> {
    const kv = this.requireKv();
    const entry = await kv.get(joinKey(key));
    if (!entry || entry.operation !== "PUT") return null;
    return JSON.parse(dec.decode(entry.value)) as T;
  }

  async set<T>(key: string[], value: T): Promise<void> {
    const kv = this.requireKv();
    await kv.put(joinKey(key), enc.encode(JSON.stringify(value)));
  }

  async delete(key: string[]): Promise<void> {
    const kv = this.requireKv();
    await kv.delete(joinKey(key));
  }

  /**
   * List entries under a prefix. Collects ALL keys first via `kv.keys()`,
   * then per-key `kv.get` — required because JS KV's `kv.keys()` iterator
   * truncates if you interleave `kv.get` calls inside the loop.
   * Acceptable at the cardinalities cron / workspace registry hit
   * (dozens to hundreds of keys); revisit if a future surface needs
   * thousands.
   */
  async *list<T, U extends readonly (string | number | bigint)[] = string[]>(
    prefix: string[],
  ): AsyncIterableIterator<KVEntry<T, U>> {
    const kv = this.requireKv();
    const flatPrefix = joinKey(prefix) + (prefix.length > 0 ? SEPARATOR : "");
    const it = await kv.keys();
    const matched: string[] = [];
    for await (const k of it) {
      if (k.startsWith(flatPrefix) || flatPrefix === "") matched.push(k);
    }
    for (const flatKey of matched) {
      const entry = await kv.get(flatKey);
      if (!entry || entry.operation !== "PUT") continue;
      // splitKey reverses the encoding so consumers see the original
      // segment shape (e.g. `["cron_timers", "aged_dill:auto-sweep"]`).
      const segments = splitKey(flatKey) as unknown as U;
      yield {
        key: segments,
        value: JSON.parse(dec.decode(entry.value)) as T,
        versionstamp: String(entry.revision),
      };
    }
  }

  /**
   * JS KV has no multi-key atomic transaction. Callers that need this
   * (workspace registry's _list/per-workspace consistency) must be
   * refactored — either to single-document storage or to best-effort
   * per-key CAS via `kv.update(key, value, revision)` plus reconciliation.
   */
  atomic(): AtomicOperation {
    throw new Error(
      "JetStreamKVStorage does not support atomic() — JS KV CAS is per-key. " +
        "Refactor caller to use single-key updates or per-key CAS via update(revision).",
    );
  }

  async health(): Promise<boolean> {
    try {
      const kv = this.requireKv();
      await kv.get("__health_probe__"); // missing key = ok, just confirms broker reachable
      return true;
    } catch {
      return false;
    }
  }

  close(): MaybePromise<void> {
    // Nothing to close — the underlying NATS connection is owned by the daemon.
    return;
  }
}

/** Convenience: `KVStorage`-shaped CAS helper that uses JS KV's per-key CAS. */
export async function jetstreamKvUpdateCAS<T>(
  storage: JetStreamKVStorage,
  key: string[],
  mut: (current: T | null) => T,
  retries = 8,
): Promise<T> {
  // biome-ignore lint/suspicious/noExplicitAny: deliberate dynamic access for the CAS path
  const kv: KV = (storage as unknown as { requireKv(): KV }).requireKv();
  const flatKey = joinKey(key);
  for (let attempt = 0; attempt <= retries; attempt++) {
    const existing = await kv.get(flatKey);
    const isPut = existing && existing.operation === "PUT";
    const current = isPut ? (JSON.parse(dec.decode(existing.value)) as T) : null;
    const next = mut(current);
    try {
      if (!isPut) {
        await kv.create(flatKey, enc.encode(JSON.stringify(next)));
      } else {
        await kv.update(flatKey, enc.encode(JSON.stringify(next)), existing.revision);
      }
      return next;
    } catch (err) {
      if (isCASConflict(err) && attempt < retries) continue;
      throw err;
    }
  }
  throw new Error(`KV CAS update exhausted ${retries} retries: ${flatKey}`);
}

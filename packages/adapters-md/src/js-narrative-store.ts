/**
 * JetStream-backed NarrativeStore.
 *
 * One stream per (workspaceId, narrativeName); per-narrative metadata
 * + tombstones live in the MEMORY_INDEX KV bucket.
 *
 * - append(): one publish, no full-file rewrite.
 * - read(): bounded-fetch of the per-stream consumer; filters tombstones
 *   set by forget().
 * - forget(): adds the entry id to the tombstone set (KV CAS); messages
 *   stay in the stream but reads filter them out.
 * - render(): markdown bullets generated from current entries.
 *
 * Broker-managed FIFO ordering replaces the missing file lock that the
 * markdown backend had — concurrent appends now serialize at the broker
 * regardless of how many writers there are.
 */

import type { NarrativeEntry, NarrativeStore, SearchOpts } from "@atlas/agent-sdk";
import { NarrativeEntrySchema, withSchemaBoundary } from "@atlas/agent-sdk";
import { createLogger } from "@atlas/logger";
import {
  type JetStreamClient,
  type KV,
  type NatsConnection,
  headers as natsHeaders,
  RetentionPolicy,
  StorageType,
} from "nats";
import { z } from "zod";

const logger = createLogger({ component: "js-narrative-store" });

const SAFE_NAME_RE = /[^A-Za-z0-9_-]/g;
const sanitize = (s: string) => s.replace(SAFE_NAME_RE, "_");

const MEMORY_INDEX_BUCKET = "MEMORY_INDEX";
const SCHEMA_VERSION = "1";
const DEFAULT_MAX_MSG_SIZE = 4 * 1024 * 1024;
const DEFAULT_DUPLICATE_WINDOW_NS = 24 * 60 * 60 * 1_000_000_000;

export const NarrativeIndexEntrySchema = z.object({
  workspaceId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  entryCount: z.number().int().nonnegative(),
  lastUpdated: z.string().datetime(),
  tombstones: z.array(z.string()).default([]),
});
export type NarrativeIndexEntry = z.infer<typeof NarrativeIndexEntrySchema>;

export function memoryStreamName(workspaceId: string, name: string): string {
  return `MEMORY_${sanitize(workspaceId)}_${sanitize(name)}`;
}

export function memorySubject(workspaceId: string, name: string): string {
  return `memory.${workspaceId}.${name}.entries`;
}

export function memoryIndexKey(workspaceId: string, name: string): string {
  return `${workspaceId}/${name}`;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function isStreamNotFound(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err);
  return msg.includes("stream not found") || msg.includes("no stream");
}

function isCASConflict(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err);
  return msg.includes("wrong last sequence") || msg.includes("revision");
}

export async function ensureMemoryIndexBucket(nc: NatsConnection): Promise<KV> {
  const js = nc.jetstream();
  return await js.views.kv(MEMORY_INDEX_BUCKET, { history: 5, storage: StorageType.File });
}

async function ensureNarrativeStream(
  nc: NatsConnection,
  workspaceId: string,
  name: string,
): Promise<void> {
  const jsm = await nc.jetstreamManager();
  const sName = memoryStreamName(workspaceId, name);
  try {
    await jsm.streams.info(sName);
    return;
  } catch (err) {
    if (!isStreamNotFound(err)) throw err;
  }
  await jsm.streams.add({
    name: sName,
    subjects: [memorySubject(workspaceId, name)],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    max_msg_size: DEFAULT_MAX_MSG_SIZE,
    duplicate_window: DEFAULT_DUPLICATE_WINDOW_NS,
  });
  logger.info("Created memory stream", { workspaceId, name, stream: sName });
}

const indexQueues = new Map<string, Promise<unknown>>();
function enqueueIndex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = indexQueues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tracked = next.then(
    () => undefined,
    () => undefined,
  );
  indexQueues.set(key, tracked);
  tracked.finally(() => {
    if (indexQueues.get(key) === tracked) indexQueues.delete(key);
  });
  return next as Promise<T>;
}

export async function readNarrativeIndex(
  kv: KV,
  workspaceId: string,
  name: string,
): Promise<NarrativeIndexEntry | null> {
  const entry = await kv.get(memoryIndexKey(workspaceId, name));
  if (!entry || entry.operation !== "PUT") return null;
  return NarrativeIndexEntrySchema.parse(JSON.parse(dec.decode(entry.value)));
}

async function updateNarrativeIndex(
  kv: KV,
  workspaceId: string,
  name: string,
  mut: (current: NarrativeIndexEntry | null) => NarrativeIndexEntry,
): Promise<NarrativeIndexEntry> {
  const key = memoryIndexKey(workspaceId, name);
  for (let attempt = 0; attempt < 8; attempt++) {
    const existing = await kv.get(key);
    if (!existing || existing.operation !== "PUT") {
      const next = mut(null);
      try {
        await kv.create(key, enc.encode(JSON.stringify(next)));
        return next;
      } catch (err) {
        if (isCASConflict(err) && attempt < 7) continue;
        throw err;
      }
    }
    const current = NarrativeIndexEntrySchema.parse(JSON.parse(dec.decode(existing.value)));
    const next = mut(current);
    try {
      await kv.update(key, enc.encode(JSON.stringify(next)), existing.revision);
      return next;
    } catch (err) {
      if (isCASConflict(err) && attempt < 7) continue;
      throw err;
    }
  }
  throw new Error(`Narrative index update failed after 8 CAS retries: ${key}`);
}

export class JetStreamNarrativeStore implements NarrativeStore {
  private readonly nc: NatsConnection;
  private readonly workspaceId: string;
  private readonly name: string;
  private cachedKV: KV | null = null;

  constructor(opts: { nc: NatsConnection; workspaceId: string; name: string }) {
    this.nc = opts.nc;
    this.workspaceId = opts.workspaceId;
    this.name = opts.name;
  }

  private async kv(): Promise<KV> {
    if (this.cachedKV) return this.cachedKV;
    this.cachedKV = await ensureMemoryIndexBucket(this.nc);
    return this.cachedKV;
  }

  private js(): JetStreamClient {
    return this.nc.jetstream();
  }

  append(entry: NarrativeEntry): Promise<NarrativeEntry> {
    return withSchemaBoundary(
      {
        schema: NarrativeEntrySchema,
        commit: async (parsed: NarrativeEntry): Promise<NarrativeEntry> => {
          await ensureNarrativeStream(this.nc, this.workspaceId, this.name);
          const h = natsHeaders();
          h.set("Friday-Schema-Version", SCHEMA_VERSION);
          h.set("Friday-Entry-Id", parsed.id);
          await this.js().publish(
            memorySubject(this.workspaceId, this.name),
            enc.encode(JSON.stringify(parsed)),
            { headers: h, msgID: parsed.id },
          );

          const k = await this.kv();
          await enqueueIndex(memoryIndexKey(this.workspaceId, this.name), () =>
            updateNarrativeIndex(k, this.workspaceId, this.name, (existing) => ({
              workspaceId: this.workspaceId,
              name: this.name,
              description: existing?.description,
              entryCount: (existing?.entryCount ?? 0) + 1,
              lastUpdated: new Date().toISOString(),
              tombstones: existing?.tombstones ?? [],
            })),
          );
          return parsed;
        },
      },
      entry,
    );
  }

  async read(opts?: { since?: string; limit?: number }): Promise<NarrativeEntry[]> {
    const sName = memoryStreamName(this.workspaceId, this.name);
    let totalMessages = 0;
    try {
      const jsm = await this.nc.jetstreamManager();
      const info = await jsm.streams.info(sName);
      totalMessages = Number(info.state.messages);
    } catch (err) {
      if (isStreamNotFound(err)) return [];
      throw err;
    }
    if (totalMessages === 0) return [];

    const k = await this.kv();
    const index = await readNarrativeIndex(k, this.workspaceId, this.name);
    const tombstones = new Set(index?.tombstones ?? []);

    const entries: NarrativeEntry[] = [];
    const consumer = await this.js().consumers.get(sName, {
      filterSubjects: memorySubject(this.workspaceId, this.name),
    });
    const iter = await consumer.fetch({ max_messages: totalMessages, expires: 5_000 });
    for await (const m of iter) {
      try {
        const parsed = NarrativeEntrySchema.parse(JSON.parse(dec.decode(m.data)));
        if (tombstones.has(parsed.id)) continue;
        entries.push(parsed);
      } catch (parseErr) {
        logger.warn("Skipping malformed narrative entry", {
          workspaceId: this.workspaceId,
          name: this.name,
          seq: m.seq,
          error: String(parseErr),
        });
      }
      if (entries.length + tombstones.size >= totalMessages) break;
    }

    let result = entries;
    if (opts?.since) {
      const sinceMs = Date.parse(opts.since);
      if (!Number.isNaN(sinceMs)) {
        result = result.filter((e) => Date.parse(e.createdAt) >= sinceMs);
      }
    }
    if (opts?.limit !== undefined && opts.limit >= 0) {
      result = result.slice(0, opts.limit);
    }
    return result;
  }

  search(_query: string, _opts?: SearchOpts): Promise<NarrativeEntry[]> {
    throw new Error("search not implemented for JetStream narrative store");
  }

  async forget(id: string): Promise<void> {
    const k = await this.kv();
    await enqueueIndex(memoryIndexKey(this.workspaceId, this.name), () =>
      updateNarrativeIndex(k, this.workspaceId, this.name, (existing) => {
        if (!existing) {
          return {
            workspaceId: this.workspaceId,
            name: this.name,
            entryCount: 0,
            lastUpdated: new Date().toISOString(),
            tombstones: [id],
          };
        }
        if (existing.tombstones.includes(id)) return existing;
        return {
          ...existing,
          tombstones: [...existing.tombstones, id],
          lastUpdated: new Date().toISOString(),
        };
      }),
    );
  }

  async render(): Promise<string> {
    const entries = await this.read();
    if (entries.length === 0) return "";
    const lines = entries.map((e) => `- [${e.createdAt}] ${e.text} (id: ${e.id})`);
    return `${lines.join("\n")}\n`;
  }
}

/**
 * Eager migration of legacy markdown narrative stores
 * (~/.atlas/memory/<wsId>/narrative/<name>/{MEMORY.md,entries.jsonl}) to
 * the JetStream stream + MEMORY_INDEX KV layout.
 *
 * Idempotent: a store whose MEMORY_INDEX KV entry exists is skipped.
 * On count mismatch the legacy directory is left in place so a retry
 * can pick it up.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  ensureMemoryIndexBucket,
  memoryIndexKey,
  memoryStreamName,
  memorySubject,
  type NarrativeIndexEntry,
} from "@atlas/adapters-md";
import { type NarrativeEntry, NarrativeEntrySchema } from "@atlas/agent-sdk";
import { logger } from "@atlas/logger";
import { isErrnoException, stringifyError } from "@atlas/utils";
import { getFridayHome } from "@atlas/utils/paths.server";
import { type NatsConnection, headers as natsHeaders, RetentionPolicy, StorageType } from "nats";

const SCHEMA_VERSION = "1";
const enc = new TextEncoder();
// Match the chat backend / broker max_payload (8MB). Memory entries are
// usually small, but the migration mustn't reject what the production
// adapter would accept.
const DEFAULT_MAX_MSG_SIZE = 8 * 1024 * 1024;
const DEFAULT_DUPLICATE_WINDOW_NS = 24 * 60 * 60 * 1_000_000_000;

function memoryRoot(): string {
  return join(getFridayHome(), "memory");
}

function isStreamNotFound(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err);
  return msg.includes("stream not found") || msg.includes("no stream");
}

async function readLegacyEntries(jsonlPath: string): Promise<NarrativeEntry[]> {
  let raw: string;
  try {
    raw = await readFile(jsonlPath, "utf-8");
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return [];
    throw err;
  }
  const entries: NarrativeEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(NarrativeEntrySchema.parse(JSON.parse(line)));
    } catch {
      // Skip corrupt lines
    }
  }
  return entries;
}

async function migrateOneNarrative(
  nc: NatsConnection,
  workspaceId: string,
  name: string,
  storeDir: string,
): Promise<void> {
  const kv = await ensureMemoryIndexBucket(nc);
  const key = memoryIndexKey(workspaceId, name);
  const existing = await kv.get(key);
  if (existing && existing.operation === "PUT") {
    logger.debug("Memory narrative already migrated, skipping", { workspaceId, name });
    return;
  }

  const entries = await readLegacyEntries(join(storeDir, "entries.jsonl"));
  const jsm = await nc.jetstreamManager();
  const sName = memoryStreamName(workspaceId, name);

  try {
    await jsm.streams.info(sName);
    await jsm.streams.purge(sName);
  } catch (err) {
    if (!isStreamNotFound(err)) throw err;
    await jsm.streams.add({
      name: sName,
      subjects: [memorySubject(workspaceId, name)],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      max_msg_size: DEFAULT_MAX_MSG_SIZE,
      duplicate_window: DEFAULT_DUPLICATE_WINDOW_NS,
    });
  }

  const js = nc.jetstream();
  for (const e of entries) {
    const h = natsHeaders();
    h.set("Friday-Schema-Version", SCHEMA_VERSION);
    h.set("Friday-Entry-Id", e.id);
    await js.publish(memorySubject(workspaceId, name), enc.encode(JSON.stringify(e)), {
      headers: h,
      msgID: e.id,
    });
  }

  const info = await jsm.streams.info(sName);
  if (Number(info.state.messages) !== entries.length) {
    throw new Error(
      `Memory migration count mismatch for ${workspaceId}/${name}: stream ${info.state.messages}, expected ${entries.length}`,
    );
  }

  const meta: NarrativeIndexEntry = {
    workspaceId,
    name,
    entryCount: entries.length,
    lastUpdated: new Date().toISOString(),
    tombstones: [],
  };
  await kv.put(key, enc.encode(JSON.stringify(meta)));

  await rm(storeDir, { recursive: true });
  logger.info("Migrated memory narrative", { workspaceId, name, entries: entries.length });
}

async function safeReaddir(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Walk ~/.atlas/memory/<workspaceId>/narrative/<name>/ and migrate each store
 * to JetStream. Other strategy directories (retrieval/dedup/kv) are left
 * alone — those backends were removed in the 2026-05 cleanup and there's
 * nothing to migrate.
 */
export async function migrateLegacyMemory(nc: NatsConnection): Promise<void> {
  const root = memoryRoot();
  const workspaces = await safeReaddir(root);
  let migrated = 0;
  let failed = 0;

  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    const narrativeDir = join(root, ws.name, "narrative");
    const stores = await safeReaddir(narrativeDir);
    for (const store of stores) {
      if (!store.isDirectory()) continue;
      try {
        await migrateOneNarrative(nc, ws.name, store.name, join(narrativeDir, store.name));
        migrated++;
      } catch (err) {
        logger.warn("Failed to migrate memory narrative", {
          workspaceId: ws.name,
          name: store.name,
          error: stringifyError(err),
        });
        failed++;
      }
    }
  }

  if (migrated || failed) {
    logger.info("Memory migration complete", { migrated, failed });
  }
}

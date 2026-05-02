/**
 * Lazy migration of legacy file-backed chats (~/.atlas/chats/*.json) to
 * JetStream stream + CHATS KV bucket.
 *
 * On daemon startup we walk the chat dir tree and migrate each chat that
 * doesn't already have a CHATS KV entry. Migration runs in the background
 * and yields between publishes so it doesn't block other workspace work.
 *
 * Idempotent: re-running after a partial failure picks up where the last
 * run left off (the KV entry is written last, so its presence means the
 * stream is fully populated).
 */

import type { Dirent } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { validateAtlasUIMessages } from "@atlas/agent-sdk";
import { logger } from "@atlas/logger";
import { isErrnoException, stringifyError } from "@atlas/utils";
import { getFridayHome } from "@atlas/utils/paths.server";
import { type NatsConnection, headers as natsHeaders, RetentionPolicy, StorageType } from "nats";
import { z } from "zod";

const SAFE_NAME_RE = /[^A-Za-z0-9_-]/g;
const sanitize = (s: string) => s.replace(SAFE_NAME_RE, "_");
const KV_BUCKET = "CHATS";
const SCHEMA_VERSION = "1";
const DEFAULT_MAX_MSG_SIZE = 8 * 1024 * 1024;
const DEFAULT_DUPLICATE_WINDOW_NS = 24 * 60 * 60 * 1_000_000_000;

const enc = new TextEncoder();

function streamName(workspaceId: string, chatId: string): string {
  return `CHAT_${sanitize(workspaceId)}_${sanitize(chatId)}`;
}

function chatSubject(workspaceId: string, chatId: string): string {
  return `chats.${workspaceId}.${chatId}.messages`;
}

const StoredChatSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  workspaceId: z.string().min(1),
  source: z.enum(["atlas", "slack", "discord", "telegram", "whatsapp", "teams"]),
  color: z.string().optional(),
  title: z.string().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  messages: z.array(z.unknown()),
  systemPromptContext: z
    .object({ timestamp: z.iso.datetime(), systemMessages: z.array(z.string()) })
    .optional(),
  contentFilteredMessageIds: z.array(z.string()).optional(),
});

function chatDir(): string {
  return join(getFridayHome(), "chats");
}

async function migrateOneFile(
  nc: NatsConnection,
  filePath: string,
  defaultWorkspaceId: string,
): Promise<void> {
  const raw = await readFile(filePath, "utf-8");
  const parsed = StoredChatSchema.parse(JSON.parse(raw));
  const messages = await validateAtlasUIMessages(parsed.messages);

  const workspaceId = parsed.workspaceId || defaultWorkspaceId;
  const chatId = parsed.id;

  const js = nc.jetstream();
  const kv = await js.views.kv(KV_BUCKET, { history: 5, storage: StorageType.File });
  const kvKey = `${workspaceId}/${chatId}`;

  const existing = await kv.get(kvKey);
  if (existing && existing.length > 0) {
    logger.debug("Chat already migrated, skipping", { chatId, workspaceId });
    return;
  }

  const jsm = await nc.jetstreamManager();
  const sName = streamName(workspaceId, chatId);
  try {
    await jsm.streams.info(sName);
    // Stream exists but no KV — partial migration. Purge and restart so the
    // count check at the end is reliable.
    await jsm.streams.purge(sName);
  } catch {
    await jsm.streams.add({
      name: sName,
      subjects: [chatSubject(workspaceId, chatId)],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      max_msg_size: DEFAULT_MAX_MSG_SIZE,
      duplicate_window: DEFAULT_DUPLICATE_WINDOW_NS,
    });
  }

  let skipped = 0;
  for (const m of messages) {
    const md = (m.metadata ?? {}) as { startTimestamp?: string; timestamp?: string };
    const ts = md.startTimestamp ?? md.timestamp ?? new Date().toISOString();
    const envelope = { message: m, ts };
    const h = natsHeaders();
    h.set("Friday-Schema-Version", SCHEMA_VERSION);
    h.set("Friday-Message-Id", m.id);
    try {
      await js.publish(chatSubject(workspaceId, chatId), enc.encode(JSON.stringify(envelope)), {
        headers: h,
        msgID: m.id,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Oversized individual messages can't be put on the broker even with
      // max_payload bumped to 8 MB. Skipping one message is better than
      // failing the whole chat and leaving it stuck in the legacy file
      // forever — the rest of the conversation is still useful. Log
      // loudly so the user can find what's missing if they care.
      if (/MAX_PAYLOAD_EXCEEDED|payload exceeded|too large/i.test(errMsg)) {
        logger.warn("Skipping oversized message during chat migration", {
          chatId,
          workspaceId,
          messageId: m.id,
          envelopeBytes: JSON.stringify(envelope).length,
        });
        skipped++;
        continue;
      }
      throw err;
    }
  }

  // Verify the stream count matches what we sent (minus oversized skips).
  // Mismatch = abort and leave the legacy file in place so a retry can pick
  // it up.
  const info = await jsm.streams.info(sName);
  const expected = messages.length - skipped;
  if (Number(info.state.messages) !== expected) {
    throw new Error(
      `Migration count mismatch for ${chatId}: stream has ${info.state.messages}, expected ${expected} (${skipped} oversized message(s) skipped)`,
    );
  }

  const meta = {
    id: parsed.id,
    userId: parsed.userId,
    workspaceId,
    source: parsed.source,
    color: parsed.color,
    title: parsed.title,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    systemPromptContext: parsed.systemPromptContext,
    contentFilteredMessageIds: parsed.contentFilteredMessageIds,
  };
  await kv.put(kvKey, enc.encode(JSON.stringify(meta)));

  // Move the legacy file aside rather than rm — if a future migration code
  // change discovers the move was wrong, it's recoverable.
  await rm(filePath);
  logger.info("Migrated chat", {
    chatId,
    workspaceId,
    messages: messages.length - skipped,
    skipped,
  });
}

/**
 * Walk ~/.atlas/chats/, migrating any legacy *.json files we find.
 * Global chats live at chats/<id>.json; workspace chats at
 * chats/<workspaceId>/<id>.json.
 */
export async function migrateLegacyChats(nc: NatsConnection): Promise<void> {
  const root = chatDir();
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return;
    throw err;
  }

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of entries) {
    const entryPath = join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith(".json")) {
      try {
        await migrateOneFile(nc, entryPath, "_global");
        migrated++;
      } catch (err) {
        logger.warn("Failed to migrate legacy chat", {
          path: entryPath,
          error: stringifyError(err),
        });
        failed++;
      }
    } else if (entry.isDirectory()) {
      const wsId = entry.name;
      try {
        const wsEntries = await readdir(entryPath, { withFileTypes: true });
        for (const wsEntry of wsEntries) {
          if (!wsEntry.isFile() || !wsEntry.name.endsWith(".json")) continue;
          try {
            await migrateOneFile(nc, join(entryPath, wsEntry.name), wsId);
            migrated++;
          } catch (err) {
            logger.warn("Failed to migrate workspace chat", {
              path: join(entryPath, wsEntry.name),
              workspaceId: wsId,
              error: stringifyError(err),
            });
            failed++;
          }
        }
      } catch (err) {
        if (!isErrnoException(err) || err.code !== "ENOENT") throw err;
      }
    } else {
      skipped++;
    }
  }

  if (migrated || failed) {
    logger.info("Chat migration complete", { migrated, skipped, failed });
  }
}

/**
 * Migration: re-key chat records with userId === "default-user".
 *
 * Pre-Phase-0.5, the daemon used the literal string "default-user" as
 * a fallback when no FRIDAY_KEY was configured. Phase 0.5 generates a
 * real nanoid for the local tenant and persists the pointer in the
 * USERS bucket. This migration finds chat records still stamped with
 * "default-user" and rewrites them to the resolved local user id, so
 * the chat audit trail stops reflecting the old sentinel.
 *
 * Idempotent: scans for the literal "default-user" each run; once
 * everything is rewritten, subsequent runs are no-ops.
 *
 * Note: only the `userId` field on chat metadata is touched. Stream
 * subjects, KV keys, and message contents are unaffected — chat KV
 * keys are `<workspaceId>/<chatId>`, not user-prefixed.
 */

import { ensureChatsKVBucket } from "@atlas/core/chat/storage";
import { UserStorage } from "@atlas/core/users/storage";
import type { Migration } from "jetstream";

const LEGACY_USER_ID = "default-user";
const enc = new TextEncoder();
const dec = new TextDecoder();

export const migration: Migration = {
  id: "20260504_025500_rekey_default_user_chats",
  name: "CHATS — re-key default-user records to local user nanoid",
  description:
    'Iterate the CHATS KV bucket, find entries with userId === "default-user" ' +
    "and rewrite the userId field to the resolved local user nanoid. KV keys " +
    "stay (they are workspace/chatId, not user-prefixed). Message stream " +
    "contents are unchanged.",
  async run({ nc, logger }) {
    const localUserResult = await UserStorage.resolveLocalUserId();
    if (!localUserResult.ok) {
      throw new Error(`Failed to resolve local user id: ${localUserResult.error}`);
    }
    const localUserId = localUserResult.data;

    const kv = await ensureChatsKVBucket(nc);

    // Collect ALL keys first. The original implementation interleaved
    // kv.get / kv.update calls inside the for-await loop on kv.keys() —
    // the NATS JS-KV consumer multiplexes the keys-stream with
    // request/reply traffic on the same subscription, so reads
    // performed mid-iteration caused later keys to silently drop out
    // of the iterator. Mirrors chat-jetstream-backend.ts:listAllMetadata.
    const allKeys: string[] = [];
    {
      const keysIter = await kv.keys();
      for await (const key of keysIter) {
        allKeys.push(key);
      }
    }

    let scanned = 0;
    let rewritten = 0;
    for (const key of allKeys) {
      scanned++;
      try {
        const entry = await kv.get(key);
        if (!entry || entry.operation !== "PUT") continue;
        const meta = JSON.parse(dec.decode(entry.value)) as Record<string, unknown>;
        if (meta.userId !== LEGACY_USER_ID) continue;
        meta.userId = localUserId;
        meta.updatedAt = new Date().toISOString();
        await kv.update(key, enc.encode(JSON.stringify(meta)), entry.revision);
        rewritten++;
      } catch (err) {
        logger.warn("Skipping malformed or racy chat metadata", { key, error: String(err) });
      }
    }

    logger.info("Re-key complete", { scanned, rewritten, localUserId });
  },
};

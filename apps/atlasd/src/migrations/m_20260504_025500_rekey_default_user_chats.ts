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
import { createJetStreamUserBackend } from "@atlas/core/users/storage";
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
    // Self-contained backend from `nc` — see provision_users_bucket for
    // the rationale (CLI migrate path doesn't init the facade).
    const users = createJetStreamUserBackend(nc);
    const localUserResult = await users.resolveLocalUserId();
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

    const MAX_CAS_ATTEMPTS = 5;
    let scanned = 0;
    let rewritten = 0;
    let legacyMatched = 0;
    let abandoned = 0;
    for (const key of allKeys) {
      scanned++;
      let isLegacy = false;
      for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt++) {
        let entry: Awaited<ReturnType<typeof kv.get>>;
        try {
          entry = await kv.get(key);
        } catch (err) {
          logger.warn("Skipping unreadable chat key", { key, error: String(err) });
          break;
        }
        if (!entry || entry.operation !== "PUT") break;

        let meta: Record<string, unknown>;
        try {
          meta = JSON.parse(dec.decode(entry.value)) as Record<string, unknown>;
        } catch (err) {
          logger.warn("Skipping malformed chat metadata JSON", { key, error: String(err) });
          break;
        }

        if (meta.userId !== LEGACY_USER_ID) break;
        if (!isLegacy) {
          isLegacy = true;
          legacyMatched++;
        }
        meta.userId = localUserId;
        meta.updatedAt = new Date().toISOString();
        try {
          await kv.update(key, enc.encode(JSON.stringify(meta)), entry.revision);
          rewritten++;
          break;
        } catch (err) {
          // Likely CAS conflict — re-read latest revision and try again.
          if (attempt >= MAX_CAS_ATTEMPTS) {
            logger.warn("Gave up after CAS retries", {
              key,
              attempts: attempt,
              error: String(err),
            });
            abandoned++;
          }
        }
      }
    }

    if (legacyMatched !== rewritten) {
      // Loud signal: don't silently mark the migration successful when
      // chats were left unrewritten. An operator must reconcile.
      logger.error("Re-key incomplete — some legacy chats not rewritten", {
        scanned,
        legacyMatched,
        rewritten,
        abandoned,
        localUserId,
      });
    } else {
      logger.info("Re-key complete", { scanned, rewritten, localUserId });
    }
  },
};

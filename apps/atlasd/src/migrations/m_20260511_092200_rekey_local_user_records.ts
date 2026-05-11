/**
 * Migration: re-key workspace registry + chat records whose owner is the
 * legacy literal `"local-user"`.
 *
 * The local-mode FRIDAY_KEY used to be seeded with `sub` /
 * `user_metadata.tempest_user_id` = `"local-user"` (a static string),
 * which any route writing identity through `/api/me` propagated into
 * downstream stores — most importantly `workspace.metadata.createdBy`
 * and chat-record `userId`. The canonical identity is the nanoid that
 * `UserStorage.resolveLocalUserId()` returns; the JWT is now rebuilt
 * at daemon startup to embed that nanoid. This migration brings the
 * pre-rebuild data forward.
 *
 * Idempotent: scans for the literal `"local-user"` each run; once
 * everything is rewritten, subsequent runs are no-ops. Mirrors the
 * structure of `m_20260504_025500_rekey_default_user_chats` (which
 * handled an earlier `"default-user"` sentinel) — the two are kept
 * separate so the audit trail names what each one cleaned up.
 */

import { ensureChatsKVBucket } from "@atlas/core/chat/storage";
import { UserStorage } from "@atlas/core/users/storage";
import type { Logger } from "@atlas/logger";
import { createJetStreamKVStorage, type KVStorage } from "@atlas/storage";
import { stringifyError } from "@atlas/utils";
import type { Migration } from "jetstream";

const LEGACY_USER_ID = "local-user";
const REGISTRY_BUCKET = "WORKSPACE_REGISTRY";
const REGISTRY_PREFIX = ["workspaces"] as const;
const enc = new TextEncoder();
const dec = new TextDecoder();

interface WorkspaceLike {
  id?: unknown;
  metadata?: { createdBy?: unknown } & Record<string, unknown>;
}

async function rekeyWorkspaceRegistry(
  storage: KVStorage,
  localUserId: string,
  logger: Logger,
): Promise<{ scanned: number; rewritten: number }> {
  let scanned = 0;
  let rewritten = 0;
  // Collect ids first; mutating mid-iteration on the JS-KV-backed list
  // iterator has the same multiplexing hazard called out in the chat
  // rekey migration (`m_20260504_025500`).
  const candidates: { id: string; value: WorkspaceLike }[] = [];
  for await (const entry of storage.list<WorkspaceLike>([...REGISTRY_PREFIX])) {
    scanned++;
    const value = entry.value;
    if (!value || typeof value !== "object") continue;
    const id = entry.key[entry.key.length - 1];
    if (typeof id !== "string") continue;
    if (value.metadata?.createdBy !== LEGACY_USER_ID) continue;
    candidates.push({ id, value });
  }
  for (const { id, value } of candidates) {
    try {
      const next: WorkspaceLike = {
        ...value,
        metadata: { ...(value.metadata ?? {}), createdBy: localUserId },
      };
      await storage.set([...REGISTRY_PREFIX, id], next);
      rewritten++;
    } catch (err) {
      logger.warn("Failed to rewrite workspace createdBy", { id, error: stringifyError(err) });
    }
  }
  return { scanned, rewritten };
}

export const migration: Migration = {
  id: "20260511_092200_rekey_local_user_records",
  name: 'workspace registry + chats — re-key "local-user" records to local user nanoid',
  description:
    'Scan the WORKSPACE_REGISTRY bucket and rewrite metadata.createdBy === "local-user" ' +
    'to the resolved local user nanoid. Scan the CHATS bucket and rewrite userId === "local-user" ' +
    "the same way. Idempotent — no-op once everything has been rewritten.",
  async run({ nc, logger }) {
    const localUserResult = await UserStorage.resolveLocalUserId();
    if (!localUserResult.ok) {
      throw new Error(`Failed to resolve local user id: ${localUserResult.error}`);
    }
    const localUserId = localUserResult.data;

    // Workspace registry.
    const registry = await createJetStreamKVStorage(nc, { bucket: REGISTRY_BUCKET, history: 5 });
    const registryResult = await rekeyWorkspaceRegistry(registry, localUserId, logger);
    logger.info("workspace registry re-key complete", {
      scanned: registryResult.scanned,
      rewritten: registryResult.rewritten,
      localUserId,
    });

    // Chats.
    const kv = await ensureChatsKVBucket(nc);
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
      logger.warn("chat re-key incomplete — some legacy chats not rewritten", {
        scanned,
        legacyMatched,
        rewritten,
        abandoned,
        localUserId,
      });
    } else {
      logger.info("chat re-key complete", { scanned, rewritten, localUserId });
    }
  },
};

/**
 * Migration: delete the legacy `SESSIONS` JetStream stream after dumping
 * its contents to a JSONL backup at
 * `~/.atlas/legacy-sessions-backup-<YYYY-MM-DD>.jsonl`.
 *
 * Background: PR #164 (2026-05-04) introduced `SESSION_EVENTS` with
 * subjects `sessions.>`, but left the legacy `SESSIONS` stream
 * (subjects `sessions.*.events`) in place. JetStream rejects the v2
 * stream creation at runtime because `sessions.*.events` ⊂ `sessions.>`
 * — subjects overlap. This migration retires the legacy stream so the
 * sibling `m_20260503_110300_sessions_v2_to_jetstream` migration (which
 * sorts immediately after this one) can create `SESSION_EVENTS`.
 *
 * Idempotent:
 *   - If `SESSIONS` doesn't exist, no-op (fresh installs, or reruns
 *     after success).
 *   - If a backup file at the chosen path already exists (rerun after
 *     a crash between backup-write and stream-delete), append a
 *     millisecond suffix so the prior backup is preserved.
 */

import { stringifyError } from "@atlas/utils";
import { getFridayHome } from "@atlas/utils/paths.server";
import { dec } from "jetstream";
import type { Migration } from "jetstream";
import { AckPolicy, DeliverPolicy } from "nats";
import { rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const STREAM_NAME = "SESSIONS";
const FETCH_BATCH = 500;
/** Auto-clean ephemeral consumer if we crash mid-fetch. */
const CONSUMER_INACTIVE_NS = 5_000_000_000;

interface BackupRecord {
  subject: string;
  seq: number;
  data: string;
  time: string;
}

async function uniqueBackupPath(base: string): Promise<string> {
  try {
    await stat(base);
  } catch {
    return base;
  }
  return `${base.replace(/\.jsonl$/, "")}-${Date.now()}.jsonl`;
}

export const migration: Migration = {
  id: "20260503_110250_remove_legacy_sessions_stream",
  name: "delete legacy SESSIONS stream (with JSONL backup)",
  description:
    "Drop the pre-PR-#164 SESSIONS stream (subjects sessions.*.events) " +
    "after dumping its contents to ~/.atlas/legacy-sessions-backup-" +
    "<YYYY-MM-DD>.jsonl. The retained subject namespace overlaps with " +
    "SESSION_EVENTS (subjects sessions.>) and blocks v2 stream creation. " +
    "Idempotent: no-op when SESSIONS is absent.",
  async run({ nc, js, logger }) {
    const info = await js.stream.info(STREAM_NAME);
    if (!info) {
      logger.debug("Legacy SESSIONS stream not present — nothing to retire");
      return;
    }

    const isoDate = new Date().toISOString().slice(0, 10);
    const baseBackupPath = join(getFridayHome(), `legacy-sessions-backup-${isoDate}.jsonl`);
    const backupPath = await uniqueBackupPath(baseBackupPath);
    const tmpPath = `${backupPath}.tmp`;

    const jsm = await nc.jetstreamManager();
    const consumerName = `legacy-sessions-backup-${Date.now()}`;
    await jsm.consumers.add(STREAM_NAME, {
      name: consumerName,
      deliver_policy: DeliverPolicy.All,
      ack_policy: AckPolicy.None,
      inactive_threshold: CONSUMER_INACTIVE_NS,
    });

    const records: BackupRecord[] = [];
    try {
      const jsClient = nc.jetstream();
      const consumer = await jsClient.consumers.get(STREAM_NAME, consumerName);
      const consumerInfo = await consumer.info();
      const total = Number(consumerInfo.num_pending);
      let received = 0;
      while (received < total) {
        const batch = await consumer.fetch({
          max_messages: Math.min(FETCH_BATCH, total - received),
          expires: 1000,
        });
        for await (const msg of batch) {
          received++;
          let data: string;
          try {
            data = dec.decode(msg.data);
          } catch {
            // Lossless fallback: encode raw bytes as base64 with a marker
            // prefix so a reader can distinguish from a UTF-8 payload.
            const b64 = btoa(String.fromCharCode(...msg.data));
            data = `__base64__:${b64}`;
          }
          const ms = Math.floor(Number(msg.info.timestampNanos) / 1_000_000);
          records.push({
            subject: msg.subject,
            seq: Number(msg.seq),
            data,
            time: new Date(ms).toISOString(),
          });
        }
      }
    } finally {
      try {
        await jsm.consumers.delete(STREAM_NAME, consumerName);
      } catch (err) {
        logger.warn("Failed to delete backup consumer; relying on inactive_threshold", {
          consumerName,
          error: stringifyError(err),
        });
      }
    }

    // Atomic-ish write: dump to .tmp then rename, so a crash mid-write
    // never leaves a partial file standing in for a successful backup.
    const body = records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : "");
    await writeFile(tmpPath, body, { encoding: "utf-8" });
    await rename(tmpPath, backupPath);

    await js.stream.delete(STREAM_NAME);

    logger.info("Retired legacy SESSIONS stream", {
      backupPath,
      messagesBackedUp: records.length,
    });
  },
};

/**
 * Migration: ~/.atlas/sessions-v2/<sid>/{events.jsonl, metadata.json}
 * → JetStream `SESSION_EVENTS` stream + `SESSION_METADATA` KV bucket
 * + `SESSION_INFLIGHT` KV bucket.
 *
 * Walks every session directory under `~/.atlas/sessions-v2/`:
 *   - publishes each line of `events.jsonl` to
 *     `sessions.<sid>.events` (subject under SESSION_EVENTS).
 *   - writes `metadata.json` (if present) into `SESSION_METADATA[sid]`.
 *   - if `events.jsonl` exists but `metadata.json` does not, writes
 *     a marker into `SESSION_INFLIGHT[sid]` so the daemon's startup
 *     `markInterruptedSessions()` will pick it up and finalize.
 *
 * Idempotent — checks `SESSION_METADATA[sid]` before publishing event
 * lines a second time. (The `appendEvent` happy path uses the marker;
 * once finalized in KV, we treat the session as done and skip
 * republish.) Legacy on-disk session dirs left in place for rollback.
 *
 * No-op if `~/.atlas/sessions-v2/` doesn't exist.
 */

import { join } from "node:path";
import { createJetStreamKVStorage } from "@atlas/storage";
import { stringifyError } from "@atlas/utils";
import { getFridayHome } from "@atlas/utils/paths.server";
import type { Migration } from "jetstream";
import { enc } from "jetstream";
import { RetentionPolicy, StorageType } from "nats";

const STREAM_NAME = "SESSION_EVENTS";
const SUBJECT_PREFIX = "sessions";
const METADATA_BUCKET = "SESSION_METADATA";
const INFLIGHT_BUCKET = "SESSION_INFLIGHT";
const NINETY_DAYS_NS = 90 * 24 * 60 * 60 * 1_000_000_000;
const SAFE_TOKEN_RE = /[^A-Za-z0-9_-]/g;

function sanitize(s: string): string {
  return s.replace(SAFE_TOKEN_RE, "_");
}

export const migration: Migration = {
  id: "20260503_110300_sessions_v2_to_jetstream",
  name: "sessions-v2 → SESSION_EVENTS stream + SESSION_METADATA KV",
  description:
    "Walk ~/.atlas/sessions-v2/<sid>/. For each session: publish " +
    "events.jsonl lines to subject sessions.<sid>.events under the " +
    "SESSION_EVENTS stream; copy metadata.json into the " +
    "SESSION_METADATA KV bucket; mark events-without-metadata in " +
    "SESSION_INFLIGHT so daemon startup finalizes them. Idempotent " +
    "via the metadata KV check. Legacy on-disk dirs left in place.",
  async run({ nc, logger }) {
    const sessionsRoot = join(getFridayHome(), "sessions-v2");

    let sessionDirs: string[];
    try {
      sessionDirs = [];
      for await (const entry of Deno.readDir(sessionsRoot)) {
        if (entry.isDirectory) sessionDirs.push(entry.name);
      }
    } catch {
      logger.debug("No legacy sessions-v2 dir — nothing to migrate", { path: sessionsRoot });
      return;
    }

    // Provision the stream + KV buckets up-front so the per-session loop
    // can stream-publish without per-message creates.
    const jsm = await nc.jetstreamManager();
    try {
      await jsm.streams.info(STREAM_NAME);
    } catch {
      await jsm.streams.add({
        name: STREAM_NAME,
        subjects: [`${SUBJECT_PREFIX}.>`],
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        max_age: NINETY_DAYS_NS,
      });
    }
    const metadataKV = await createJetStreamKVStorage(nc, { bucket: METADATA_BUCKET, history: 1 });
    const inflightKV = await createJetStreamKVStorage(nc, { bucket: INFLIGHT_BUCKET, history: 1 });

    const js = nc.jetstream();

    let migrated = 0;
    let skipped = 0;
    let interrupted = 0;
    let totalEvents = 0;

    for (const sessionId of sessionDirs) {
      // Idempotency: if we already have a finalized summary for this
      // session, skip the event republish + metadata write.
      const existingSummary = await metadataKV.get<unknown>([sessionId]);
      if (existingSummary) {
        skipped++;
        continue;
      }

      const sessionDir = join(sessionsRoot, sessionId);
      const eventsPath = join(sessionDir, "events.jsonl");
      const metadataPath = join(sessionDir, "metadata.json");

      let eventsContent: string | null = null;
      try {
        eventsContent = await Deno.readTextFile(eventsPath);
      } catch {
        // No events.jsonl — nothing to migrate for this session.
        continue;
      }

      // Publish each event line to the stream.
      let eventCount = 0;
      for (const line of eventsContent.split("\n")) {
        if (!line.trim()) continue;
        try {
          // We don't reparse — just trust + push the bytes back as-is.
          // The runtime adapter validates on read.
          await js.publish(`${SUBJECT_PREFIX}.${sanitize(sessionId)}.events`, enc.encode(line));
          eventCount++;
        } catch (err) {
          logger.warn("Failed to publish session event during migration", {
            sessionId,
            error: stringifyError(err),
          });
        }
      }
      totalEvents += eventCount;

      // metadata.json present → finalized session: copy to KV.
      // metadata.json absent → mark inflight so daemon startup finalizes.
      let metadataValue: unknown = null;
      try {
        const metaContent = await Deno.readTextFile(metadataPath);
        metadataValue = JSON.parse(metaContent);
      } catch {
        // No metadata file — leave for inflight handling below.
      }

      if (metadataValue !== null) {
        await metadataKV.set([sessionId], metadataValue);
        migrated++;
      } else if (eventCount > 0) {
        await inflightKV.set([sessionId], { startedAt: new Date().toISOString() });
        interrupted++;
      }
    }

    logger.info("sessions-v2 migration complete", {
      sessionsMigrated: migrated,
      sessionsSkipped: skipped,
      sessionsMarkedInterrupted: interrupted,
      totalEventsPublished: totalEvents,
    });
  },
};

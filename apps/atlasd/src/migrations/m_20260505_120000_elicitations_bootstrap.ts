/**
 * Migration: bootstrap the JetStream surfaces for elicitations.
 *
 * Phase 12 (foundation) of the Bucket-3 plan. Provisions the
 * `ELICITATIONS` stream + `ELICITATION_STATUS` KV bucket so the
 * runtime adapter (`packages/core/src/elicitations/jetstream-adapter.ts`)
 * can publish without per-call create overhead.
 *
 * Idempotent — both creates short-circuit when the surfaces already
 * exist. Harmless to run before any elicitation is emitted: the
 * bucket and stream sit empty until the runtime suspend/resume layer
 * (a follow-on phase) starts publishing.
 *
 * No legacy data to backfill (this is a new primitive).
 */

import type { Migration } from "jetstream";
import { isStreamNotFound } from "jetstream";
import { RetentionPolicy, StorageType } from "nats";

const STREAM_NAME = "ELICITATIONS";
const SUBJECT_PREFIX = "elicitations";
const KV_BUCKET = "ELICITATION_STATUS";
const KV_HISTORY = 5;

export const migration: Migration = {
  id: "20260505_120000_elicitations_bootstrap",
  name: "elicitations → JetStream stream + KV status bucket",
  description:
    "Provision the ELICITATIONS file-backed Limits-retention stream " +
    "(subjects elicitations.<workspaceId>.<sessionId>.<elicitationId>, " +
    "per-message TTL via Nats-TTL header) and the ELICITATION_STATUS " +
    "KV bucket keyed by elicitationId. No data backfill — elicitations " +
    "are a new primitive introduced by Phase 12 of the Bucket-3 plan.",
  async run({ nc, logger }) {
    const jsm = await nc.jetstreamManager();
    try {
      await jsm.streams.info(STREAM_NAME);
      logger.debug("ELICITATIONS stream already exists — skipping create");
    } catch (err) {
      if (!isStreamNotFound(err)) throw err;
      await jsm.streams.add({
        name: STREAM_NAME,
        subjects: [`${SUBJECT_PREFIX}.>`],
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        // Coarse upper-bound retention. The runtime adapter publishes
        // with per-message `Nats-TTL` headers derived from each
        // elicitation's `expiresAt`; this max_age caps how long
        // declined/answered envelopes hang around for the Activity
        // page audit feed.
        max_age: 7 * 24 * 60 * 60 * 1_000_000_000,
      });
      logger.info("Created ELICITATIONS stream", { name: STREAM_NAME });
    }

    // views.kv is idempotent: gets-or-creates. No info() probe needed.
    const js = nc.jetstream();
    await js.views.kv(KV_BUCKET, { history: KV_HISTORY, storage: StorageType.File });
    logger.debug("Ensured ELICITATION_STATUS KV bucket", { bucket: KV_BUCKET });
  },
};

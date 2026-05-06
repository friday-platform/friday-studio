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
    // Stream config: `allow_msg_ttl: true` is REQUIRED for NATS 2.11+ to
    // accept publishes carrying the `Nats-TTL` header — without it,
    // every elicitation create() fails with "per-message ttl is
    // disabled". The adapter (`packages/core/src/elicitations/jetstream-
    // adapter.ts`) sets this same flag on its own create path, but only
    // helps when the adapter's create runs first; the migration usually
    // wins. Keep the configs aligned and call streams.update() when the
    // stream already exists to self-heal upgrades from earlier daemons.
    const cfg = {
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
      // The nats.js v2.29 StreamConfig type doesn't expose this field
      // yet (server-side JSON only) — cast through unknown.
      allow_msg_ttl: true,
    } as unknown as Parameters<typeof jsm.streams.add>[0];
    try {
      await jsm.streams.info(STREAM_NAME);
      // Stream exists — update in-place so legacy daemons gain the
      // allow_msg_ttl: true flag.
      await jsm.streams.update(STREAM_NAME, cfg);
      logger.debug("ELICITATIONS stream updated to current config");
    } catch (err) {
      if (!isStreamNotFound(err)) throw err;
      await jsm.streams.add(cfg);
      logger.info("Created ELICITATIONS stream", { name: STREAM_NAME });
    }

    // views.kv is idempotent: gets-or-creates. No info() probe needed.
    const js = nc.jetstream();
    await js.views.kv(KV_BUCKET, { history: KV_HISTORY, storage: StorageType.File });
    logger.debug("Ensured ELICITATION_STATUS KV bucket", { bucket: KV_BUCKET });
  },
};

/**
 * Migration: bootstrap the JetStream surfaces for durable
 * human-in-the-loop elicitations.
 *
 * Provisions the `ELICITATIONS` stream plus the `ELICITATION_STATUS` and
 * `TOOL_ACCESS_GRANTS` KV buckets so runtime adapters can publish/persist
 * without per-call create overhead.
 *
 * Idempotent — both creates short-circuit when the surfaces already
 * exist. Harmless to run before any elicitation is emitted: the bucket
 * and stream sit empty until request_tool_access/request_human_input
 * creates the first pending item.
 *
 * No legacy data to backfill (this is a new primitive).
 */

import {
  bootstrapElicitationsStream,
  bootstrapToolAccessGrantStorage,
} from "@atlas/core/elicitations";
import type { Migration } from "jetstream";
import { StorageType } from "nats";

const KV_BUCKET = "ELICITATION_STATUS";
const KV_HISTORY = 5;
const TOOL_ACCESS_GRANTS_BUCKET = "TOOL_ACCESS_GRANTS";

export const migration: Migration = {
  id: "20260505_120000_elicitations_bootstrap",
  name: "elicitations → JetStream stream + KV status bucket",
  description:
    "Provision the ELICITATIONS file-backed Limits-retention stream " +
    "(subjects elicitations.<workspaceId>.<sessionId>.<elicitationId>, " +
    "per-message TTL via Nats-TTL header), the ELICITATION_STATUS " +
    "KV bucket keyed by elicitationId, and TOOL_ACCESS_GRANTS for " +
    "durable allow-always decisions. No data backfill — elicitations " +
    "are a new durable HITL primitive.",
  async run({ nc, logger }) {
    // Single source of truth for stream config lives next to the
    // adapter so the adapter's validate-only `ensureStream` check stays
    // in sync. `allow_msg_ttl: true` is REQUIRED for NATS 2.11+ to
    // accept publishes carrying the `Nats-TTL` header — without it,
    // every elicitation create() fails with "per-message ttl is
    // disabled". The helper does create-or-update so legacy daemons
    // self-heal on upgrade.
    await bootstrapElicitationsStream(nc);
    logger.debug("ELICITATIONS stream provisioned");

    // views.kv is idempotent: gets-or-creates. No info() probe needed.
    const js = nc.jetstream();
    await js.views.kv(KV_BUCKET, { history: KV_HISTORY, storage: StorageType.File });
    logger.debug("Ensured ELICITATION_STATUS KV bucket", { bucket: KV_BUCKET });

    await bootstrapToolAccessGrantStorage(nc);
    logger.debug("Ensured persistent tool-access grants KV bucket", {
      bucket: TOOL_ACCESS_GRANTS_BUCKET,
    });
  },
};

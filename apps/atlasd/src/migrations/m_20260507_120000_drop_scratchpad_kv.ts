/**
 * Migration: drop the orphaned `SCRATCHPAD` KV bucket.
 *
 * The scratchpad surface (adapter + chat-side platform tools + atlas-cli
 * `--kind scratchpad` arm) was removed in the K1 commit
 * (`refactor(agent-sdk): remove unsupported scratchpad tools`). The
 * earlier scratchpad-to-jetstream migration (`m_20260502_140500_*`)
 * cannot be deleted (shipped to existing installs), so the KV bucket
 * persists empty on those daemons. This migration drops it.
 *
 * Idempotent: KV manager rejects deletion of a missing bucket with a
 * "stream not found" error; we catch and treat as a no-op.
 *
 * Fresh installs never create the bucket because the K1 deletion also
 * removed every code path that called `jsm.kvm.create("SCRATCHPAD")`.
 * This migration only matters for daemons that ran the prior scratchpad
 * migration before K1 landed.
 */

import { stringifyError } from "@atlas/utils";
import type { Migration } from "jetstream";

// JetStream KV buckets are backed by streams named `KV_<bucket>`. Deleting
// the underlying stream removes the bucket.
const TARGET_KV_STREAM = "KV_SCRATCHPAD";

export const migration: Migration = {
  id: "20260507_120000_drop_scratchpad_kv",
  name: "drop orphaned SCRATCHPAD KV bucket",
  description:
    "K1 removed the scratchpad adapter + tools; the JetStream KV bucket persisted empty " +
    "on daemons that ran the prior `m_20260502_140500_scratchpad_to_jetstream` migration. " +
    "Drops the underlying KV_SCRATCHPAD stream. No-op on fresh installs and on installs " +
    "where the bucket is already gone.",
  async run({ nc, logger }) {
    const jsm = await nc.jetstreamManager();
    try {
      await jsm.streams.delete(TARGET_KV_STREAM);
      logger.info("Dropped orphaned SCRATCHPAD KV bucket", { stream: TARGET_KV_STREAM });
    } catch (err) {
      const msg = stringifyError(err);
      // Stream already absent — fresh install or already cleaned. Idempotent no-op.
      if (msg.includes("not found") || msg.includes("does not exist") || msg.includes("404")) {
        logger.debug("KV_SCRATCHPAD stream not present — nothing to remove", {
          stream: TARGET_KV_STREAM,
        });
        return;
      }
      throw err;
    }
  },
};

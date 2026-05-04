/**
 * Migration: SESSIONS stream durability upgrade.
 *
 * Introduced post-commit a6ab40b. Pre-2026-05-02 the SESSIONS stream
 * was created with `StorageType.Memory` + `max_age: 24h`. Both lose
 * data on broker restart and are wrong for any production use.
 *
 *   - Fresh installs: `ensureSessionsStream()` now creates File + 30d
 *     directly, so this migration is a no-op for them.
 *   - Upgraded installs: stream exists with the old config. We add
 *     `max_age` if missing via `streams.update`. Storage type CAN'T be
 *     changed via update; if storage is Memory we log a warning rather
 *     than auto-recreate (recreating drops in-flight session events).
 *
 * Idempotent: re-running checks current config and only updates if
 * still on the old shape.
 */

import type { Migration } from "jetstream";
import { StorageType } from "nats";

const THIRTY_DAYS_NS = 30 * 24 * 60 * 60 * 1_000_000_000;

export const migration: Migration = {
  id: "20260502_140000_sessions_stream_upgrade",
  name: "SESSIONS stream durability upgrade",
  description:
    "Add max_age: 30d to the existing SESSIONS stream if missing; warn if " +
    "storage is still Memory (operator must manually recreate to switch to " +
    "File). New installs already get File + 30d at creation time.",
  async run({ js, logger }) {
    const info = await js.stream.info("SESSIONS");
    if (!info) {
      // Stream doesn't exist yet — fresh install. ensureSessionsStream()
      // creates it with the right config; nothing to do here.
      logger.debug("SESSIONS stream not present — nothing to upgrade");
      return;
    }
    const cfg = info.config;
    if (Number(cfg.max_age ?? 0) === 0) {
      await js.stream.update("SESSIONS", { max_age: THIRTY_DAYS_NS });
      logger.info("Upgraded SESSIONS stream max_age to 30d");
    }
    if (cfg.storage === StorageType.Memory) {
      logger.warn(
        "SESSIONS stream is using StorageType.Memory — session history is " +
          "lost on broker restart. Recreate as File storage when convenient: " +
          "`nats stream backup SESSIONS && nats stream rm SESSIONS && restart daemon`.",
      );
    }
  },
};

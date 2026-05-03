/**
 * Consolidated 0.1.1 → current migration manifest.
 *
 * Order is canonical — each entry runs once, in this order, and is
 * tracked in the `_FRIDAY_MIGRATIONS` JetStream KV bucket. New migrations
 * append to the bottom; never reorder or rename existing entries.
 *
 * IDs are commit SHAs (not tags) — tags are created after the fact, SHAs
 * are stable from the moment a commit exists. When adding a new
 * migration, commit the file with the placeholder ID `__pending__`,
 * then `git log -n 1 --format=%h` and amend the commit with the real
 * SHA before pushing.
 *
 * Wire-up: `AtlasDaemon.initialize()` calls `runMigrations(nc, ALL_MIGRATIONS, logger)`
 * at startup. CLI: `atlas migrate` runs the same. Both are idempotent —
 * already-completed migrations are skipped via the audit-trail KV.
 */

import type { Migration } from "jetstream";
import { m_9c0f0fd_chat_jetstream } from "./m_9c0f0fd_chat_jetstream.ts";
import { m_7492ae5_memory_jetstream } from "./m_7492ae5_memory_jetstream.ts";
import { m_a6ab40b_sessions_stream_upgrade } from "./m_a6ab40b_sessions_stream_upgrade.ts";
import { m_f9536a1_delete_activity_db } from "./m_f9536a1_delete_activity_db.ts";

export const ALL_MIGRATIONS: Migration[] = [
  // 2026-05 — chat + memory storage moves to JetStream
  m_9c0f0fd_chat_jetstream,
  m_7492ae5_memory_jetstream,
  // 2026-05-02 — durability upgrade for the SESSIONS stream
  m_a6ab40b_sessions_stream_upgrade,
  // 2026-05-02 — delete orphaned activity.db after activity subsystem deletion
  m_f9536a1_delete_activity_db,
];

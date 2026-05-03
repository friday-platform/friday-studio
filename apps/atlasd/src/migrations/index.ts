/**
 * Consolidated 0.1.1 → current migration manifest.
 *
 * Order is canonical — each entry runs once, in this order, and is
 * tracked in the `_FRIDAY_MIGRATIONS` JetStream KV bucket. New migrations
 * append to the bottom; never reorder or rename existing entries.
 *
 * **ID convention (revised 2026-05-02): use a permanent slug, not the
 * commit SHA.** The earlier "amend with real SHA after commit" dance
 * was a footgun — the SHA changes every time you amend (lint fix,
 * commit-message edit), so the audit trail accumulates orphan records
 * and you can't tell from the file alone which id ran. Slug ids
 * (`mcp-registry-to-jetstream`, `cron-timers-to-jetstream`) are
 * stable from the moment of authoring. The legacy SHA-id entries
 * already in audit trails on existing installs (`9c0f0fd`, `7492ae5`,
 * `a6ab40b-sessions`, `f9536a1`, `e4b4182`) are left as-is — they're
 * already recorded.
 *
 * Wire-up: `AtlasDaemon.initialize()` calls `runMigrations(nc, ALL_MIGRATIONS, logger)`
 * at startup. CLI: `atlas migrate` runs the same. Both are idempotent —
 * already-completed migrations are skipped via the audit-trail KV.
 */

import type { Migration } from "jetstream";
import { m_9c0f0fd_chat_jetstream } from "./m_9c0f0fd_chat_jetstream.ts";
import { m_7492ae5_memory_jetstream } from "./m_7492ae5_memory_jetstream.ts";
import { m_a6ab40b_sessions_stream_upgrade } from "./m_a6ab40b_sessions_stream_upgrade.ts";
import { m_artifacts_to_jetstream } from "./m_artifacts_to_jetstream.ts";
import { m_cron_timers_to_jetstream } from "./m_cron_timers_to_jetstream.ts";
import { m_drop_legacy_storage_db } from "./m_drop_legacy_storage_db.ts";
import { m_e4b4182_mcp_registry_to_jetstream } from "./m_e4b4182_mcp_registry_to_jetstream.ts";
import { m_f9536a1_delete_activity_db } from "./m_f9536a1_delete_activity_db.ts";
import { m_repair_artifact_object_store } from "./m_repair_artifact_object_store.ts";
import { m_scratchpad_to_jetstream } from "./m_scratchpad_to_jetstream.ts";
import { m_workspace_registry_to_jetstream } from "./m_workspace_registry_to_jetstream.ts";
import { m_workspace_state_to_jetstream } from "./m_workspace_state_to_jetstream.ts";

export const ALL_MIGRATIONS: Migration[] = [
  // 2026-05 — chat + memory storage moves to JetStream
  m_9c0f0fd_chat_jetstream,
  m_7492ae5_memory_jetstream,
  // 2026-05-02 — durability upgrade for the SESSIONS stream
  m_a6ab40b_sessions_stream_upgrade,
  // 2026-05-02 — delete orphaned activity.db after activity subsystem deletion
  m_f9536a1_delete_activity_db,
  // 2026-05-02 — Deno KV → JetStream KV consolidation, step 1: MCP registry
  m_e4b4182_mcp_registry_to_jetstream,
  // 2026-05-02 — Deno KV → JetStream KV consolidation, step 2: cron timers
  m_cron_timers_to_jetstream,
  // 2026-05-02 — Deno KV → JetStream KV consolidation, step 3: workspace registry
  m_workspace_registry_to_jetstream,
  // 2026-05-02 — Deno KV → JetStream KV consolidation, step 4: scratchpad
  m_scratchpad_to_jetstream,
  // 2026-05-02 — Deno KV → JetStream KV consolidation, step 5: artifacts
  // (also moves blob bytes into the JetStream Object Store, not just metadata)
  m_artifacts_to_jetstream,
  // 2026-05-02 — Final step: delete the legacy SQLite KV files now that
  // every surface above has been migrated. MUST stay last in the manifest.
  m_drop_legacy_storage_db,
  // 2026-05-03 — Recovery for the artifacts-to-jetstream bug (os.info()
  // null-on-missing was misread as "present", skipping every blob put).
  // Walks on-disk artifact files + republishes any missing blobs to
  // the Object Store. Idempotent. Listed AFTER drop-legacy-storage-db
  // because it doesn't need the legacy SQLite at all — only on-disk
  // file roots.
  m_repair_artifact_object_store,
  // 2026-05-03 — Workspace state.db (used by state_* MCP tools) →
  // per-workspace JetStream KV bucket WS_STATE_<wsid>. Idempotent
  // marker per bucket; legacy SQLite left in place for rollback.
  m_workspace_state_to_jetstream,
];

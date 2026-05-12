/**
 * Static migration manifest.
 *
 * Every `m_<id>.ts` file in this directory is a migration. The id is
 * the filename without the `m_` prefix and `.ts` suffix; the file
 * exports a `migration: Migration` whose `id` field matches the
 * filename. Run order is the lexicographic sort of the ids — which
 * means **timestamp ordering** if the convention is followed.
 *
 * **ID convention** (locked-in 2026-05-03 — the legacy SHA-prefix +
 * manual-slug ids were renamed in this PR; first-merge users have
 * never seen the old ids):
 *
 *   m_YYYYMMDD_HHMMSS_descriptive_slug.ts
 *
 * - `YYYYMMDD_HHMMSS` is the UTC timestamp at authoring time.
 * - `descriptive_slug` is lowercase + underscore-separated.
 * - The id stored in `_FRIDAY_MIGRATIONS` KV is the same string
 *   without the `m_` prefix or `.ts` suffix.
 *
 * **Once a migration ships, NEVER rename or delete the file.** Doing
 * so orphans audit-trail records on every existing install + breaks
 * idempotency. `index.test.ts` enforces the filename↔id convention
 * AND that every `m_*.ts` on disk appears in the manifest below; CI
 * fails if either is violated.
 *
 * **Why static imports, not `readdir`:** the daemon ships as a
 * `deno compile` binary. At runtime, `import.meta.url` resolves into
 * Deno's compile-internal virtual FS, and `readdir` on it returns
 * nothing — so a discover-by-filesystem loader silently runs zero
 * migrations against shipped installs. Static imports put every
 * migration into the compile graph and survive bundling.
 */
import type { Migration } from "jetstream";

import { migration as m_20260501_120000_chat_to_jetstream } from "./m_20260501_120000_chat_to_jetstream.ts";
import { migration as m_20260501_120100_memory_to_jetstream } from "./m_20260501_120100_memory_to_jetstream.ts";
import { migration as m_20260502_140000_sessions_stream_upgrade } from "./m_20260502_140000_sessions_stream_upgrade.ts";
import { migration as m_20260502_140100_delete_activity_db } from "./m_20260502_140100_delete_activity_db.ts";
import { migration as m_20260502_140200_mcp_registry_to_jetstream } from "./m_20260502_140200_mcp_registry_to_jetstream.ts";
import { migration as m_20260502_140300_cron_timers_to_jetstream } from "./m_20260502_140300_cron_timers_to_jetstream.ts";
import { migration as m_20260502_140400_workspace_registry_to_jetstream } from "./m_20260502_140400_workspace_registry_to_jetstream.ts";
import { migration as m_20260502_140500_scratchpad_to_jetstream } from "./m_20260502_140500_scratchpad_to_jetstream.ts";
import { migration as m_20260502_140600_artifacts_to_jetstream } from "./m_20260502_140600_artifacts_to_jetstream.ts";
import { migration as m_20260502_140700_drop_legacy_storage_db } from "./m_20260502_140700_drop_legacy_storage_db.ts";
import { migration as m_20260503_100000_repair_artifact_object_store } from "./m_20260503_100000_repair_artifact_object_store.ts";
import { migration as m_20260503_110000_workspace_state_to_jetstream } from "./m_20260503_110000_workspace_state_to_jetstream.ts";
import { migration as m_20260503_110100_skills_to_jetstream } from "./m_20260503_110100_skills_to_jetstream.ts";
import { migration as m_20260503_110200_document_store_to_jetstream } from "./m_20260503_110200_document_store_to_jetstream.ts";
import { migration as m_20260503_110250_remove_legacy_sessions_stream } from "./m_20260503_110250_remove_legacy_sessions_stream.ts";
import { migration as m_20260503_110300_sessions_v2_to_jetstream } from "./m_20260503_110300_sessions_v2_to_jetstream.ts";
import { migration as m_20260504_025000_provision_users_bucket } from "./m_20260504_025000_provision_users_bucket.ts";
import { migration as m_20260504_025500_rekey_default_user_chats } from "./m_20260504_025500_rekey_default_user_chats.ts";
import { migration as m_20260505_120000_elicitations_bootstrap } from "./m_20260505_120000_elicitations_bootstrap.ts";
import { migration as m_20260507_120000_drop_scratchpad_kv } from "./m_20260507_120000_drop_scratchpad_kv.ts";
import { migration as m_20260511_110800_provision_workspace_members } from "./m_20260511_110800_provision_workspace_members.ts";
import { migration as m_20260511_120000_cleanup_userid_as_name } from "./m_20260511_120000_cleanup_userid_as_name.ts";

/**
 * Static manifest. Ordered by id ascending — keep new entries in
 * lexicographic position. `getAllMigrations()` re-sorts by id before
 * returning, so an accidentally out-of-order insert here is benign;
 * `runMigrations` itself iterates the array in input order. A
 * missing entry, in contrast, is silently broken on shipped binaries
 * (the dynamic loader before this change hid the same class of
 * failure for `deno compile`).
 */
const MIGRATIONS: readonly Migration[] = [
  m_20260501_120000_chat_to_jetstream,
  m_20260501_120100_memory_to_jetstream,
  m_20260502_140000_sessions_stream_upgrade,
  m_20260502_140100_delete_activity_db,
  m_20260502_140200_mcp_registry_to_jetstream,
  m_20260502_140300_cron_timers_to_jetstream,
  m_20260502_140400_workspace_registry_to_jetstream,
  m_20260502_140500_scratchpad_to_jetstream,
  m_20260502_140600_artifacts_to_jetstream,
  m_20260502_140700_drop_legacy_storage_db,
  m_20260503_100000_repair_artifact_object_store,
  m_20260503_110000_workspace_state_to_jetstream,
  m_20260503_110100_skills_to_jetstream,
  m_20260503_110200_document_store_to_jetstream,
  m_20260503_110250_remove_legacy_sessions_stream,
  m_20260503_110300_sessions_v2_to_jetstream,
  m_20260504_025000_provision_users_bucket,
  m_20260504_025500_rekey_default_user_chats,
  m_20260505_120000_elicitations_bootstrap,
  m_20260507_120000_drop_scratchpad_kv,
  m_20260511_110800_provision_workspace_members,
  m_20260511_120000_cleanup_userid_as_name,
];

/**
 * Return every migration in id order. Async-shaped for back-compat
 * with the previous `readdir + dynamic import` loader; daemon and CLI
 * both `await` it.
 */
export function getAllMigrations(): Promise<Migration[]> {
  return Promise.resolve([...MIGRATIONS].sort((a, b) => a.id.localeCompare(b.id)));
}

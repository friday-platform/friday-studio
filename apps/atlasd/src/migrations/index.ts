/**
 * Auto-discovered migration manifest.
 *
 * Every `m_<id>.ts` file in this directory is a migration. The id is
 * the filename without the `m_` prefix and `.ts` suffix; the file
 * exports a `migration: Migration` whose `id` field matches the
 * filename. Run order is the lexicographic sort of the filenames —
 * which means **timestamp ordering** if the convention is followed.
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
 * Why timestamp-prefixed: lexicographic sort = chronological sort
 * (no manual array maintenance), parallel-branch authors get
 * distinct ids without renumbering, and the id self-documents when
 * the migration was authored.
 *
 * **Once a migration ships, NEVER rename or delete the file.** Doing
 * so orphans audit-trail records on every existing install + breaks
 * idempotency. The unit test in `index.test.ts` enforces the
 * filename↔id convention; CI fails if you violate it.
 */

import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Migration } from "jetstream";

/**
 * Discover and return all migrations in this directory, sorted by id
 * (which equals the filename prefix, which is the timestamp). Async
 * because dynamic imports are async; daemon awaits this once at
 * startup and the CLI awaits it before invoking `runMigrations`.
 */
export async function getAllMigrations(): Promise<Migration[]> {
  const dir = new URL(".", import.meta.url);
  const dirPath = fileURLToPath(dir);
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith("m_") || !entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts")) continue;
    files.push(entry.name);
  }
  files.sort();

  const migrations: Migration[] = [];
  for (const file of files) {
    const mod = (await import(new URL(file, dir).href)) as { migration?: Migration };
    if (!mod.migration) {
      throw new Error(
        `Migration file ${file} does not export a \`migration\` const. ` +
          `Every m_*.ts file in apps/atlasd/src/migrations/ must export ` +
          `\`export const migration: Migration = { id: "...", ... }\`.`,
      );
    }
    migrations.push(mod.migration);
  }
  return migrations;
}

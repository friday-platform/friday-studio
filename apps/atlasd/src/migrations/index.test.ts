/**
 * Convention enforcement for migration files.
 *
 * Catches the failure modes that would otherwise only surface at
 * daemon startup (or, worse, silently re-run a migration that was
 * accidentally renamed):
 *
 *  1. Filename matches `m_YYYYMMDD_HHMMSS_lowercase_slug.ts`.
 *  2. The file declares `export const migration:` AND `id: "..."`,
 *     and the id string equals the filename prefix.
 *  3. No two filenames produce the same id.
 *
 * Reads file content as text rather than dynamic-importing because
 * several migrations transitively pull `@db/sqlite` (Deno-only) and
 * would crash a vitest run on import. This file's job is convention
 * enforcement; runtime correctness is covered by the per-adapter
 * tests + the migration-runner integration test.
 */

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FILENAME_RE = /^m_(\d{8}_\d{6}_[a-z][a-z0-9_]*)\.ts$/;

async function listMigrationFiles(): Promise<string[]> {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.startsWith("m_") && e.name.endsWith(".ts"))
    .filter((e) => !e.name.endsWith(".test.ts"))
    .map((e) => e.name);
}

async function readFileContent(name: string): Promise<string> {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  return await readFile(`${dir}/${name}`, "utf-8");
}

/**
 * Extract the `id` field of a `Migration` literal in the file. We only
 * scan top-level `id: "..."` lines; the schema fields nested inside
 * Zod definitions also use `id:` but live indented under `z.object({`,
 * so we anchor on the `^  id: "<...>"` shape that matches the
 * Migration literal we control.
 */
function extractMigrationId(source: string): string | null {
  const match = source.match(/^ {2}id: "([^"]+)",/m);
  return match?.[1] ?? null;
}

describe("migration manifest convention", () => {
  it("each m_*.ts filename matches the YYYYMMDD_HHMMSS_slug shape", async () => {
    const files = await listMigrationFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file, `${file} must match m_<YYYYMMDD>_<HHMMSS>_<slug>.ts`).toMatch(FILENAME_RE);
    }
  });

  it("each file exports `migration` and the literal id matches the filename prefix", async () => {
    const files = await listMigrationFiles();
    for (const file of files) {
      const content = await readFileContent(file);
      expect(content, `${file} must export \`migration: Migration\``).toMatch(
        /export const migration:\s*Migration\s*=/,
      );
      const filenameId = file.match(FILENAME_RE)?.[1];
      expect(filenameId, `${file}: failed to derive id from filename`).toBeTruthy();
      const fileId = extractMigrationId(content);
      expect(fileId, `${file} must declare \`  id: "<id>",\``).not.toBeNull();
      expect(fileId, `${file} id "${fileId}" must equal filename prefix "${filenameId}"`).toBe(
        filenameId,
      );
    }
  });

  it("no two files declare the same migration id", async () => {
    const files = await listMigrationFiles();
    const ids: string[] = [];
    for (const file of files) {
      const content = await readFileContent(file);
      const id = extractMigrationId(content);
      if (id) ids.push(id);
    }
    expect(ids.length, "every file should declare an id").toBe(files.length);
    expect(new Set(ids).size, "duplicate migration ids detected").toBe(ids.length);
  });
});

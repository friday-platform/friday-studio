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

/**
 * Slice the body of the `MIGRATIONS` array literal in `index.ts` and
 * strip `//` line comments. Lets the manifest check look for `m_<id>`
 * inside the array specifically — a bare `m_<id>` reference in a doc
 * comment elsewhere in the file (or a temporarily-commented-out entry
 * inside the array) would otherwise satisfy a whole-file scan and let
 * a missing array entry through. Local to this test file; the unit
 * tests below cover it directly so we don't have to re-read the real
 * `index.ts` to verify the predicate.
 */
function extractMigrationsArrayBody(indexSource: string): string | null {
  const re = /const MIGRATIONS:\s*readonly Migration\[\]\s*=\s*\[([\s\S]*?)\];/;
  const slice = indexSource.match(re)?.[1];
  if (slice === undefined) return null;
  return slice.replace(/\/\/.*$/gm, "");
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

  /**
   * The static manifest in `index.ts` is what ships in the compiled
   * binary; `readdir`-based discovery returns nothing under
   * `deno compile`. So a forgotten manifest entry would silently skip
   * a migration on every install. Scan `index.ts` as text — importing
   * it pulls in `@db/sqlite` transitively, which breaks under vitest
   * the same way the other tests in this file avoid.
   *
   * Two separate assertions per migration file:
   *  - `from "./<file>"` appears anywhere in `index.ts` (import line).
   *  - `m_<id>` appears inside the sliced `MIGRATIONS = [ ... ]` body
   *    (array entry). The slice is essential — a bare `m_<id>` in a
   *    doc comment elsewhere in the file would otherwise satisfy a
   *    whole-file scan and let a missing array entry through.
   *
   * Plus a size check that the array has exactly the same number of
   * entries as `m_*.ts` files on disk, so deleting a file but
   * forgetting to delete its array entry (or vice versa) trips here.
   */
  it("every m_*.ts file appears in the static manifest in index.ts", async () => {
    const files = await listMigrationFiles();
    const indexSource = await readFileContent("index.ts");
    const arrayBody = extractMigrationsArrayBody(indexSource);
    expect(
      arrayBody,
      "could not locate `const MIGRATIONS: readonly Migration[] = [...]` in index.ts",
    ).not.toBeNull();
    for (const file of files) {
      const id = file.match(FILENAME_RE)?.[1];
      expect(id, `${file}: failed to derive id from filename`).toBeTruthy();
      expect(
        indexSource,
        `${file}: missing \`import ... from "./${file}";\` in index.ts`,
      ).toContain(`from "./${file}"`);
      expect(
        arrayBody,
        `${file}: missing \`m_${id}\` entry inside the MIGRATIONS array literal of index.ts`,
      ).toMatch(new RegExp(`\\bm_${id}\\b`));
    }
  });

  it("MIGRATIONS array has exactly one entry per m_*.ts file on disk", async () => {
    const files = await listMigrationFiles();
    const indexSource = await readFileContent("index.ts");
    const arrayBody = extractMigrationsArrayBody(indexSource);
    if (arrayBody === null) {
      throw new Error("could not locate the MIGRATIONS array literal in index.ts");
    }
    const entries = arrayBody
      .split("\n")
      .map((line) => line.trim().replace(/,$/, ""))
      .filter((line) => /^m_\d{8}_\d{6}_[a-z][a-z0-9_]*$/.test(line));
    expect(
      entries.length,
      `MIGRATIONS has ${entries.length} entries; ${files.length} m_*.ts files on disk — fix index.ts`,
    ).toBe(files.length);
  });

  /**
   * Lock in the predicate independently of the real `index.ts` so a
   * future refactor of the assertion shape doesn't quietly weaken the
   * guard. The manual negative test the author ran (delete an entry,
   * see the test fail) is encoded here.
   */
  describe("extractMigrationsArrayBody", () => {
    const sample = [
      'import { migration as m_20260101_000000_a } from "./m_20260101_000000_a.ts";',
      'import { migration as m_20260101_000001_b } from "./m_20260101_000001_b.ts";',
      "",
      "const MIGRATIONS: readonly Migration[] = [",
      "  m_20260101_000000_a,",
      "  m_20260101_000001_b,",
      "];",
    ].join("\n");

    it("returns just the slice between [ and ]", () => {
      const body = extractMigrationsArrayBody(sample);
      expect(body).not.toBeNull();
      expect(body).toContain("m_20260101_000000_a");
      expect(body).toContain("m_20260101_000001_b");
      expect(body).not.toContain("import");
    });

    it("fails to find an entry that's only in a comment outside the array", () => {
      const withCommentOnly = sample.replace(
        "  m_20260101_000001_b,\n",
        "  // m_20260101_000001_b removed temporarily\n",
      );
      const body = extractMigrationsArrayBody(withCommentOnly);
      expect(body).not.toBeNull();
      expect(body).not.toMatch(/\bm_20260101_000001_b\b/);
    });

    it("returns null when the array literal isn't present", () => {
      expect(extractMigrationsArrayBody("// no manifest here")).toBeNull();
    });
  });
});

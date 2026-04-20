/**
 * Canonical content hash for a skill directory.
 *
 * The bootstrap loader (`ensureSystemSkills`) uses the hash to decide
 * whether the stored `@atlas/*` skill is still in sync with what ships
 * in the repo. Hashing raw files would produce different digests for
 * identical content across platforms (CRLF vs LF, trailing whitespace,
 * directory walk order), so everything is normalised first:
 *
 *   - relative POSIX paths, sorted lexicographically;
 *   - LF line endings for text files;
 *   - trailing whitespace stripped from each line;
 *   - a per-file `sha256` combined into a per-directory `sha256` as
 *     `"<relpath>\0<fileSha>\n"` concatenation.
 *
 * `evals/` is deliberately excluded — eval case tweaks shouldn't
 * trigger a republish.
 *
 * @module
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, sep as PATH_SEP, relative } from "node:path";

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".py",
  ".sh",
  ".json",
  ".yaml",
  ".yml",
  ".js",
  ".ts",
  ".tsx",
  ".txt",
]);

/** Files/directories that should not contribute to the source hash. */
const EXCLUDE_DIR_NAMES = new Set(["evals", "node_modules", ".git"]);
const EXCLUDE_FILE_NAMES = new Set([".DS_Store"]);

/** Normalize a text file's contents: LF endings, trailing whitespace trimmed per line. */
function canonicalizeText(contents: string): string {
  const lf = contents.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  return lf
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");
}

function toPosix(p: string): string {
  return PATH_SEP === "/" ? p : p.replaceAll(PATH_SEP, "/");
}

function isTextExt(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return TEXT_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

async function walk(
  root: string,
  current: string,
  out: Array<{ relPath: string; fullPath: string }>,
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (EXCLUDE_DIR_NAMES.has(entry.name)) continue;
    if (EXCLUDE_FILE_NAMES.has(entry.name)) continue;
    const full = join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(root, full, out);
    } else {
      out.push({ relPath: toPosix(relative(root, full)), fullPath: full });
    }
  }
}

/**
 * Compute the canonical sha256 of a skill directory. Deterministic across
 * macOS / Linux / Windows-checkout-to-Unix line-ending variation.
 */
export async function computeSkillHash(dir: string): Promise<string> {
  const entries: Array<{ relPath: string; fullPath: string }> = [];
  await walk(dir, dir, entries);
  entries.sort((a, b) => a.relPath.localeCompare(b.relPath));

  const outer = createHash("sha256");
  for (const { relPath, fullPath } of entries) {
    const inner = createHash("sha256");
    if (isTextExt(relPath)) {
      const raw = await readFile(fullPath, "utf-8");
      inner.update(canonicalizeText(raw));
    } else {
      const buf = await readFile(fullPath);
      inner.update(buf);
    }
    outer.update(relPath);
    outer.update(Buffer.from([0]));
    outer.update(inner.digest("hex"));
    outer.update("\n");
  }
  return outer.digest("hex");
}

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export interface HashResult {
  /** sha256 of the canonical manifest. */
  hash: string;
  /** The canonical manifest text: `<path> sha256:<hex>\n` per file, sorted. */
  manifest: string;
  /** Sorted list of relative paths that participated in the hash. */
  files: string[];
}

/**
 * Entry names (a single path segment — file or directory) excluded from BOTH
 * the bundle archive (`exportBundle`'s file walk) and the lockfile integrity
 * hash. The two MUST agree: a path counted in the hash but missing from the
 * zip — or the reverse — fails `importBundle`'s per-primitive integrity check.
 * This is the single source of truth for "what never belongs in a bundle".
 *
 * Two reasons something lands here:
 *   - hash noise: editor/VCS scratch whose presence must not perturb the
 *     content hash (`.DS_Store`, `.git`, `.atlas-ignore`, `*.tmp`).
 *   - build artifacts: large, platform-specific caches that the import side
 *     regenerates anyway. A macOS agent `.venv` is ~250 MB of darwin
 *     `.so`/`.dylib` a Linux runtime can neither run nor needs (it reinstalls
 *     its own deps), and shipping it is what blows a workspace export past the
 *     import size cap.
 */
const EXCLUDED_NAMES = new Set([
  ".DS_Store",
  ".git",
  ".atlas-ignore",
  ".venv",
  "venv",
  "__pycache__",
  "node_modules",
]);

function hasBinaryContent(bytes: Buffer): boolean {
  const scanLen = Math.min(bytes.length, 1024);
  for (let i = 0; i < scanLen; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

function normalizeTextBytes(bytes: Buffer): Buffer {
  if (hasBinaryContent(bytes)) return bytes;
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x0d && bytes[i + 1] === 0x0a) continue;
    if (b !== undefined) out.push(b);
  }
  return Buffer.from(out);
}

export function isBundleExcludedEntry(name: string): boolean {
  if (EXCLUDED_NAMES.has(name)) return true;
  if (name.endsWith(".tmp")) return true;
  if (name.endsWith(".pyc")) return true;
  return false;
}

async function walk(root: string, current: string, acc: string[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (isBundleExcludedEntry(entry.name)) continue;
    const abs = join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(root, abs, acc);
    } else if (entry.isFile()) {
      acc.push(relative(root, abs).split(sep).join("/"));
    }
  }
}

export async function hashPrimitive(dir: string): Promise<HashResult> {
  const info = await stat(dir);
  if (!info.isDirectory()) {
    throw new Error(`hashPrimitive: not a directory: ${dir}`);
  }

  const files: string[] = [];
  await walk(dir, dir, files);
  files.sort();

  const lines: string[] = [];
  for (const rel of files) {
    const raw = await readFile(join(dir, ...rel.split("/")));
    const normalized = normalizeTextBytes(raw);
    const fileHash = createHash("sha256").update(normalized).digest("hex");
    lines.push(`${rel} sha256:${fileHash}`);
  }

  const manifest = lines.join("\n") + (lines.length > 0 ? "\n" : "");
  const hash = `sha256:${createHash("sha256").update(manifest).digest("hex")}`;

  return { hash, manifest, files };
}

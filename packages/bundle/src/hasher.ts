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

const DEFAULT_EXCLUDES = [".DS_Store", ".git", ".atlas-ignore"];

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

function isExcluded(name: string): boolean {
  if (DEFAULT_EXCLUDES.includes(name)) return true;
  if (name.endsWith(".tmp")) return true;
  return false;
}

async function walk(root: string, current: string, acc: string[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (isExcluded(entry.name)) continue;
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
  const hash = "sha256:" + createHash("sha256").update(manifest).digest("hex");

  return { hash, manifest, files };
}

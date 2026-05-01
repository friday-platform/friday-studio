import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Creates a tar.gz archive of the given directory.
 * Uses the system `tar` command (available on macOS and Linux).
 * Returns an ArrayBuffer to satisfy the Blob/File constructor's BlobPart constraint.
 */
export async function createArchive(dir: string): Promise<ArrayBuffer> {
  const tempDir = await mkdtemp(join(tmpdir(), "skill-archive-"));
  const archivePath = join(tempDir, "skill.tar.gz");

  try {
    await execFileAsync("tar", ["czf", archivePath, "-C", dir, "."]);
    const buf = await readFile(archivePath);
    // Copy into a plain ArrayBuffer to avoid Uint8Array<ArrayBufferLike> TS issues
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

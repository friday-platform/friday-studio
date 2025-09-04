import { ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";

export interface SnapshotOptions {
  // new URL(import.meta.url) to name and colocate the snapshot.
  testPath: URL;
  /** Output data from the agent. */
  data: unknown;
  /** Did the test pass? */
  pass: boolean;
}

/**
 * Save a snapshot of test output for later analysis
 */
export async function saveSnapshot(options: SnapshotOptions): Promise<string> {
  const { testPath, data, pass } = options;

  // Extract base name without extension
  const testBaseName = testPath.pathname
    .split("/")
    .at(-1)
    ?.replace(/\.eval\.ts$/, "");

  // Create snapshots directory alongside the test file
  const testDir = dirname(testPath);
  const snapshotDir = join(testDir, "snapshots");
  await ensureDir(snapshotDir);

  // Build filename with test name: domain-filtering-20250903-154128-PASS.json
  const filename = `${testBaseName}-${getTimestamp()}-${pass ? "PASS" : "FAIL"}.json`;
  const filepath = join(snapshotDir, filename);

  // Write the snapshot
  await Deno.writeTextFile(filepath, JSON.stringify(data, null, 2));

  return filepath;
}

function getTimestamp(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");

  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

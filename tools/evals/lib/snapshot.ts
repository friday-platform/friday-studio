import { ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";
import { slugify } from "@std/text/unstable-slugify";

export interface SnapshotOptions {
  // new URL(import.meta.url) to name and colocate the snapshot.
  testPath: URL;
  // For multi-step evals - creates snapshots under testBaseName/testCase-timestamp-status.json
  testCase?: string;
  /** Output data from the agent. */
  data: unknown;
  /** Did the test pass? */
  pass: boolean;
}

/**
 * Save a snapshot of test output for later analysis.
 * 
 * Single-step tests: creates snapshots/testBaseName-timestamp-status.json
 * Multi-step tests: creates snapshots/testBaseName/testCase-timestamp-status.json
 */
export async function saveSnapshot(options: SnapshotOptions): Promise<string> {
  const { testPath, data, pass, testCase } = options;

  // Extract base name without extension
  const testBaseName = testPath.pathname
    .split("/")
    .at(-1)
    ?.replace(/\.(?:eval\.)?ts$/, "");
  if (!testBaseName) {
    throw new Error("Invalid test path", { cause: { path: testBaseName } });
  }

  // Create snapshots directory alongside the test file
  const testDir = dirname(testPath);
  const snapshotDir = join(testDir, "snapshots");
  await ensureDir(snapshotDir);

  let filepath: string;
  if (testCase) {
    // Multi-step test: organize snapshots under testBaseName subdirectory
    const testCaseDir = join(snapshotDir, testBaseName);
    await ensureDir(testCaseDir);
    const filename = `${slugify(testCase)}-${getTimestamp()}-${pass ? "PASS" : "FAIL"}.json`;
    filepath = join(testCaseDir, filename);
  } else {
    // Single-step test: flat structure in snapshots directory
    const filename = `${testBaseName}-${getTimestamp()}-${pass ? "PASS" : "FAIL"}.json`;
    filepath = join(snapshotDir, filename);
  }

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

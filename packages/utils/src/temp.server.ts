import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface MakeTempDirOptions {
  prefix?: string;
}

/**
 * Creates a temporary directory. Node equivalent of Deno.makeTempDir.
 * @param options.prefix - Prefix for the temp directory name (default: "tmp-")
 * @returns Absolute path to created temp directory
 */
export function makeTempDir(options: MakeTempDirOptions = {}): string {
  const prefix = options.prefix ?? "tmp-";
  return mkdtempSync(join(tmpdir(), prefix));
}

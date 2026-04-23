/**
 * Resolves local filesystem paths used as MCP transport commands.
 *
 * Matches commands that are absolute paths (`/usr/local/bin/my-mcp`) or
 * relative paths (`./bin/server`, `../sibling/cli`). Ignores bare command
 * names (`python`, `node`, `bash`) — those are system binaries we trust
 * to be on PATH and out of the validator's scope.
 *
 * `fs.stat` differentiates:
 *   - file exists, is executable → ok
 *   - file exists, not executable → treat as not_found with a note
 *   - file doesn't exist → not_found
 *   - other errors (EACCES, ENOTDIR) → unreachable
 *
 * Path existence is checked relative to the daemon's process cwd, which
 * is where the daemon already resolves MCP working directories.
 */

import { stat } from "node:fs/promises";
import type { PackageResolver } from "../config-validator.ts";

export function createLocalPathResolver(): PackageResolver {
  const cache = new Map<string, Awaited<ReturnType<PackageResolver["check"]>>>();

  return {
    matches(command) {
      if (typeof command !== "string") return null;
      if (command.startsWith("/") || command.startsWith("./") || command.startsWith("../")) {
        return { ref: command };
      }
      return null;
    },

    async check(ref) {
      const cached = cache.get(ref);
      if (cached) return cached;
      const result = await doCheck(ref);
      cache.set(ref, result);
      return result;
    },
  };
}

async function doCheck(ref: string): Promise<Awaited<ReturnType<PackageResolver["check"]>>> {
  try {
    const s = await stat(ref);
    if (!s.isFile()) return { ok: false, reason: "not_found" };
    return { ok: true };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") return { ok: false, reason: "not_found" };
    return { ok: false, reason: "unreachable" };
  }
}

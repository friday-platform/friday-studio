/**
 * Workspace `.env` overlay.
 *
 * A workspace's `.env` file is the per-workspace store of *non-secret* env
 * values — agent env, per-server MCP plain-string settings, workspace-wide
 * env. It is loaded as an overlay at spawn time and layered between the
 * daemon's ambient `process.env` and any explicit per-agent/per-server `env:`
 * wiring (most specific wins).
 *
 * Lazy-on-write: an absent file is a valid empty overlay — no workspace
 * pre-creates one. The file appears when something first writes a value.
 *
 * Writes are line-based and comment-preserving: `setEnvFileVar` /
 * `deleteEnvFileVar` touch only the one matching `KEY=` line and leave
 * comments and every other line untouched. (The daemon's bulk `PUT /env`
 * route re-stringifies the whole file and drops comments — the agent-facing
 * env tools must not inherit that footgun.)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@atlas/logger";
import { parse as parseDotenv } from "@std/dotenv";

/**
 * Load a `.env` file into a record. Returns an empty record when the file is
 * absent (valid empty overlay) or unparseable (logged at debug — a malformed
 * `.env` should not crash a spawn). Read fresh on every call: the file is
 * small and editable at runtime, so a cached copy would mask edits.
 */
export function loadEnvFile(envFilePath: string): Record<string, string> {
  if (!existsSync(envFilePath)) return {};
  try {
    return parseDotenv(readFileSync(envFilePath, "utf-8"));
  } catch (error) {
    logger.debug("Could not parse .env file", { envFilePath, error });
    return {};
  }
}

/** Load a workspace's `.env` overlay from `<workspacePath>/.env`. */
export function loadWorkspaceEnv(workspacePath: string): Record<string, string> {
  return loadEnvFile(join(workspacePath, ".env"));
}

/**
 * Format a single `KEY=value` assignment line.
 *
 * Quoting mirrors the daemon's `stringifyEnv` (apps/atlasd/routes/config.ts)
 * so the file round-trips through `@std/dotenv`'s `parse` and the Go
 * launcher's `loadDotEnv` reads values without literal quotes:
 *   - whitespace / `#` / `$` / a quote / backslash / leading quote
 *                  → single-quote (literal, no expansion)
 *   - value containing `'`
 *                  → double-quote with `\` and `"` escaped
 *   - otherwise    → unquoted
 */
function formatEnvAssignment(key: string, value: string): string {
  const v = value ?? "";
  const needsQuoting = /[\s#$"'\\]/.test(v) || /^['"]/.test(v);
  if (!needsQuoting) return `${key}=${v}`;
  if (!v.includes("'")) return `${key}='${v}'`;
  const escaped = v.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `${key}="${escaped}"`;
}

/**
 * True if `line` is an assignment for `key` — `KEY=...` or `export KEY=...`,
 * tolerating leading whitespace. `key` is always a POSIX identifier
 * (`[A-Za-z_][A-Za-z0-9_]*`), so a plain `startsWith` is safe.
 */
function isAssignmentLine(line: string, key: string): boolean {
  const trimmed = line.trimStart();
  const body = trimmed.startsWith("export ")
    ? trimmed.slice("export ".length).trimStart()
    : trimmed;
  return body.startsWith(`${key}=`);
}

/**
 * Set `key` to `value` in the `.env` file at `envFilePath`, preserving
 * comments and every other line. Replaces the existing assignment in place
 * (and drops any duplicate assignments for the same key); appends when the
 * key is absent. Creates the file lazily on first write.
 */
export function setEnvFileVar(envFilePath: string, key: string, value: string): void {
  const assignment = formatEnvAssignment(key, value);
  const lines = existsSync(envFilePath) ? readFileSync(envFilePath, "utf-8").split("\n") : [];

  const out: string[] = [];
  let replaced = false;
  for (const line of lines) {
    if (isAssignmentLine(line, key)) {
      if (!replaced) {
        out.push(assignment);
        replaced = true;
      }
      // Drop duplicate assignments for the same key — dotenv is last-wins,
      // so leaving stale earlier lines would be confusing on next read.
    } else {
      out.push(line);
    }
  }

  if (!replaced) {
    // Append. Reuse a trailing blank-line slot (from a file ending in `\n`)
    // rather than introducing a gap.
    if (out.length > 0 && out[out.length - 1] === "") {
      out[out.length - 1] = assignment;
    } else {
      out.push(assignment);
    }
  }

  let content = out.join("\n");
  if (!content.endsWith("\n")) content += "\n";
  writeFileSync(envFilePath, content, "utf-8");
}

/**
 * Remove `key` from the `.env` file at `envFilePath`, preserving comments and
 * every other line. Returns `true` when an assignment was removed, `false`
 * when the key (or the file) was absent.
 */
export function deleteEnvFileVar(envFilePath: string, key: string): boolean {
  if (!existsSync(envFilePath)) return false;
  const lines = readFileSync(envFilePath, "utf-8").split("\n");
  const out = lines.filter((line) => !isAssignmentLine(line, key));
  if (out.length === lines.length) return false;

  let content = out.join("\n");
  if (content.length > 0 && !content.endsWith("\n")) content += "\n";
  writeFileSync(envFilePath, content, "utf-8");
  return true;
}

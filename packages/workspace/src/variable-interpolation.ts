/**
 * Workspace variable interpolation.
 *
 * Resolves `{{double_brace}}` placeholders in parsed workspace config objects
 * at config-load time. The daemon knows the workspace path, can derive the
 * repo root, and knows its own URL — so these values are injected before any
 * FSM engine or agent prompt sees the config.
 *
 * Uses `{{double_brace}}` syntax to distinguish from the `{singleBrace}`
 * convention used in agent prompt text as documentation placeholders that
 * agents resolve themselves at runtime. Only `{{...}}` is machine-resolved.
 */

import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { type VariableDeclaration, VariableSchemaSchema } from "@atlas/config";
import { logger } from "@atlas/logger";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { z } from "zod";

/**
 * Well-known workspace variables resolved by the daemon at config-load time.
 *
 * `platform_url` defaults to whatever `getAtlasDaemonUrl()` resolves to —
 * which honors `FRIDAYD_URL` and auto-upgrades to `https://` when
 * `FRIDAY_TLS_CERT` is set. Without this, agents interpolating
 * `{{platform_url}}` into an HTTP fetch hit cleartext on a TLS-bound daemon
 * and fail with "Response does not match HTTP/1.1 protocol".
 */
export const WorkspaceVariablesSchema = z.object({
  repo_root: z.string(),
  workspace_path: z.string(),
  workspace_id: z.string(),
  platform_url: z.string().default(() => getAtlasDaemonUrl()),
});

export type WorkspaceVariables = z.infer<typeof WorkspaceVariablesSchema>;

/**
 * Pattern matching `{{key}}` or `{{namespace.key}}` — captures the full token.
 *
 * Flat keys (`{{repo_root}}`) resolve from `WorkspaceVariables`. Dotted keys
 * under the `variables.` namespace (`{{variables.email_recipient}}`) resolve
 * from declared workspace variables.
 */
const PLACEHOLDER_RE = /\{\{([a-z_]+(?:\.[a-z_]+)?)\}\}/g;

/** Convert a declared variable name to its auto-derived `.env` key. */
export function variableEnvKey(name: string): string {
  return name.toUpperCase();
}

/**
 * Build the resolved `variables.*` namespace from declarations + workspace `.env`.
 *
 * For each declared variable:
 * - Read the env value at `UPPER_SNAKE_CASE(name)`.
 * - If present and it validates against the declared schema, use it (coerced
 *   to string via `String`).
 * - Otherwise fall back to `schema.default` when present and itself valid.
 * - Otherwise leave the variable unresolved (omitted from the returned map);
 *   the interpolator leaves `{{variables.<name>}}` literal in that case.
 *
 * Coercion is one-way (env strings → typed values for validation; resolved
 * values → strings for substitution). The answer handler is what writes
 * typed user input back into `.env` as a string.
 */
export function resolveDeclaredVariables(
  declarations: Record<string, VariableDeclaration> | undefined,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!declarations) return out;
  for (const [name, decl] of Object.entries(declarations)) {
    const resolved = resolveOne(decl, env[variableEnvKey(name)]);
    if (resolved !== undefined) out[name] = resolved;
  }
  return out;
}

function resolveOne(decl: VariableDeclaration, raw: string | undefined): string | undefined {
  const zodSchema = z.fromJSONSchema(VariableSchemaSchema.parse(decl.schema));
  const tried = tryCoerceAndValidate(decl.schema.type, raw, zodSchema);
  if (tried.ok) return String(tried.value);
  const fallback = decl.schema.default;
  if (fallback === undefined) return undefined;
  const fallbackOk = zodSchema.safeParse(fallback);
  if (!fallbackOk.success) return undefined;
  return String(fallbackOk.data);
}

type CoerceResult = { ok: true; value: unknown } | { ok: false };

function tryCoerceAndValidate(
  type: VariableDeclaration["schema"]["type"],
  raw: string | undefined,
  zodSchema: z.ZodType,
): CoerceResult {
  if (raw === undefined) return { ok: false };
  const coerced = coerceFromString(type, raw);
  if (coerced === undefined) return { ok: false };
  const parsed = zodSchema.safeParse(coerced);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

function coerceFromString(
  type: VariableDeclaration["schema"]["type"],
  raw: string,
): unknown | undefined {
  switch (type) {
    case "string":
      return raw;
    case "boolean": {
      if (raw === "true") return true;
      if (raw === "false") return false;
      return undefined;
    }
    case "integer": {
      if (!/^-?\d+$/.test(raw)) return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    case "number": {
      if (raw.trim() === "") return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
  }
}

/**
 * Recursively walk a parsed config object and replace `{{key}}` and
 * `{{variables.<name>}}` placeholders in every string value.
 *
 * - Flat `{{key}}` resolves from `WorkspaceVariables` (daemon-known values).
 * - `{{variables.<name>}}` resolves from the pre-built `declaredVariables`
 *   namespace (see `resolveDeclaredVariables`). Undeclared or unresolved
 *   variables stay literal — the strict namespace prevents silent env leaks.
 * - Non-string values (numbers, booleans, null) are returned as-is.
 * - The function is pure modulo logging — it returns a new object tree.
 */
export function interpolateConfig<T>(
  value: T,
  variables: WorkspaceVariables,
  declaredVariables: Record<string, string> = {},
): T {
  if (typeof value === "string") {
    return interpolateString(value, variables, declaredVariables) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateConfig(item, variables, declaredVariables)) as T;
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = interpolateConfig(v, variables, declaredVariables);
    }
    return result as T;
  }
  return value;
}

function interpolateString(
  str: string,
  variables: WorkspaceVariables,
  declaredVariables: Record<string, string>,
): string {
  const knownFlatKeys = new Set(Object.keys(variables));
  return str.replace(PLACEHOLDER_RE, (match, token: string) => {
    const dotIndex = token.indexOf(".");
    if (dotIndex === -1) {
      if (knownFlatKeys.has(token)) {
        return variables[token as keyof WorkspaceVariables];
      }
      logger.warn("Unknown workspace variable placeholder, leaving as-is", {
        placeholder: match,
        key: token,
      });
      return match;
    }
    const namespace = token.slice(0, dotIndex);
    const name = token.slice(dotIndex + 1);
    if (namespace !== "variables") return match;
    const resolved = declaredVariables[name];
    return resolved ?? match;
  });
}

/**
 * Walk up the filesystem from `startPath` until we find a `.git` entry
 * (directory or worktree file), then return that ancestor as the repo root.
 *
 * Returns `null` if no `.git` ancestor is found.
 *
 * Extracted from `workspaces/system/jobs/decompose-plan/job.ts` for reuse.
 */
// Sync stat check wrapped in async API for caller ergonomics
// deno-lint-ignore require-await
export async function findRepoRoot(startPath: string): Promise<string | null> {
  let dir = dirname(startPath);
  while (true) {
    const gitEntry = join(dir, ".git");
    try {
      statSync(gitEntry);
      return dir;
    } catch {
      // Not found at this level — walk up.
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Build the `WorkspaceVariables` record from daemon-known values.
 *
 * @param workspacePath Absolute path to the workspace directory on disk.
 * @param workspaceId   The workspace's stable identifier.
 * @param daemonUrl     The daemon's base URL (defaults to `getAtlasDaemonUrl()` —
 *                      scheme/port follow the daemon's actual binding).
 * @returns Parsed `WorkspaceVariables` or `null` if repo_root cannot be derived.
 */
export async function resolveWorkspaceVariables(
  workspacePath: string,
  workspaceId: string,
  daemonUrl?: string,
): Promise<WorkspaceVariables | null> {
  const repoRoot = await findRepoRoot(workspacePath);
  if (!repoRoot) {
    logger.warn("Could not derive repo_root for workspace variable interpolation", {
      workspacePath,
    });
    return null;
  }

  // platform_url is intentionally left undefined when daemonUrl is absent so
  // the schema's `.default(() => getAtlasDaemonUrl())` fires. Without this,
  // the call-site `??` made the schema default dead code and the test that
  // claimed to exercise it was tautological (see review v2 Important #1).
  return WorkspaceVariablesSchema.parse({
    repo_root: repoRoot,
    workspace_path: workspacePath,
    workspace_id: workspaceId,
    platform_url: daemonUrl,
  });
}

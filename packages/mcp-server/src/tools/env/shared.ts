/**
 * Shared bits for the `env_*` platform tools.
 *
 * The tools are thin wrappers over the per-key daemon env routes:
 *   - `workspace` scope → `/api/workspaces/:id/env[/:key]`
 *   - `global`    scope → `/api/config/env[/:key]` (the daemon's `<friday-home>/.env`)
 *
 * Reads mask secret-looking keys before the value reaches an LLM — the
 * workspace `.env` is the *non-secret* value store by design, but the
 * daemon-global `.env` legitimately holds API keys, and a user can always
 * put a secret in the wrong place. Masking is a key-name heuristic, not a
 * value inspection.
 */

import { z } from "zod";

// Secret-masking heuristic lives in `@atlas/core` so the chat-side env tools
// (`@atlas/system`) share one source of truth — a divergent copy would mask a
// key on one surface and leak it on the other.
export {
  isSecretKey,
  MASKED_VALUE,
  maskEnvMap,
  maskForKey,
} from "@atlas/core/mcp-registry/env-secret-mask";

/** `workspace` (per-workspace `.env`) or `global` (the daemon's `.env`). */
export const EnvScopeSchema = z.enum(["workspace", "global"]);
export type EnvScope = z.infer<typeof EnvScopeSchema>;

/**
 * Resolve the daemon route base for a scope. `workspace` scope requires a
 * `workspaceId`; `global` ignores it.
 */
export function envRouteBase(
  daemonUrl: string,
  scope: EnvScope,
  workspaceId: string | undefined,
): { ok: true; base: string } | { ok: false; error: string } {
  if (scope === "global") {
    return { ok: true, base: `${daemonUrl}/api/config/env` };
  }
  if (!workspaceId) {
    return { ok: false, error: "workspaceId is required when scope is 'workspace'" };
  }
  return { ok: true, base: `${daemonUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/env` };
}

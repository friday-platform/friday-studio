/**
 * Per-request memoization for `resolveWorkspaceSetupRequirements`.
 *
 * The signal gate, sidebar badge, workspace summary endpoint, and
 * system-prompt builder may all call into the derivation during one Hono
 * request. Without memoization they'd each pay the cost of reading `.env`
 * and hitting Link. The cache lives on the Hono context (`c`) and dies with
 * the request — no cross-request leaks.
 */

import {
  type LinkCredentialState,
  type ResolveSetupRequirementsOptions,
  resolveWorkspaceSetupRequirements,
  type SetupRequirementsResult,
} from "@atlas/workspace";
import type { Context } from "hono";
import type { AppVariables } from "./factory.ts";

interface CtxLike {
  get: <K extends keyof AppVariables["Variables"]>(key: K) => AppVariables["Variables"][K];
  set: <K extends keyof AppVariables["Variables"]>(
    key: K,
    value: AppVariables["Variables"][K],
  ) => void;
}

type ParsedConfig = Parameters<typeof resolveWorkspaceSetupRequirements>[0];

/**
 * Returns the memoized setup-requirements result for `workspaceId` within
 * this request, computing it via `compute` on first call. `compute` is
 * responsible for assembling the Link snapshot, env overlay, etc. — it runs
 * at most once per (workspace, request) pair.
 *
 * The `parsedConfig` from `compute()` is also stashed on the Hono context
 * so callers like the recover-bootstrap loop can grab it without re-loading
 * the workspace config — preserving the "N workspaces → N config loads"
 * invariant.
 */
export async function getOrComputeSetupRequirements(
  c: Context<AppVariables> | CtxLike,
  workspaceId: string,
  compute: () => Promise<{
    parsedConfig: ParsedConfig;
    envSnapshot: Record<string, string>;
    linkCredentials: LinkCredentialState;
    options: ResolveSetupRequirementsOptions;
  }>,
): Promise<SetupRequirementsResult> {
  let cache = c.get("setupRequirementsCache");
  if (!cache) {
    cache = new Map<string, SetupRequirementsResult>();
    c.set("setupRequirementsCache", cache);
  }
  const cached = cache.get(workspaceId);
  if (cached) return cached;
  const inputs = await compute();
  const result = resolveWorkspaceSetupRequirements(
    inputs.parsedConfig,
    inputs.envSnapshot,
    inputs.linkCredentials,
    inputs.options,
  );
  cache.set(workspaceId, result);
  rememberParsedConfig(c, workspaceId, inputs.parsedConfig);
  return result;
}

/** Per-request cache of parsed configs, populated by `getOrComputeSetupRequirements`. */
export function getCachedParsedConfig(
  c: Context<AppVariables> | CtxLike,
  workspaceId: string,
): ParsedConfig | undefined {
  return c.get("parsedConfigCache")?.get(workspaceId);
}

function rememberParsedConfig(
  c: Context<AppVariables> | CtxLike,
  workspaceId: string,
  parsedConfig: ParsedConfig,
): void {
  let cache = c.get("parsedConfigCache");
  if (!cache) {
    cache = new Map<string, ParsedConfig>();
    c.set("parsedConfigCache", cache);
  }
  cache.set(workspaceId, parsedConfig);
}

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

/**
 * Returns the memoized setup-requirements result for `workspaceId` within
 * this request, computing it via `compute` on first call. `compute` is
 * responsible for assembling the Link snapshot, env overlay, etc. — it runs
 * at most once per (workspace, request) pair.
 */
export async function getOrComputeSetupRequirements(
  c: Context<AppVariables> | CtxLike,
  workspaceId: string,
  compute: () => Promise<{
    parsedConfig: Parameters<typeof resolveWorkspaceSetupRequirements>[0];
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
  return result;
}

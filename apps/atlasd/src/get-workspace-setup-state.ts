/**
 * Single-source-of-truth wrapper around the
 * `loadWorkspaceEnv + assembleLinkCredentialState + resolveWorkspaceSetupRequirements`
 * trio.
 *
 * `resolveWorkspaceSetupRequirements` is a pure function — `@atlas/workspace`
 * deliberately keeps Link, env IO, and storage concerns out of the package, so
 * every caller in the daemon has to assemble the inputs itself. Before this
 * helper there were five hand-rolled assemblers (request-scoped GET wrapper,
 * cascade/communicator gate, manager-injected setup probe, import-time bootstrap
 * spawn, and the per-request memoization compute callback). A future change to
 * Link error policy or the env loader had to be threaded through all of them.
 *
 * Two entry points are exported:
 *
 *  - {@link buildSetupRequirementInputs} — the assembly primitive. Callers that
 *    already hold `(workspacePath, parsedConfig)` (the probe, the spawn helper,
 *    the request-scoped cache's compute callback) call this directly. It does
 *    not run the derivation.
 *  - {@link getWorkspaceSetupState} — the end-to-end entry. Callers that only
 *    hold a `workspaceId` (the cascade-worker gate) call this. It loads the
 *    workspace + config via the manager, composes the inputs, and runs the
 *    derivation. Returns `null` when the workspace or its config is missing
 *    so the caller can short-circuit (nothing to gate / nothing to derive).
 */

import type { WorkspaceConfig } from "@atlas/config";
import {
  type LinkCredentialState,
  loadWorkspaceEnv,
  type ResolveSetupRequirementsOptions,
  resolveWorkspaceSetupRequirements,
  type SetupRequirementsResult,
  type WorkspaceManager,
} from "@atlas/workspace";
import { assembleLinkCredentialState } from "./assemble-link-credential-state.ts";

export interface SetupRequirementInputs {
  envSnapshot: Record<string, string>;
  linkCredentials: LinkCredentialState;
}

/**
 * Assemble the env overlay + Link credential snapshot that
 * `resolveWorkspaceSetupRequirements` consumes. The pure derivation is left to
 * the caller so this helper can be used both directly (probe / spawn / cache
 * compute) and as the inner step of {@link getWorkspaceSetupState}.
 */
export async function buildSetupRequirementInputs(
  workspacePath: string,
  parsedConfig: WorkspaceConfig,
): Promise<SetupRequirementInputs> {
  const envSnapshot = loadWorkspaceEnv(workspacePath);
  const linkCredentials = await assembleLinkCredentialState(parsedConfig);
  return { envSnapshot, linkCredentials };
}

/**
 * Load the workspace + parsed config via the manager, assemble the inputs,
 * and run the setup-requirements derivation. Returns `null` when either the
 * workspace entry or its config cannot be loaded (cross-home masked, deleted,
 * missing system workspace config).
 *
 * The caller picks `options.allowStaleIdRecovery`:
 *  - `true` (post-import / read paths) — a pinned id that no longer resolves
 *    becomes a recoverable `stale_id` requirement.
 *  - `false` (import-time spawn path) — the same condition throws
 *    `StaleCredentialIdAtImportError`.
 */
export async function getWorkspaceSetupState(
  workspaceId: string,
  manager: WorkspaceManager,
  options: ResolveSetupRequirementsOptions,
): Promise<SetupRequirementsResult | null> {
  const entry = await manager.find({ id: workspaceId });
  if (!entry) return null;
  const merged = await manager.getWorkspaceConfig(workspaceId);
  if (!merged) return null;
  const { envSnapshot, linkCredentials } = await buildSetupRequirementInputs(
    entry.path,
    merged.workspace,
  );
  return resolveWorkspaceSetupRequirements(merged.workspace, envSnapshot, linkCredentials, options);
}

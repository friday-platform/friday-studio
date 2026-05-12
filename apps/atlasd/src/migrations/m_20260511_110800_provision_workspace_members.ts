/**
 * Migration: backfill the WORKSPACE_MEMBERS bucket from existing
 * workspace registry rows.
 *
 * Steady-state writes happen in WorkspaceManager via the injected
 * MembershipWriter (one `owner` row per workspace at registration
 * time). Workspaces created before that wiring landed have no
 * membership rows; this migration stamps one `owner` row for each.
 *
 * Owner resolution: `metadata.createdBy` if set, else the resolved
 * local user id (single-tenant local-mode fallback — cloud always
 * stamps createdBy at workspace creation time, so the fallback never
 * fires there).
 *
 * Idempotent: uses `putIfAbsent`, so re-runs leave existing rows
 * untouched.
 */

import { createJetStreamUserBackend } from "@atlas/core/users/storage";
import { createJetStreamWorkspaceMemberBackend } from "@atlas/core/workspace-members/storage";
import { createRegistryStorageJS } from "@atlas/workspace";
import type { Migration } from "jetstream";

export const migration: Migration = {
  id: "20260511_110800_provision_workspace_members",
  name: "WORKSPACE_MEMBERS — backfill owner rows from registry",
  description:
    "Iterate WORKSPACE_REGISTRY and stamp an `owner` membership row for each " +
    "workspace, derived from metadata.createdBy with a local-user-id fallback " +
    "when createdBy is unset (single-tenant local mode).",
  async run({ nc, logger }) {
    // Self-contained backends from `nc` — the `UserStorage` /
    // `WorkspaceMemberStorage` facades require daemon-side init that
    // the standalone CLI `atlas migrate` path doesn't perform.
    const users = createJetStreamUserBackend(nc);
    const members = createJetStreamWorkspaceMemberBackend(nc);

    const localUserResult = await users.resolveLocalUserId();
    if (!localUserResult.ok) {
      throw new Error(`Failed to resolve local user id: ${localUserResult.error}`);
    }
    const localUserId = localUserResult.data;

    const registry = await createRegistryStorageJS(nc);
    const workspaces = await registry.listWorkspaces();

    let stamped = 0;
    let alreadyPresent = 0;
    let failed = 0;
    const now = new Date().toISOString();

    for (const ws of workspaces) {
      const ownerUserId = ws.metadata?.createdBy ?? localUserId;
      const result = await members.putIfAbsent({
        userId: ownerUserId,
        wsId: ws.id,
        role: "owner",
        addedAt: now,
      });
      if (!result.ok) {
        failed++;
        logger.warn("Failed to stamp owner membership", {
          wsId: ws.id,
          ownerUserId,
          error: result.error,
        });
        continue;
      }
      if (result.data === "exists") {
        alreadyPresent++;
      } else {
        stamped++;
      }
    }

    if (failed > 0) {
      throw new Error(
        `Membership backfill incomplete — failed ${failed}/${workspaces.length} workspaces`,
      );
    }

    logger.info("Workspace member backfill complete", {
      total: workspaces.length,
      stamped,
      alreadyPresent,
      localUserId,
    });
  },
};

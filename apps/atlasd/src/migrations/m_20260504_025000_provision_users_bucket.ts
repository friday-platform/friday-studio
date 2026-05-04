/**
 * Migration: backfill the USERS bucket from legacy memory-based identity.
 *
 * Pre-USERS, the workspace-chat onboarding script asked the model to
 * call `memory_save` with `metadata.type === "user-name"` /
 * `"name-declined"` against the personal-workspace `notes` narrative.
 * Identity reads then derived state by scanning those entries.
 *
 * Phase 0.5 moves identity to the USERS KV bucket. This migration
 * ports any pre-existing identity entry forward into the local user's
 * USERS record so existing users don't get re-asked their name.
 *
 * Idempotent: skip if the local user's `nameStatus` is already
 * non-"unknown" (someone already provided / declined since the last
 * run, or this migration already ran).
 */

import { JetStreamNarrativeStore } from "@atlas/adapters-md";
import { ONBOARDING_VERSION, UserStorage } from "@atlas/core/users/storage";
import type { Migration } from "jetstream";

const NAME_EXTRACT = /(?:name is|call me)\s+(.+)/i;

export const migration: Migration = {
  id: "20260504_025000_provision_users_bucket",
  name: "USERS bucket — backfill identity from legacy memory",
  description:
    "Read the personal workspace's `notes` narrative for type:user-name / " +
    "type:name-declined entries authored by the legacy onboarding flow, and " +
    "populate the local user's USERS record so onboarding doesn't re-ask.",
  async run({ nc, logger }) {
    const localUserResult = await UserStorage.resolveLocalUserId();
    if (!localUserResult.ok) {
      throw new Error(`Failed to resolve local user id: ${localUserResult.error}`);
    }
    const localUserId = localUserResult.data;

    const userResult = await UserStorage.getUser(localUserId);
    if (!userResult.ok) {
      throw new Error(`Failed to read local user: ${userResult.error}`);
    }
    if (userResult.data?.identity.nameStatus !== "unknown") {
      logger.debug("Local user already has identity — skipping backfill", {
        nameStatus: userResult.data?.identity.nameStatus,
      });
      return;
    }

    let entries: Awaited<ReturnType<JetStreamNarrativeStore["read"]>>;
    try {
      const store = new JetStreamNarrativeStore({ nc, workspaceId: "user", name: "notes" });
      entries = await store.read({ limit: 200 });
    } catch (err) {
      logger.warn("Legacy memory read failed — leaving USERS empty", { error: String(err) });
      return;
    }

    // Newest-first: first match wins.
    let resolved: { kind: "provided"; name: string } | { kind: "declined" } | null = null;
    for (const entry of entries) {
      const type = (entry.metadata as { type?: unknown } | undefined)?.type;
      if (type === "user-name" && !resolved) {
        const match = NAME_EXTRACT.exec(entry.text);
        const name = (match?.[1] ?? entry.text).trim();
        if (name) resolved = { kind: "provided", name };
      } else if (type === "name-declined" && !resolved) {
        resolved = { kind: "declined" };
      }
      if (resolved) break;
    }

    if (!resolved) {
      logger.debug("No legacy identity entries found — nothing to backfill");
      return;
    }

    if (resolved.kind === "provided") {
      const set = await UserStorage.setUserIdentity(localUserId, {
        name: resolved.name,
        nameStatus: "provided",
      });
      if (!set.ok) throw new Error(`setUserIdentity failed: ${set.error}`);
      logger.info("Backfilled identity (name provided)", { name: resolved.name });
    } else {
      const set = await UserStorage.setUserIdentity(localUserId, {
        nameStatus: "declined",
        declinedAt: new Date().toISOString(),
      });
      if (!set.ok) throw new Error(`setUserIdentity failed: ${set.error}`);
      logger.info("Backfilled identity (name declined)");
    }

    const mark = await UserStorage.markOnboardingComplete(localUserId, ONBOARDING_VERSION);
    if (!mark.ok) throw new Error(`markOnboardingComplete failed: ${mark.error}`);
  },
};

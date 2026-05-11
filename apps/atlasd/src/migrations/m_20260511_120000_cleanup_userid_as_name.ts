/**
 * Migration: undo USERS records poisoned by the userId-as-name placeholder.
 *
 * Earlier, `/api/me` (local adapter) returned `full_name: <userId>` and
 * `email: <userId>@local.friday` when the User record had no name yet —
 * the response-schema field types were non-nullable strings, so the
 * adapter substituted a deterministic placeholder.
 *
 * The workspace-chat prompt builder then auto-synced `/api/me` into
 * USERS for users with `nameStatus: "unknown"`, writing the placeholder
 * back as `identity.name = <userId>` / `identity.email = <userId>@local.friday`
 * with `nameStatus: "provided"` and `onboarding.completedAt` stamped.
 * Once that landed, the `<user_profile>` system-prompt block surfaced
 * the userId nanoid as the user's real name on every subsequent turn,
 * and the welcome wizard's onboarding gate (`completed=true`) never
 * re-fired.
 *
 * The adapter has been fixed to surface `null` for unset fields, so the
 * auto-sync no longer triggers. This migration reverses the persisted
 * damage on existing installs.
 *
 * Detection criteria (all required to consider a record poisoned):
 *   - `identity.nameStatus === "provided"`
 *   - `identity.name === userId` (the literal nanoid)
 *   - `identity.email === "<userId>@local.friday"` (the literal
 *     placeholder; absence of email alone isn't sufficient — a
 *     legitimately-onboarded user without an email shouldn't be reset)
 *
 * For each poisoned record, reset to pre-onboarding state:
 *   - clear `identity.name`, `identity.email`
 *   - set `identity.nameStatus = "unknown"`
 *   - clear `onboarding.completedAt`, reset `onboarding.version = 0`
 *
 * Other identity fields (`timezone`, `locale`, `declinedAt`,
 * `preferences`, `createdAt`) are preserved. Skip the `_local` pointer
 * key (special-cased, not a User record).
 *
 * Idempotent: poisoned records get reset to nameStatus="unknown", so
 * a rerun finds nothing matching the detection criteria.
 */

import { ensureUsersKVBucket, UserSchema } from "@atlas/core/users/storage";
import type { Migration } from "jetstream";

const enc = new TextEncoder();
const dec = new TextDecoder();

const LOCAL_USER_KEY = "_local";

export const migration: Migration = {
  id: "20260511_120000_cleanup_userid_as_name",
  name: "USERS bucket — reset records that captured userId as their own name",
  description:
    "Reverse the auto-sync damage from the userId-as-name placeholder bug. " +
    "Resets identity + onboarding state for any record whose `name` equals " +
    "its `userId` and whose `email` matches `<userId>@local.friday`.",
  async run({ nc, logger }) {
    const kv = await ensureUsersKVBucket(nc);

    let scanned = 0;
    let reset = 0;
    const keysIter = await kv.keys();
    for await (const key of keysIter) {
      if (key === LOCAL_USER_KEY) continue;
      scanned += 1;

      const entry = await kv.get(key);
      if (!entry || entry.operation !== "PUT") continue;

      let user: ReturnType<typeof UserSchema.parse>;
      try {
        user = UserSchema.parse(JSON.parse(dec.decode(entry.value)));
      } catch (err) {
        logger.warn("Skipping unparseable USERS entry", { key, error: String(err) });
        continue;
      }

      const userId = user.userId;
      const placeholderEmail = `${userId}@local.friday`;
      const isPoisoned =
        user.identity.nameStatus === "provided" &&
        user.identity.name === userId &&
        user.identity.email === placeholderEmail;
      if (!isPoisoned) continue;

      const next: ReturnType<typeof UserSchema.parse> = {
        ...user,
        identity: {
          // Preserve fields the placeholder bug didn't touch.
          timezone: user.identity.timezone,
          locale: user.identity.locale,
          declinedAt: user.identity.declinedAt,
          nameStatus: "unknown",
        },
        onboarding: { version: 0 },
        updatedAt: new Date().toISOString(),
      };

      try {
        await kv.update(key, enc.encode(JSON.stringify(next)), entry.revision);
        reset += 1;
        logger.info("Reset poisoned identity record", { userId });
      } catch (err) {
        // CAS conflict means a concurrent write landed between read
        // and update — log and continue; next migration run (or
        // daemon-driven self-correction) will catch it.
        logger.warn("Failed to reset poisoned identity record", { userId, error: String(err) });
      }
    }

    logger.info("USERS userId-as-name cleanup complete", { scanned, reset });
  },
};

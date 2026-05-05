/**
 * Build the `<user_identity>` system-prompt block.
 *
 * Sources from the USERS KV bucket (the persistent, user-scoped record),
 * falling back to `/api/me` for fields the User record doesn't carry.
 * Returns undefined when no identity at all is available.
 *
 * Auto-sync: if USERS has `nameStatus: "unknown"` but `/api/me` returns
 * a name, write the auth-derived name through to USERS and mark
 * onboarding complete. Stops the onboarding clause from firing on
 * users with auth identity but no explicit `set_user_identity` call —
 * the legacy migration only catches memory entries tagged with
 * `metadata.type: "user-name"`, missing organically-stored names.
 */

import { client, parseResult } from "@atlas/client/v2";
import { ONBOARDING_VERSION, UserStorage } from "@atlas/core/users/storage";
import type { Logger } from "@atlas/logger";

export async function fetchUserIdentitySection(
  userId: string,
  logger: Logger,
): Promise<string | undefined> {
  let name: string | undefined;
  let email: string | undefined;
  let userNameStatus: "unknown" | "provided" | "declined" | undefined;
  let userRecordExists = false;

  try {
    const result = await UserStorage.getUser(userId);
    if (result.ok && result.data) {
      name = result.data.identity.name;
      email = result.data.identity.email;
      userNameStatus = result.data.identity.nameStatus;
      userRecordExists = true;
    } else if (!result.ok) {
      logger.warn("UserStorage.getUser failed", { userId, error: result.error });
    }
  } catch (err) {
    logger.warn("fetchUserIdentitySection: UserStorage threw", { userId, error: err });
  }

  let apiMeName: string | undefined;
  let apiMeEmail: string | undefined;
  if (!name || !email) {
    try {
      const apiMe = await parseResult(client.me.index.$get());
      if (apiMe.ok && apiMe.data.user) {
        const u = apiMe.data.user;
        apiMeName = u.display_name ?? u.full_name;
        apiMeEmail = u.email;
        name = name ?? apiMeName;
        email = email ?? apiMeEmail;
      } else if (!apiMe.ok) {
        logger.debug("api/me unavailable", { error: apiMe.error });
      }
    } catch (err) {
      logger.debug("api/me threw", { error: err });
    }
  }

  // Sync /api/me identity into USERS when:
  //   (a) the User record exists with nameStatus=unknown — typical
  //       legacy state where the migration didn't backfill the name;
  //       OR
  //   (b) the User record doesn't exist yet — happens when getUserId
  //       resolves to an auth-derived id (extractTempestUserId from
  //       FRIDAY_KEY) but the USERS bucket only has the offline-
  //       fallback nanoid record. setUserIdentity creates on the
  //       missing-key path, so this also provisions the auth-id record
  //       on first encounter.
  // Idempotent — once nameStatus flips to "provided" the condition
  // short-circuits. Fire-and-forget so prompt assembly doesn't wait
  // on the write.
  const shouldSync = Boolean(apiMeName) && (!userRecordExists || userNameStatus === "unknown");
  if (shouldSync) {
    void (async () => {
      try {
        const set = await UserStorage.setUserIdentity(userId, {
          name: apiMeName,
          email: apiMeEmail,
          nameStatus: "provided",
        });
        if (!set.ok) {
          logger.warn("auto-sync setUserIdentity failed", { userId, error: set.error });
          return;
        }
        const mark = await UserStorage.markOnboardingComplete(userId, ONBOARDING_VERSION);
        if (!mark.ok) {
          logger.warn("auto-sync markOnboardingComplete failed", { userId, error: mark.error });
          return;
        }
        logger.info("auto-sync USERS from /api/me", { userId, name: apiMeName });
      } catch (err) {
        logger.warn("auto-sync USERS threw", { userId, error: err });
      }
    })();
  }

  if (!name && !email) return undefined;

  const lines: string[] = [];
  if (name) lines.push(`Name: ${name}`);
  if (email) lines.push(`Email: ${email}`);
  return `<user_identity>\n${lines.join("\n")}\n</user_identity>`;
}

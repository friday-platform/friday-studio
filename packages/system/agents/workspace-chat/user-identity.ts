/**
 * Build the `<user_identity>` system-prompt block.
 *
 * Sources from the USERS KV bucket (the persistent, user-scoped record),
 * falling back to `/api/me` for fields the User record doesn't carry.
 * Returns undefined when no identity at all is available.
 */

import { client, parseResult } from "@atlas/client/v2";
import { UserStorage } from "@atlas/core/users/storage";
import type { Logger } from "@atlas/logger";

export async function fetchUserIdentitySection(
  userId: string,
  logger: Logger,
): Promise<string | undefined> {
  let name: string | undefined;
  let email: string | undefined;

  // USERS KV is the user-scoped source of truth.
  try {
    const result = await UserStorage.getUser(userId);
    if (result.ok && result.data) {
      name = result.data.identity.name;
      email = result.data.identity.email;
    } else if (!result.ok) {
      logger.warn("UserStorage.getUser failed", { userId, error: result.error });
    }
  } catch (err) {
    logger.warn("fetchUserIdentitySection: UserStorage threw", { userId, error: err });
  }

  // Fall back to /api/me for any auth-derived fields the User record
  // doesn't carry yet (typically email + display_name on first run
  // before the user has explicitly provided them).
  if (!name || !email) {
    try {
      const apiMe = await parseResult(client.me.index.$get());
      if (apiMe.ok && apiMe.data.user) {
        const u = apiMe.data.user;
        name = name ?? u.display_name ?? u.full_name;
        email = email ?? u.email;
      } else if (!apiMe.ok) {
        logger.debug("api/me unavailable", { error: apiMe.error });
      }
    } catch (err) {
      logger.debug("api/me threw", { error: err });
    }
  }

  if (!name && !email) return undefined;

  const lines: string[] = [];
  if (name) lines.push(`Name: ${name}`);
  if (email) lines.push(`Email: ${email}`);
  return `<user_identity>\n${lines.join("\n")}\n</user_identity>`;
}

/**
 * Onboarding gate state derived from the USERS KV bucket.
 *
 * Replaces the legacy memory-based derivation that scanned narrative
 * `notes` entries for `metadata.type === "user-name"` /
 * `"name-declined"`. Identity is now user-scoped (cross-workspace);
 * the source of truth is the `USERS[userId]` record.
 */

import { UserStorage } from "@atlas/core/users/storage";
import type { Logger } from "@atlas/logger";

export type UserProfileState =
  | { status: "known"; name: string }
  | { status: "declined" }
  | { status: "unknown" };

export async function fetchUserProfileState(
  userId: string,
  logger: Logger,
): Promise<UserProfileState> {
  try {
    const result = await UserStorage.getUser(userId);
    if (!result.ok) {
      logger.warn("UserStorage.getUser failed", { userId, error: result.error });
      return { status: "unknown" };
    }
    const user = result.data;
    if (!user) return { status: "unknown" };

    const { nameStatus, name } = user.identity;
    if (nameStatus === "provided" && name) return { status: "known", name };
    if (nameStatus === "declined") return { status: "declined" };
    return { status: "unknown" };
  } catch (err) {
    logger.warn("fetchUserProfileState threw", { userId, error: err });
    return { status: "unknown" };
  }
}

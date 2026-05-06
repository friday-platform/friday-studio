/**
 * Onboarding gate state derived from the USERS KV bucket.
 *
 * Source of truth is `USERS[userId].onboarding.completedAt + version`.
 * The gate only opens when both are present and the version matches the
 * current `ONBOARDING_VERSION` — a version bump re-onboards every user,
 * which is the design intent (declined users re-prompted when the
 * onboarding script meaningfully changes).
 *
 * `identity.name` rides along when known so the prompt assembly can
 * inline it via `<user_identity>` without a second read.
 */

import { ONBOARDING_VERSION, UserStorage } from "@atlas/core/users/storage";
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

    const onboardingDone =
      user.onboarding.completedAt !== undefined && user.onboarding.version >= ONBOARDING_VERSION;
    if (!onboardingDone) return { status: "unknown" };

    const { nameStatus, name } = user.identity;
    if (nameStatus === "provided" && name) return { status: "known", name };
    if (nameStatus === "declined") return { status: "declined" };
    return { status: "unknown" };
  } catch (err) {
    logger.warn("fetchUserProfileState threw", { userId, error: err });
    return { status: "unknown" };
  }
}

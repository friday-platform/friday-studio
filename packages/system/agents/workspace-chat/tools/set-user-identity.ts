import type { AtlasTools } from "@atlas/agent-sdk";
import { ONBOARDING_VERSION, UserStorage } from "@atlas/core/users/storage";
import type { Logger } from "@atlas/logger";
import { tool } from "ai";
import { z } from "zod";

/**
 * `set_user_identity` writes to the USERS KV bucket. Supersedes the
 * legacy pattern where onboarding instructed the model to call
 * `memory_save` with `type: "user-name"` or `"name-declined"`.
 *
 * Identity is user-scoped (cross-workspace), so the write target is
 * the `userId` resolved at request time — not the workspaceId.
 *
 * The tool ALSO marks onboarding complete on success, so the
 * onboarding gate stops firing after the model responds to the first
 * "what should I call you?" question.
 */
const SetUserIdentityInput = z
  .object({
    name: z.string().min(1).optional().describe("User's preferred name"),
    declined: z.boolean().optional().describe("Pass true if the user declined to share their name"),
  })
  .refine((v) => Boolean(v.name) !== Boolean(v.declined), {
    message: "Provide exactly one of {name} or {declined: true}",
  });

export function createSetUserIdentityTool(userId: string, logger: Logger): AtlasTools {
  return {
    set_user_identity: tool({
      description:
        "Save user identity to the persistent USERS store. " +
        "Call this during onboarding once the user tells you their name, or " +
        "when they explicitly decline to share it. Pass either {name: '...'} " +
        "or {declined: true} — exactly one. Marks onboarding complete on " +
        "success so you won't re-ask in future sessions.",
      inputSchema: SetUserIdentityInput,
      execute: async ({ name, declined: _declined }) => {
        try {
          const patch = name
            ? { name, nameStatus: "provided" as const }
            : { nameStatus: "declined" as const, declinedAt: new Date().toISOString() };
          const setResult = await UserStorage.setUserIdentity(userId, patch);
          if (!setResult.ok) {
            logger.error("set_user_identity write failed", { error: setResult.error });
            return { error: "Failed to save user identity" };
          }
          const markResult = await UserStorage.markOnboardingComplete(userId, ONBOARDING_VERSION);
          if (!markResult.ok) {
            logger.error("markOnboardingComplete failed", { error: markResult.error });
            return { error: "Failed to mark onboarding complete" };
          }
          logger.info("set_user_identity succeeded", { userId, nameStatus: patch.nameStatus });
          return { saved: true };
        } catch (err) {
          logger.error("set_user_identity threw", { error: err });
          return { error: "Failed to save user identity" };
        }
      },
    }),
  };
}

import type { UserProfileState } from "./user-profile.ts";

export function buildOnboardingClause(profileState: UserProfileState): string | undefined {
  if (profileState.status !== "unknown") return undefined;

  return `<onboarding>
You are Friday. This is a new user who hasn't introduced themselves yet.

Your first priority in this conversation is to warmly introduce yourself and ask the user what they'd like to be called. For example: "Hey! I'm Friday — what should I call you?"

When the user provides their name:
- Call the memory_save tool with text "User's name is [their name]" and type "user-name"
- Confirm you'll remember it and continue naturally

If the user declines to share their name (e.g. "I'd rather not say", "skip"):
- Call the memory_save tool with text "User declined to share their name" and type "name-declined"
- Respect their choice and continue the conversation naturally

Do NOT re-ask if the user has already responded to this question in this conversation.
</onboarding>`;
}

export function buildUserProfileClause(profileState: UserProfileState): string | undefined {
  if (profileState.status !== "known") return undefined;
  return `<user_profile>The user's name is ${profileState.name}.</user_profile>`;
}

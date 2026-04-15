import type { AtlasTools } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { tool } from "ai";
import { z } from "zod";

export interface OnboardingState {
  needsOnboarding: boolean;
  userName?: string;
  declined: boolean;
}

const NAME_PATTERN = /User's name is (.+)/i;
const DECLINE_PATTERN = /User declined/i;

const NarrativeEntrySchema = z.object({
  id: z.string(),
  text: z.string(),
  author: z.string().optional(),
  createdAt: z.string(),
});

export async function checkOnboardingState(
  workspaceId: string,
  logger: Logger,
): Promise<OnboardingState> {
  const daemonUrl = getAtlasDaemonUrl();
  const url = `${daemonUrl}/api/memory/${encodeURIComponent(workspaceId)}/narrative/user-profile?limit=50`;

  let entries: Array<z.infer<typeof NarrativeEntrySchema>>;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn("Onboarding state check failed — HTTP error", {
        workspaceId,
        status: res.status,
      });
      return { needsOnboarding: false, declined: false };
    }
    const parsed = z.array(NarrativeEntrySchema).safeParse(await res.json());
    if (!parsed.success) {
      logger.warn("Onboarding state check failed — invalid response shape", { workspaceId });
      return { needsOnboarding: false, declined: false };
    }
    entries = parsed.data;
  } catch (err) {
    logger.warn("Onboarding state check failed — fetch error", { workspaceId, error: err });
    return { needsOnboarding: false, declined: false };
  }

  for (const entry of entries) {
    const nameMatch = NAME_PATTERN.exec(entry.text);
    if (nameMatch) {
      return { needsOnboarding: false, userName: nameMatch[1], declined: false };
    }
    if (DECLINE_PATTERN.test(entry.text)) {
      return { needsOnboarding: false, declined: true };
    }
  }

  return { needsOnboarding: true, declined: false };
}

export function buildOnboardingClause(): string {
  return `<onboarding>
You are Friday. This is a new user who hasn't introduced themselves yet.

Your first priority in this conversation is to warmly introduce yourself and ask the user what they'd like to be called. For example: "Hey! I'm Friday — what should I call you?"

When the user provides their name:
- Call the memory_save tool with the text "User's name is [their name]"
- Confirm you'll remember it and continue naturally

If the user declines to share their name (e.g. "I'd rather not say", "skip"):
- Call the memory_save tool with the text "User declined to share their name"
- Respect their choice and continue the conversation naturally

Do NOT re-ask if the user has already responded to this question in this conversation.
</onboarding>`;
}

export function createMemorySaveTool(primaryWorkspaceId: string, logger: Logger): AtlasTools {
  return {
    memory_save: tool({
      description:
        "Save a note to the user's profile memory. Use this to remember the user's name or preferences.",
      inputSchema: z.object({
        text: z.string().describe("The text to save to user profile memory"),
      }),
      execute: async ({ text }): Promise<{ saved: boolean; text: string } | { error: string }> => {
        const daemonUrl = getAtlasDaemonUrl();
        const url = `${daemonUrl}/api/memory/${encodeURIComponent(primaryWorkspaceId)}/narrative/user-profile`;

        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: crypto.randomUUID(),
              text,
              createdAt: new Date().toISOString(),
            }),
          });

          if (!res.ok) {
            const body = await res.text();
            logger.error("memory_save failed — daemon returned non-200", {
              workspaceId: primaryWorkspaceId,
              status: res.status,
              body,
            });
            return { error: `Failed to save: HTTP ${res.status}` };
          }

          logger.info("memory_save succeeded", { workspaceId: primaryWorkspaceId, text });
          return { saved: true, text };
        } catch (err) {
          logger.error("memory_save failed — fetch error", {
            workspaceId: primaryWorkspaceId,
            error: err,
          });
          return { error: "Failed to save: network error" };
        }
      },
    }),
  };
}

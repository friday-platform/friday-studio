import type { AtlasTools } from "@atlas/agent-sdk";
import { USER_PROFILE_CORPUS } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { tool } from "ai";
import { z } from "zod";

export const MemorySaveInput = z.object({
  text: z.string().describe("The text to save to user profile memory"),
  type: z
    .enum(["user-name", "name-declined", "general"])
    .optional()
    .describe("Entry type for structured classification"),
});

export function createMemorySaveTool(workspaceId: string, logger: Logger): AtlasTools {
  return {
    memory_save: tool({
      description:
        "Save a note to the user's profile memory. Use this to remember the user's name or preferences.",
      inputSchema: MemorySaveInput,
      execute: async ({
        text,
        type,
      }): Promise<{ saved: boolean; text: string } | { error: string }> => {
        const daemonUrl = getAtlasDaemonUrl();
        const url = `${daemonUrl}/api/memory/${encodeURIComponent(workspaceId)}/narrative/${USER_PROFILE_CORPUS}`;

        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: crypto.randomUUID(),
              text,
              createdAt: new Date().toISOString(),
              metadata: type ? { type } : undefined,
            }),
          });

          if (!res.ok) {
            const body = await res.text();
            logger.error("memory_save failed", { workspaceId, status: res.status, body });
            return { error: `Failed to save: HTTP ${res.status}` };
          }

          logger.info("memory_save succeeded", { workspaceId, text, type });
          return { saved: true, text };
        } catch (err) {
          logger.error("memory_save fetch error", { workspaceId, error: err });
          return { error: "Failed to save: network error" };
        }
      },
    }),
  };
}

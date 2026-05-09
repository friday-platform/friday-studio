import type { AtlasTools } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { tool } from "ai";
import { z } from "zod";

const MemorySaveInput = z.object({
  memoryName: z
    .string()
    .describe(
      "Memory store name — pick the store from <memory_stores> in the workspace context that best fits the content",
    ),
  text: z.string().min(1),
  id: z.string().optional().describe("UUID; auto-generated if omitted"),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const MemoryRemoveInput = z.object({
  memoryName: z.string(),
  entryId: z.string().describe("The id field of the entry to remove"),
});

export function createMemorySaveTool(workspaceId: string, logger: Logger): AtlasTools {
  const daemonUrl = getAtlasDaemonUrl();

  return {
    memory_save: tool({
      description:
        "Save an entry to a named memory store in this workspace. " + "Persists across sessions.",
      inputSchema: MemorySaveInput,
      execute: async ({ memoryName, text, id, metadata }) => {
        const url = `${daemonUrl}/api/memory/${encodeURIComponent(workspaceId)}/narrative/${encodeURIComponent(memoryName)}`;
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: id ?? crypto.randomUUID(),
              text,
              createdAt: new Date().toISOString(),
              metadata,
            }),
          });
          if (!res.ok) {
            const body = await res.text();
            logger.error("memory_save failed", {
              workspaceId,
              memoryName,
              status: res.status,
              body,
            });
            return { error: `Failed to save: HTTP ${res.status}` };
          }
          logger.info("memory_save succeeded", { workspaceId, memoryName });
          return { saved: true };
        } catch (err) {
          logger.error("memory_save fetch error", { workspaceId, memoryName, error: err });
          return { error: "Failed to save: network error" };
        }
      },
    }),

    memory_remove: tool({
      description: "Remove a single entry from a named memory in this workspace by its id.",
      inputSchema: MemoryRemoveInput,
      execute: async ({ memoryName, entryId }) => {
        const url = `${daemonUrl}/api/memory/${encodeURIComponent(workspaceId)}/narrative/${encodeURIComponent(memoryName)}/${encodeURIComponent(entryId)}`;
        try {
          const res = await fetch(url, { method: "DELETE" });
          if (!res.ok) return { error: `Failed to remove: HTTP ${res.status}` };
          logger.info("memory_remove succeeded", { workspaceId, memoryName, entryId });
          return { removed: true };
        } catch (err) {
          logger.error("memory_remove fetch error", {
            workspaceId,
            memoryName,
            entryId,
            error: err,
          });
          return { error: "Failed to remove: network error" };
        }
      },
    }),
  };
}
